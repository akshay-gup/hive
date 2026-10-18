import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createControlApp } from "../apps/control/src/app.ts";
import type { ControlConfig } from "../apps/control/src/config.ts";
import { type GatewaySettings, gatewayFromEnv, ModelGateway } from "../apps/control/src/gateway.ts";
import { RateLimiter } from "../apps/control/src/limits.ts";
import { loadSigningKeys, type SigningKeys } from "../apps/control/src/signing.ts";
import { workspaceSettings } from "../apps/control/src/workspace-env.ts";
import { type ControlTestStore, createControlStore } from "./helpers/control-store.ts";
import { FakeProvisioner } from "./helpers/fake-provisioner.ts";

const PUBLIC_URL = "https://hive.example.test";
const REAL_KEY = "sk-ant-real-key-that-must-stay-here";
const OPENAI_KEY = "sk-openai-real-key-that-must-stay-here";

let db: ControlTestStore;
let directory: string;
let keys: SigningKeys;
let provisioner: FakeProvisioner;

interface Call {
  url: string;
  init: RequestInit & { duplex?: string };
}
let calls: Call[] = [];
/** What the provider answers with; each test sets its own. */
let upstream: (call: Call) => Response | Promise<Response> = () => new Response("{}");
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const call = { url: String(input), init: (init ?? {}) as Call["init"] };
  calls.push(call);
  return upstream(call);
}) as typeof fetch;

const config = (): ControlConfig => ({
  mode: "sample",
  port: 8800,
  host: "127.0.0.1",
  publicUrl: PUBLIC_URL,
  dataDir: directory,
  allowedOrigins: [],
  maxWorkspacesPerAccount: 3,
  clientIpHeader: "x-client-ip",
  googleRedirectUri: `${PUBLIC_URL}/v1/auth/google/callback`,
});
const settings = (over: Partial<GatewaySettings> = {}): GatewaySettings => ({
  providers: {
    anthropic: { baseUrl: "https://api.anthropic.test/v1", key: REAL_KEY, auth: "x-api-key" },
    openai: { baseUrl: "https://api.openai.test/v1", key: OPENAI_KEY, auth: "bearer" },
  },
  model: "anthropic/claude-test",
  fetch: fakeFetch,
  presenceMs: 0,
  ...over,
});
const makeControl = (gateway?: GatewaySettings) =>
  createControlApp(db, config(), { provisioner, keys, gateway });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-gateway-"));
  db = await createControlStore();
  keys = await loadSigningKeys(directory, {});
  provisioner = new FakeProvisioner();
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

let emails = 0;
/** A signed-in person, a ready workspace of theirs, and the key that workspace was given. */
async function workspaceWith(control: ReturnType<typeof makeControl>) {
  const email = `gateway${++emails}@example.com`;
  const signed = await control.app.request("/v1/auth/dev", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Ip": email },
    body: JSON.stringify({ email }),
  });
  const { token: session } = await signed.json();
  const auth = { Authorization: `Bearer ${session}`, "Content-Type": "application/json" };
  const made = await control.app.request("/v1/workspaces", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "Gate" }),
  });
  assert.equal(made.status, 201);
  const { id } = await made.json();
  await control.workspaces.settled(id);
  const spec = provisioner.created.filter((s) => s.workspaceId === id).at(-1);
  const given = JSON.parse(spec?.modelEnv?.OPENCODE_CONFIG_CONTENT ?? "{}");
  const key = given.provider?.anthropic?.options?.apiKey as string;
  return {
    id,
    key,
    spec,
    remove: () => control.app.request(`/v1/workspaces/${id}`, { method: "DELETE", headers: auth }),
  };
}
const ask = (
  control: ReturnType<typeof makeControl>,
  path: string,
  key: string | undefined,
  init: RequestInit = {},
  header = "x-api-key",
) =>
  control.app.request(`/v1/gateway/${path}`, {
    method: "POST",
    ...init,
    headers: {
      "content-type": "application/json",
      ...(key ? { [header]: header === "authorization" ? `Bearer ${key}` : key } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });

test("a new workspace is given the model and a key for the gateway, and never the provider's key", async () => {
  const control = makeControl(settings());
  const { spec, key, id } = await workspaceWith(control);
  assert.equal(spec?.modelEnv?.MODEL, "anthropic/claude-test");
  const given = JSON.parse(spec?.modelEnv?.OPENCODE_CONFIG_CONTENT ?? "{}");
  assert.equal(given.provider.anthropic.options.baseURL, `${PUBLIC_URL}/v1/gateway/anthropic`);
  assert.equal(given.provider.openai.options.baseURL, `${PUBLIC_URL}/v1/gateway/openai`);
  assert.match(key, new RegExp(`^hwk_${id}\\.`));
  const everything = JSON.stringify(spec);
  assert.ok(!everything.includes(REAL_KEY) && !everything.includes(OPENAI_KEY));
  // The same workspace is always given the same key, so making it again after a failure agrees with
  // itself, and a control plane with another signing key makes another.
  const sameKey = new ModelGateway(db, PUBLIC_URL, keys.privateKey, settings(), new RateLimiter(1));
  assert.equal(sameKey.tokenFor(id), key);
  assert.equal(sameKey.workspaceOf(key), id);
  assert.notEqual(
    new ModelGateway(db, PUBLIC_URL, "another", settings(), new RateLimiter(1)).tokenFor(id),
    key,
  );
  // What the machine is told: the gateway's model wins over a shared one, and Hive's own settings win over both.
  const machine = workspaceSettings(
    { ...(spec as NonNullable<typeof spec>), modelEnv: { MODEL: "a/b", WORKSPACE_ID: "other" } },
    "https://ws.test",
    { MODEL: "shared/one", OPENAI_API_KEY: "x" },
  );
  assert.equal(machine.MODEL, "a/b");
  assert.equal(machine.WORKSPACE_ID, id);
  assert.equal(machine.OPENAI_API_KEY, "x");
});

test("a model the agent does not know yet is described to it, for that model only", async () => {
  const info = { name: "Newest", tool_call: true, interleaved: { field: "reasoning_content" } };
  const control = makeControl(
    settings({
      model: "openai/vendor/new-model-1017",
      modelConfig: info,
    }),
  );
  const { spec } = await workspaceWith(control);
  const given = JSON.parse(spec?.modelEnv?.OPENCODE_CONFIG_CONTENT ?? "{}");
  assert.equal(spec?.modelEnv?.MODEL, "openai/vendor/new-model-1017");
  // The model id is everything after the provider, slashes included.
  assert.deepEqual(given.provider.openai.models, { "vendor/new-model-1017": info });
  assert.equal(given.provider.anthropic.models, undefined);
  assert.equal(given.provider.openai.options.baseURL, `${PUBLIC_URL}/v1/gateway/openai`);
  // Not described, nothing is added.
  const plain = await workspaceWith(makeControl(settings()));
  assert.equal(
    JSON.parse(plain.spec?.modelEnv?.OPENCODE_CONFIG_CONTENT ?? "{}").provider.anthropic.models,
    undefined,
  );
});

test("without a gateway a workspace is given no model settings and the route is not there", async () => {
  const control = makeControl(undefined);
  const { spec, key } = await workspaceWith(control);
  assert.equal(spec?.modelEnv, undefined);
  calls = [];
  const response = await ask(control, "anthropic/messages", key ?? "hwk_x.y");
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("the provider gets its own key and the body untouched, and nothing else of the caller", async () => {
  const control = makeControl(settings());
  const { key } = await workspaceWith(control);
  calls = [];
  upstream = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "request-id": "req_123",
        "set-cookie": "tracker=1",
        "retry-after": "3",
      },
    });
  const body = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
  const response = await ask(control, "anthropic/messages?beta=true", key, {
    body,
    headers: {
      "anthropic-version": "2023-06-01",
      cookie: "session=abc",
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "203.0.113.9",
      "accept-encoding": "gzip, br",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("request-id"), "req_123");
  assert.equal(response.headers.get("retry-after"), "3");
  assert.equal(response.headers.get("set-cookie"), null);

  assert.equal(calls.length, 1);
  const [call] = calls as [Call];
  assert.equal(call.url, "https://api.anthropic.test/v1/messages?beta=true");
  assert.equal(call.init.method, "POST");
  const sent = new Headers(call.init.headers);
  assert.equal(sent.get("x-api-key"), REAL_KEY);
  assert.equal(sent.get("anthropic-version"), "2023-06-01");
  assert.equal(sent.get("content-type"), "application/json");
  assert.equal(sent.get("accept-encoding"), "identity");
  for (const left of ["cookie", "cf-connecting-ip", "x-forwarded-for", "authorization"])
    assert.equal(sent.get(left), null, `${left} stays here`);
  const sentValues: string[] = [];
  sent.forEach((value) => void sentValues.push(value));
  assert.ok(!sentValues.join("\n").includes(key), "the workspace's key does not go on");
  // The body goes on as the stream it came as, and arrives byte for byte.
  assert.ok(call.init.body instanceof ReadableStream, "the body is passed on, not read");
  const received = new Uint8Array(await new Response(call.init.body as BodyInit).arrayBuffer());
  assert.deepEqual(received, body);
});

test("an answer is passed back as it arrives, not when it is done", async () => {
  const control = makeControl(settings());
  const { key } = await workspaceWith(control);
  let send: (text: string) => void = () => {};
  let finish: () => void = () => {};
  upstream = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          send = (text) => controller.enqueue(encoder.encode(text));
          finish = () => controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const response = await ask(control, "anthropic/messages", key, { body: "{}" });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  send("event: one\n\n");
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), "event: one\n\n");
  send("event: two\n\n");
  const second = await reader.read();
  assert.equal(new TextDecoder().decode(second.value), "event: two\n\n");
  finish();
  assert.equal((await reader.read()).done, true);
});

test("a provider that takes a bearer key gets it that way, and a workspace may send its key that way too", async () => {
  const control = makeControl(settings());
  const { key } = await workspaceWith(control);
  calls = [];
  upstream = () => new Response("{}");
  const response = await ask(
    control,
    "openai/chat/completions",
    key,
    { body: "{}" },
    "authorization",
  );
  assert.equal(response.status, 200);
  const sent = new Headers(calls[0]?.init.headers);
  assert.equal(sent.get("authorization"), `Bearer ${OPENAI_KEY}`);
  assert.equal(sent.get("x-api-key"), null);
  assert.equal(calls[0]?.url, "https://api.openai.test/v1/chat/completions");
});

test("what the provider answers is what the workspace sees, errors included", async () => {
  const control = makeControl(settings());
  const { key } = await workspaceWith(control);
  upstream = () =>
    new Response('{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}', {
      status: 429,
      headers: { "retry-after": "17", "content-type": "application/json" },
    });
  const limited = await ask(control, "anthropic/messages", key, { body: "{}" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "17");
  assert.equal((await limited.json()).error.message, "slow");

  upstream = () => {
    throw new Error("connection refused");
  };
  const down = await ask(control, "anthropic/messages", key, { body: "{}" });
  assert.equal(down.status, 502);
  assert.match((await down.json()).error.message, /could not be reached/);
});

test("a key that was not made here gets nowhere, and the provider is never asked", async () => {
  const control = makeControl(settings());
  const { key, id } = await workspaceWith(control);
  calls = [];
  const wrongEnding = `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`;
  const wrongWorkspace = key.replace(id, "wzzzzzzzzzz");
  const withoutKey = await ask(control, "anthropic/messages", undefined, { body: "{}" });
  assert.equal(withoutKey.status, 401);
  for (const bad of [wrongEnding, wrongWorkspace, "hwk_", "sk-ant-guess", REAL_KEY, `${key}x`])
    assert.equal((await ask(control, "anthropic/messages", bad, { body: "{}" })).status, 401, bad);
  // Another control plane's key for the same workspace id is no good here either.
  const other = await loadSigningKeys(await mkdtemp(join(tmpdir(), "hive-other-")), {});
  const foreign = createControlApp(db, config(), { provisioner, keys: other, gateway: settings() });
  const stranger = await workspaceWith(foreign);
  assert.equal(
    (await ask(control, "anthropic/messages", stranger.key, { body: "{}" })).status,
    401,
  );
  assert.equal(calls.length, 0);
});

test("only the providers that are set up, only by GET and POST, and no way out of the provider's address", async () => {
  const control = makeControl(settings());
  const { key } = await workspaceWith(control);
  calls = [];
  assert.equal((await ask(control, "nobody/messages", key, { body: "{}" })).status, 404);
  const put = await control.app.request("/v1/gateway/anthropic/messages", {
    method: "PUT",
    headers: { "x-api-key": key },
  });
  assert.equal(put.status, 405);
  // An encoded slash or backslash could hide a way out of the provider's path: refused.
  for (const path of ["anthropic/a%2fb", "anthropic/a%5cb", "anthropic/a%2Fb"])
    assert.equal((await ask(control, path, key, { body: "{}" })).status, 400, path);
  assert.equal(calls.length, 0);
  // Dot segments, encoded or not, are already resolved by the time a request is read: they land on
  // another name (a provider that is not there) or stay under the provider's own address.
  upstream = () => new Response("{}");
  assert.equal((await ask(control, "anthropic/%2e%2e/admin", key, { body: "{}" })).status, 404);
  await ask(control, "anthropic/a/%2E%2E/b", key, { body: "{}" });
  await ask(control, "anthropic/%2e/x", key, { body: "{}" });
  for (const call of calls)
    assert.ok(call.url.startsWith("https://api.anthropic.test/v1/"), call.url);
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://api.anthropic.test/v1/b", "https://api.anthropic.test/v1/x"],
  );
});

test("a workspace that has been deleted can no longer use the model", async () => {
  const control = makeControl(settings());
  const gone = await workspaceWith(control);
  upstream = () => new Response("{}");
  assert.equal((await ask(control, "anthropic/messages", gone.key, { body: "{}" })).status, 200);
  assert.equal((await gone.remove()).status, 200);
  await control.workspaces.settled(gone.id);
  calls = [];
  const refused = await ask(control, "anthropic/messages", gone.key, { body: "{}" });
  assert.equal(refused.status, 403);
  assert.equal(calls.length, 0);
});

test("a workspace is believed to be there for a while, so the records are not asked every request", async () => {
  const control = makeControl(settings({ presenceMs: 60_000 }));
  const workspace = await workspaceWith(control);
  upstream = () => new Response("{}");
  assert.equal(
    (await ask(control, "anthropic/messages", workspace.key, { body: "{}" })).status,
    200,
  );
  let asked = 0;
  const get = db.get.bind(db);
  db.get = ((...args: Parameters<typeof get>) => {
    asked++;
    return get(...args);
  }) as typeof db.get;
  try {
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await ask(control, "anthropic/messages", workspace.key, { body: "{}" })).status,
        200,
      );
  } finally {
    db.get = get;
  }
  assert.equal(asked, 0);
});

test("one busy workspace is slowed down without slowing the others", async () => {
  const control = makeControl(settings({ limiter: new RateLimiter(2) }));
  const busy = await workspaceWith(control);
  const calm = await workspaceWith(control);
  upstream = () => new Response("{}");
  const statuses = [];
  for (let i = 0; i < 4; i++)
    statuses.push((await ask(control, "anthropic/messages", busy.key, { body: "{}" })).status);
  assert.deepEqual(statuses, [200, 200, 429, 429]);
  const slow = await ask(control, "anthropic/messages", busy.key, { body: "{}" });
  assert.equal(slow.headers.get("retry-after"), "10");
  assert.equal((await ask(control, "anthropic/messages", calm.key, { body: "{}" })).status, 200);
});

test("when the workspace stops waiting, so does the request to the provider", async () => {
  const control = makeControl(settings());
  const { key } = await workspaceWith(control);
  calls = [];
  upstream = (call) =>
    new Promise<Response>((_, reject) => {
      call.init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const stop = new AbortController();
  const pending = ask(control, "anthropic/messages", key, { body: "{}", signal: stop.signal });
  while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls[0]?.init.signal?.aborted, false);
  stop.abort();
  await Promise.resolve(pending).catch(() => {});
  assert.equal(calls[0]?.init.signal?.aborted, true);
});

test("nothing about a request is logged: not what was said, not what came back, not a key", async () => {
  const control = makeControl(settings());
  const { key } = await workspaceWith(control);
  const lines: string[] = [];
  const saved = { ...console };
  for (const name of ["log", "info", "warn", "error", "debug"] as const)
    console[name] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    upstream = () => new Response('{"text":"ANSWER-MARKER"}');
    await ask(control, "anthropic/messages", key, { body: '{"prompt":"PROMPT-MARKER"}' });
    upstream = () => {
      throw new Error("down");
    };
    await ask(control, "anthropic/messages", key, { body: '{"prompt":"PROMPT-MARKER"}' });
    await ask(control, "anthropic/messages", "hwk_bad.key", { body: "{}" });
  } finally {
    Object.assign(console, saved);
  }
  const printed = lines.join("\n");
  for (const secret of ["PROMPT-MARKER", "ANSWER-MARKER", key, REAL_KEY])
    assert.ok(!printed.includes(secret), `${secret} was logged`);
});

test("the settings that turn the gateway on are checked", () => {
  const ok = {
    GATEWAY_PROVIDERS: JSON.stringify({
      anthropic: { baseUrl: "https://api.anthropic.com/v1/", key: "k" },
      openai: { baseUrl: "https://api.openai.com/v1", key: "k" },
    }),
    GATEWAY_MODEL: "anthropic/claude-sonnet-4-5",
  };
  assert.equal(gatewayFromEnv({}), undefined);
  const parsed = gatewayFromEnv(ok);
  assert.equal(parsed?.providers.anthropic?.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(parsed?.providers.anthropic?.auth, "x-api-key");
  assert.equal(parsed?.providers.openai?.auth, "bearer");
  assert.equal(parsed?.model, "anthropic/claude-sonnet-4-5");
  const refused = (over: Record<string, string>, text: RegExp) =>
    assert.throws(() => gatewayFromEnv({ ...ok, ...over }), text);
  assert.deepEqual(
    gatewayFromEnv({ ...ok, GATEWAY_MODEL_CONFIG: '{"name":"X","tool_call":true}' })?.modelConfig,
    { name: "X", tool_call: true },
  );
  assert.equal(parsed?.modelConfig, undefined);
  refused({ GATEWAY_MODEL_CONFIG: "[]" }, /GATEWAY_MODEL_CONFIG/);
  refused({ GATEWAY_MODEL_CONFIG: "nope" }, /GATEWAY_MODEL_CONFIG/);
  refused({ GATEWAY_MODEL: "" }, /both/);
  assert.throws(() => gatewayFromEnv({ GATEWAY_MODEL: "a/b" }), /both/);
  refused({ GATEWAY_MODEL: "mistral/large" }, /GATEWAY_MODEL/);
  refused({ GATEWAY_MODEL: "anthropic" }, /GATEWAY_MODEL/);
  refused({ GATEWAY_PROVIDERS: "[]" }, /JSON object/);
  refused({ GATEWAY_PROVIDERS: "nope" }, /JSON object/);
  refused({ GATEWAY_PROVIDERS: '{"anthropic":{"baseUrl":"http://x.test","key":"k"}}' }, /https/);
  refused({ GATEWAY_PROVIDERS: '{"anthropic":{"baseUrl":"https://x.test"}}' }, /key/);
  refused({ GATEWAY_PROVIDERS: '{"Bad Name":{"baseUrl":"https://x.test","key":"k"}}' }, /name/);
  refused(
    { GATEWAY_PROVIDERS: '{"anthropic":{"baseUrl":"https://x.test","key":"k","auth":"cookie"}}' },
    /auth/,
  );
});
