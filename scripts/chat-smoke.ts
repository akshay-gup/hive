/**
 * Tries the chat Worker on Cloudflare, where what Node cannot show happens: a Durable Object that
 * sleeps and wakes with people still connected, real WebSockets, and the control plane's signed
 * calls. It makes its own workspace, uses it, and clears it out.
 *
 *   CHAT_URL=https://hive-chat-staging.<you>.workers.dev CHAT_KEYS=/path/keys.json \
 *     pnpm exec tsx scripts/chat-smoke.ts
 *
 * `keys.json` is `{publicKey, privateKey}` for the key the Worker was deployed to trust (a pair made
 * for the test, never the real control plane's).
 */
import { readFileSync } from "node:fs";
import {
  signChatPeople,
  signChatPurge,
  signChatRevocation,
  signChatToken,
  type WorkspaceRole,
} from "../packages/integrations/src/workspace-token.ts";

const base = (process.env.CHAT_URL ?? "").replace(/\/+$/, "");
const keysPath = process.env.CHAT_KEYS ?? "";
if (!base || !keysPath) throw new Error("Set CHAT_URL and CHAT_KEYS (see the top of this file)");
const keys = JSON.parse(readFileSync(keysPath, "utf8")) as { privateKey: string };
const ws = `smoke${Date.now().toString(36)}`;

const people = {
  max: { sub: "acct_max", email: "max@example.com", name: "Max", role: "member" as WorkspaceRole },
  mia: { sub: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" as WorkspaceRole },
};
type Who = keyof typeof people;
const token = (who: Who, now?: number) =>
  signChatToken(keys.privateKey, { ...people[who], workspaceId: ws, now });

let failures = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
  console.log(
    `${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(who: Who, method: string, path: string, body?: unknown, bearer = token(who)) {
  const response = await fetch(`${base}/w/${ws}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json: json as any };
}

async function internal(action: string, bearer: string, body?: unknown) {
  const response = await fetch(`${base}/w/${ws}/internal/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.status;
}

/** A live connection that remembers what it was sent. */
function connect(who: Who, bearer = token(who)) {
  const frames: any[] = [];
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/w/${ws}/v1/ws`, ["hive.v1", bearer]);
  const opened = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("could not connect"));
  });
  socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  const waitFor = async (match: (frame: any) => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const found = frames.find(match);
      if (found) return found;
      await sleep(100);
    }
    return undefined;
  };
  return { socket, frames, opened, waitFor, close: () => socket.close() };
}

try {
  const health = await fetch(`${base}/health`);
  check(health.status === 200, "the Worker answers");

  check(
    (await api("max", "GET", "/v1/channels", undefined, "garbage")).status === 401,
    "a bad token is refused",
  );
  const told = await internal("people", signChatPeople(keys.privateKey, { workspaceId: ws }), {
    people: Object.values(people),
  });
  check(told === 200, "the control plane tells the room who is in the workspace", told);

  const list = await api("max", "GET", "/v1/channels");
  check(
    list.status === 200 && list.json.some((c: any) => c.id === "general"),
    "#general is there",
    list,
  );
  const made = await api("max", "POST", "/v1/channels", { name: "Smoke" });
  check(made.status === 201, "a channel is made", made);
  const channel = made.json.id as string;
  check(
    (await api("mia", "POST", `/v1/channels/${channel}/members`, { add: [people.mia.email] }))
      .status === 200,
    "Mia joins it",
  );

  // Live events
  const mia = connect("mia");
  await mia.opened;
  const hello = await mia
    .waitFor((f) => f.t === "ready" || f.t === "resync", 100)
    .catch(() => undefined);
  mia.socket.send(JSON.stringify({ t: "hello", cursor: 0 }));
  const ready = await mia.waitFor((f) => f.t === "ready");
  check(!!ready, "a connection is told it is ready", hello);
  const posted = await api("max", "POST", `/v1/channels/${channel}/messages`, {
    body: "hello from the smoke test",
  });
  check(posted.status === 201, "a message is posted", posted);
  const heard = await mia.waitFor(
    (f) =>
      f.t === "event" && f.type === "message.new" && f.data.body === "hello from the smoke test",
  );
  check(!!heard, "Mia hears it live");
  const cursor = heard?.id ?? 0;

  // The room sleeps with people connected, and wakes for the next thing
  await sleep(20_000);
  const later = await api("max", "POST", `/v1/channels/${channel}/messages`, {
    body: "after a rest",
  });
  const heardLater = await mia.waitFor(
    (f) => f.t === "event" && f.type === "message.new" && f.data.body === "after a rest",
  );
  check(
    later.status === 201 && !!heardLater,
    "a sleeping room wakes and still reaches a connection made before it slept",
  );

  // Typing is passed on and not kept
  const max = connect("max");
  await max.opened;
  max.socket.send(JSON.stringify({ t: "typing", channelId: channel }));
  check(
    !!(await mia.waitFor((f) => f.t === "typing" && f.userId === "acct_max")),
    "typing is shown to the others",
  );

  // Coming back after being away
  mia.close();
  await sleep(500);
  await api("max", "POST", `/v1/channels/${channel}/messages`, { body: "while you were away 1" });
  await api("max", "POST", `/v1/channels/${channel}/messages`, { body: "while you were away 2" });
  const back = connect("mia");
  await back.opened;
  back.socket.send(JSON.stringify({ t: "hello", cursor: heardLater?.id ?? cursor }));
  const caught = await back.waitFor((f) => f.t === "ready");
  const missed = back.frames
    .filter((f) => f.t === "event" && f.type === "message.new")
    .map((f) => f.data.body);
  check(
    !!caught &&
      missed.includes("while you were away 1") &&
      missed.includes("while you were away 2"),
    "what was missed is sent on coming back",
    missed,
  );

  // Ending someone's access
  const revoked = await internal(
    "revoke",
    signChatRevocation(keys.privateKey, { workspaceId: ws, sub: people.mia.sub }),
  );
  check(revoked === 200, "the control plane ends Mia's access", revoked);
  check((await api("mia", "GET", "/v1/channels")).status === 401, "her old token no longer works");
  const fresh = await api("mia", "GET", "/v1/channels", undefined, token("mia", Date.now() + 3000));
  void fresh;

  // Files: sent to the bucket, fetched back, counted, and cleared out
  const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
  const begun = await api("max", "POST", "/v1/files/uploads", {
    channelId: channel,
    name: "smoke.bin",
    mime: "application/pdf",
    bytes: bytes.length,
  });
  check(begun.status === 201, "a file is given an address to be sent to", begun);
  if (begun.status === 201) {
    const put = await fetch(`${base}/w/${ws}${begun.json.upload}`, { method: "PUT", body: bytes });
    check(put.status === 200, "the file is sent to the bucket", await put.text());
    const wrong = await fetch(
      `${base}/w/${ws}${begun.json.upload.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64))}`,
      { method: "PUT", body: bytes },
    );
    check(wrong.status === 403, "a forged address is refused");
    const posted = await api("max", "POST", `/v1/channels/${channel}/messages`, {
      body: "a file",
      fileIds: [begun.json.fileId],
    });
    check(
      posted.status === 201 && posted.json.files?.[0]?.bytes === bytes.length,
      "it goes on a message",
      posted,
    );
    const link = await api("max", "POST", `/v1/files/${begun.json.fileId}/link`, {});
    const got = await fetch(`${base}/w/${ws}${link.json.path}`);
    const back = new Uint8Array(await got.arrayBuffer());
    check(
      got.status === 200 && back.length === bytes.length && back[1000] === bytes[1000],
      "it is fetched back whole",
      got.status,
    );
    const part = await fetch(`${base}/w/${ws}${link.json.path}`, {
      headers: { range: "bytes=10-19" },
    });
    check(
      part.status === 206 && (await part.arrayBuffer()).byteLength === 10,
      "part of it can be fetched",
    );
    const usage = await api("max", "GET", "/v1/usage");
    check(
      usage.json.bytesUsed === bytes.length && usage.json.files === 1,
      "it is counted",
      usage.json,
    );
    const gone = await api("max", "DELETE", `/v1/messages/${posted.json.id}`);
    check(gone.status === 200, "deleting the message deletes the file");
    const after = await api("max", "GET", "/v1/usage");
    check(after.json.bytesUsed === 0, "and gives back its room", after.json);
  }

  // A file left in the workspace, which clearing the workspace out must take from the bucket too.
  const left = await api("max", "POST", "/v1/files/uploads", { channelId: channel, name: "left.bin", mime: "application/pdf", bytes: 1234 });
  if (left.status === 201) {
    await fetch(`${base}/w/${ws}${left.json.upload}`, { method: "PUT", body: new Uint8Array(1234) });
    console.log(`left in the bucket: w/${ws}/f/${left.json.fileId}`);
  }

  max.close();
  back.close();
} finally {
  const purged = await internal("purge", signChatPurge(keys.privateKey, { workspaceId: ws }));
  check(purged === 200, "the workspace is cleared out", purged);
}
console.log(failures === 0 ? "\nAll good." : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
