import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { createControlApp } from "../apps/control/src/app.ts";
import type { ControlConfig } from "../apps/control/src/config.ts";
import { GoogleSignIn } from "../apps/control/src/google.ts";
import { loadSigningKeys } from "../apps/control/src/signing.ts";
import { type ControlTestStore, createControlStore } from "./helpers/control-store.ts";
import { fakeGoogle } from "./helpers/fake-google.ts";
import { FakeProvisioner } from "./helpers/fake-provisioner.ts";

const APP = "https://hive.example.test";
let db: ControlTestStore;
let directory: string;
let google: Awaited<ReturnType<typeof fakeGoogle>>;
let control: ReturnType<typeof createControlApp>;

const config: ControlConfig = {
  mode: "live",
  port: 8800,
  host: "0.0.0.0",
  publicUrl: APP,
  dataDir: "",
  allowedOrigins: ["https://other.example.test"],
  maxWorkspacesPerAccount: 3,
  clientIpHeader: "x-client-ip",
  googleClientId: "client-id.apps.test",
  googleClientSecret: "client-secret",
  googleRedirectUri: `${APP}/v1/auth/google/callback`,
};
const signInWith = (over: Partial<ConstructorParameters<typeof GoogleSignIn>[1]> = {}) =>
  new GoogleSignIn(db, {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    redirectUri: config.googleRedirectUri,
    authUrl: google.authUrl,
    tokenUrl: google.tokenUrl,
    userinfoUrl: google.userinfoUrl,
    ...over,
  });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-control-google-"));
  db = await createControlStore();
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  google = await fakeGoogle();
  control = createControlApp(db, config, {
    provisioner: new FakeProvisioner(),
    keys: await loadSigningKeys(directory, {}),
    google: signInWith(),
  });
});
afterEach(async () => {
  await google.close();
});

const get = (path: string, visitor = "visitor-1") =>
  control.app.request(path, { headers: { "X-Client-Ip": visitor } });
/** What the page Hive answers a return from Google with hands to the app that asked. */
function handedOver(html: string) {
  const found = /var code=("(?:[^"\\]|\\.)*"),target=(null|"(?:[^"\\]|\\.)*")/.exec(html);
  assert.ok(found, "the page carries a login code");
  return { code: JSON.parse(found[1] as string) as string, target: JSON.parse(found[2] as string) };
}

test("the sign-in URL sends the person to Google with a one-time state and a PKCE challenge", async () => {
  const { url } = await signInWith().loginUrl(APP);
  const sent = new URL(url);
  assert.equal(`${sent.origin}${sent.pathname}`, google.authUrl);
  assert.equal(sent.searchParams.get("client_id"), google.clientId);
  assert.equal(sent.searchParams.get("redirect_uri"), config.googleRedirectUri);
  assert.equal(sent.searchParams.get("response_type"), "code");
  // Who they are, and nothing of their mail or calendar.
  assert.equal(sent.searchParams.get("scope"), "openid email profile");
  assert.equal(sent.searchParams.get("code_challenge_method"), "S256");
  assert.ok((sent.searchParams.get("code_challenge") ?? "").length >= 43);
  assert.ok((sent.searchParams.get("state") ?? "").length >= 40);
  // Two sign-ins never share a state.
  const other = new URL((await signInWith().loginUrl()).url);
  assert.notEqual(other.searchParams.get("state"), sent.searchParams.get("state"));
});

test("coming back from Google gives who the person is, once", async () => {
  const signIn = signInWith();
  const { url } = await signIn.loginUrl(APP);
  const { code, state } = google.issue(url, {
    sub: "g-42",
    email: "Ada@Example.com",
    email_verified: true,
    name: "Ada Lovelace",
  });
  assert.deepEqual(await signIn.loginCallback(state, code), {
    sub: "g-42",
    email: "Ada@Example.com",
    name: "Ada Lovelace",
    origin: APP,
  });
  // It proved itself with the secret and the verifier, over the redirect it started with.
  const exchange = google.calls.find((c) => c.path === "/token")?.form;
  assert.equal(exchange?.client_secret, google.clientSecret);
  assert.equal(exchange?.redirect_uri, config.googleRedirectUri);
  assert.ok((exchange?.code_verifier ?? "").length >= 43);
  assert.match(google.calls.find((c) => c.path === "/userinfo")?.authorization ?? "", /^Bearer /);

  // The same return cannot be replayed: the state is spent.
  await assert.rejects(signIn.loginCallback(state, code), /expired/);
});

test("a return nobody started is refused without asking Google anything", async () => {
  await assert.rejects(signInWith().loginCallback("made-up", "code"), /expired/);
  assert.equal(google.calls.length, 0);
});

test("a state that ran out is refused", async () => {
  const signIn = signInWith();
  const { url } = await signIn.loginUrl();
  const state = new URL(url).searchParams.get("state") ?? "";
  const pending = await db.get<{ id: string; expiresAt: number }>("control", "oauth", state);
  assert.ok(pending);
  await db.put("control", "oauth", { ...pending, expiresAt: Date.now() - 1 });
  await assert.rejects(signIn.loginCallback(state, "code"), /expired/);
  assert.equal(google.calls.length, 0);
});

test("an email address Google has not verified is not signed in", async () => {
  const signIn = signInWith();
  for (const email_verified of [false, undefined]) {
    const { url } = await signIn.loginUrl();
    const { code, state } = google.issue(url, {
      sub: "g-9",
      email: "x@example.com",
      email_verified,
    });
    await assert.rejects(signIn.loginCallback(state, code), (error: unknown) => {
      assert.equal((error as { status?: number }).status, 403);
      assert.match((error as Error).message, /not verified/);
      return true;
    });
  }
});

test("when Google turns down the code, the person is told to try again and nothing leaks", async () => {
  const signIn = signInWith();
  const { url } = await signIn.loginUrl();
  const state = new URL(url).searchParams.get("state") ?? "";
  await assert.rejects(
    signIn.loginCallback(state, "a-code-google-never-issued"),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 502);
      assert.doesNotMatch((error as Error).message, /invalid_grant|client-secret/);
      return true;
    },
  );

  google.fail("/userinfo", 500);
  const second = await signIn.loginUrl();
  const issued = google.issue(second.url);
  await assert.rejects(signIn.loginCallback(issued.state, issued.code), /try again/i);
});

test("Google being unreachable is a message, not a crash", async () => {
  const signIn = signInWith({ tokenUrl: "http://127.0.0.1:9/token" });
  const { url } = await signIn.loginUrl();
  const issued = google.issue(url);
  await assert.rejects(signIn.loginCallback(issued.state, issued.code), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 502);
    assert.match((error as Error).message, /Could not reach Google/);
    return true;
  });
});

test("signing in with Google: the page hands the app a code, and the code is a session once", async () => {
  const started = await (await get(`/v1/auth/google/url?origin=${encodeURIComponent(APP)}`)).json();
  const { code, state } = google.issue(started.url, {
    sub: "g-7",
    email: "grace@example.com",
    email_verified: true,
    name: "Grace Hopper",
  });
  const back = await get(`/v1/auth/google/callback?state=${state}&code=${code}`);
  assert.equal(back.status, 200);
  const html = await back.text();
  const handed = handedOver(html);
  // A web app that opened this page is the only one it talks to; the session is not in the page.
  assert.equal(handed.target, APP);
  assert.doesNotMatch(html, /"token"|Bearer/);

  const exchanged = await control.app.request("/v1/auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: handed.code }),
  });
  assert.equal(exchanged.status, 200);
  const session = await exchanged.json();
  assert.equal(session.account.email, "grace@example.com");
  assert.equal(session.account.name, "Grace Hopper");

  const me = await control.app.request("/v1/me", {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  assert.equal((await me.json()).account.email, "grace@example.com");

  const again = await control.app.request("/v1/auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: handed.code }),
  });
  assert.equal(again.status, 400);
});

test("a native app asks without an origin and is sent back by its own link", async () => {
  const started = await (await get("/v1/auth/google/url")).json();
  const { code, state } = google.issue(started.url);
  const html = await (await get(`/v1/auth/google/callback?state=${state}&code=${code}`)).text();
  assert.equal(handedOver(html).target, null);
  assert.match(html, /hive:\/\/auth\?code=/);
});

test("only a page of Hive's own can be handed the sign-in", async () => {
  const kept = async () => (await db.list("control", "oauth")).length;
  const before = await kept();
  for (const origin of ["https://evil.test", "http://hive.example.test", `${APP}.evil.test`]) {
    const refused = await get(`/v1/auth/google/url?origin=${encodeURIComponent(origin)}`);
    assert.equal(refused.status, 403, origin);
  }
  // Nothing was kept for the ones turned away.
  assert.equal(await kept(), before);
  assert.equal(
    (await get("/v1/auth/google/url?origin=https%3A%2F%2Fother.example.test")).status,
    200,
  );
  assert.equal(await kept(), before + 1);
});

test("a person who turns Google down is told so, and a half return is refused", async () => {
  assert.equal((await get("/v1/auth/google/callback?error=access_denied")).status, 400);
  assert.equal((await get("/v1/auth/google/callback?state=only")).status, 400);
});

test("health says whether people can sign in with Google, for the app to offer it", async () => {
  assert.equal((await (await get("/health")).json()).google, true);
  const bare = createControlApp(db, config, {
    provisioner: new FakeProvisioner(),
    keys: await loadSigningKeys(directory, {}),
  });
  assert.equal((await (await bare.app.request("/health")).json()).google, false);
});

test("without Google set up there is no Google sign-in", async () => {
  const bare = createControlApp(db, config, {
    provisioner: new FakeProvisioner(),
    keys: await loadSigningKeys(directory, {}),
  });
  assert.equal((await bare.app.request("/v1/auth/google/url")).status, 503);
  assert.equal((await bare.app.request("/v1/auth/google/callback?state=a&code=b")).status, 503);
});
