import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { sharedTaskTools } from "../apps/server/src/engine/task-executor.ts";
import { channelWorkspaceDir } from "../apps/server/src/engine/threads.ts";
import { conversationTools } from "../apps/server/src/engine/tools.ts";
import { HiveToolBridge } from "../apps/server/src/opencode/hive-tools.ts";
import { ORCHESTRATOR_CHANNEL_ID } from "../packages/domain/src/agent.ts";
import {
  type ChannelFile,
  type UploadRequestState,
  uploadRequestLimits,
  uploadRequestSchema,
} from "../packages/domain/src/workspace-files.ts";

let directory: string,
  db: Awaited<ReturnType<typeof createStore>>,
  server: Awaited<ReturnType<typeof createApp>>,
  aliceToken: string,
  bobToken: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-upload-requests-"));
  db = await createStore({ dataDir: join(directory, "postgres") });
  server = await createApp(db, {
    mode: "sample",
    host: "127.0.0.1",
    port: 8787,
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  await db.put("system", "users", { id: "alice", name: "Alice" });
  await db.put("system", "users", { id: "bob", name: "Bob" });
  await server.agent.ensure("alice");
  await server.agent.ensure("bob");
  aliceToken = (await server.auth.sessionForOwner("alice")).token;
  bobToken = (await server.auth.sessionForOwner("bob")).token;
});
after(async () => {
  await server.agent.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

function toolsFor(channelId: string | undefined, threadId = "thread-1", owner = "alice") {
  const abort = new AbortController();
  const tools = conversationTools(
    server.agent,
    owner,
    {
      threadId,
      runId: "run-1",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    },
    { signal: abort.signal, requestKey: `${threadId}:run-1`, channelId },
  );
  const call = (name: string, args: unknown) => {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `no tool named ${name}`);
    return (tool.execute as (args: unknown) => Promise<Record<string, unknown>>)(
      (tool.parameters as { parse: (value: unknown) => unknown }).parse(args),
    );
  };
  return { tools, call, abort };
}
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (path: string, token = aliceToken, init: RequestInit = {}) =>
  server.app.request(`/api/agent${path}`, { ...init, headers: { ...as(token), ...init.headers } });
const upload = (
  channelId: string,
  name: string,
  body: string,
  fields: Record<string, string> = {},
  token = aliceToken,
) => {
  const form = new FormData();
  form.append("file", new File([body], name));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return api(`/channels/${channelId}/files`, token, { method: "POST", body: form });
};

test("an agent asks for files and gets an answer at once, with what it asked for", async () => {
  const channel = await server.agent.createChannel("alice", { name: "Ask files" });
  const { call } = toolsFor(channel.id);
  const asked = uploadRequestSchema.parse(
    await call("request_upload", {
      prompt: "  Please upload the brand guidelines  ",
      accept: ["PDF", ".png", "pdf"],
    }),
  );
  assert.equal(asked.channelId, channel.id);
  assert.equal(asked.prompt, "Please upload the brand guidelines");
  assert.deepEqual(asked.accept, ["pdf", "png"]);
  assert.equal(asked.multiple, true);
  assert.equal(asked.folder, "uploads");
  assert.match(asked.requestId, /^[a-f0-9]{16}$/);
  // Asking again the same way is the same request; asking for something else is another.
  assert.equal(
    (
      await call("request_upload", {
        prompt: "Please upload the brand guidelines",
        accept: ["PDF", ".png", "pdf"],
      })
    ).requestId,
    asked.requestId,
  );
  const another = uploadRequestSchema.parse(
    await call("request_upload", {
      prompt: "And the logo",
      multiple: false,
      folder: "brand/assets/",
    }),
  );
  assert.notEqual(another.requestId, asked.requestId);
  assert.equal(another.multiple, false);
  assert.equal(another.folder, "brand/assets");
  assert.equal("accept" in another, false);
  // Nothing has been uploaded yet.
  const state = (await (
    await api(`/channels/${channel.id}/uploads/${asked.requestId}`)
  ).json()) as UploadRequestState;
  assert.deepEqual(state.files, []);
  assert.equal(state.prompt, asked.prompt);
  assert.ok(state.createdAt);
});

test("a request that cannot be made says why, in words the agent can act on", async () => {
  const channel = await server.agent.createChannel("alice", { name: "Bad asks" });
  const { call } = toolsFor(channel.id);
  for (const folder of ["threads", "attachments/x", ".secret", "../outside", "a/../b"]) {
    const result = await call("request_upload", { prompt: "A file", folder });
    assert.equal(result.requested, false, folder);
    assert.equal(typeof result.error, "string", folder);
  }
  // The arguments are checked before anything is recorded.
  assert.throws(() => call("request_upload", { prompt: "" }));
  assert.throws(() =>
    call("request_upload", { prompt: "x".repeat(uploadRequestLimits.prompt + 1) }),
  );
  assert.throws(() => call("request_upload", { prompt: "A file", accept: ["not an extension"] }));
  assert.throws(() =>
    call("request_upload", {
      prompt: "A file",
      accept: Array.from({ length: 13 }, (_, i) => `e${i}`),
    }),
  );
  await server.agent.archiveChannel("alice", channel.id);
  assert.match(String((await call("request_upload", { prompt: "A file" })).error), /archived/i);
  const gone = toolsFor("nowhere");
  assert.equal((await gone.call("request_upload", { prompt: "A file" })).requested, false);
});

test("what a person uploads for a request is saved where the agent asked and recorded against it", async () => {
  const channel = await server.agent.createChannel("alice", { name: "Answer files" });
  const { call } = toolsFor(channel.id);
  const asked = uploadRequestSchema.parse(
    await call("request_upload", { prompt: "Send the contract", folder: "contracts" }),
  );
  const first = await upload(channel.id, "Contract v1.pdf", "%PDF-1.7 one", {
    request: asked.requestId,
  });
  assert.equal(first.status, 201);
  const saved = (await first.json()) as ChannelFile;
  // The request's folder wins over any other the client names.
  assert.equal(saved.path, "contracts/Contract v1.pdf");
  const second = await upload(channel.id, "Contract v2.pdf", "%PDF-1.7 two", {
    request: asked.requestId,
    dir: "elsewhere",
  });
  assert.equal(((await second.json()) as ChannelFile).path, "contracts/Contract v2.pdf");
  assert.equal(
    await readFile(
      join(channelWorkspaceDir(directory, "shared", channel.id), "contracts/Contract v1.pdf"),
      "utf8",
    ),
    "%PDF-1.7 one",
  );
  // The request knows who added what, as each person sees it.
  await db.put("system", "users", { id: "bob", name: "Bob" });
  const third = await upload(
    channel.id,
    "Annex.pdf",
    "%PDF-1.7 three",
    { request: asked.requestId },
    bobToken,
  );
  assert.equal(third.status, 201);
  const seenByAlice = (await (
    await api(`/channels/${channel.id}/uploads/${asked.requestId}`)
  ).json()) as UploadRequestState;
  assert.deepEqual(
    seenByAlice.files.map((f) => [f.name, f.uploadedByName, f.mine, f.kind]),
    [
      ["Contract v1.pdf", "Alice", true, "pdf"],
      ["Contract v2.pdf", "Alice", true, "pdf"],
      ["Annex.pdf", "Bob", false, "pdf"],
    ],
  );
  const seenByBob = (await (
    await api(`/channels/${channel.id}/uploads/${asked.requestId}`, bobToken)
  ).json()) as UploadRequestState;
  assert.deepEqual(
    seenByBob.files.map((f) => f.mine),
    [false, false, true],
  );
  assert.equal(JSON.stringify(seenByBob).includes('"owner"'), false);
});

test("a request for one file takes one, and nothing is left behind by a refusal", async () => {
  const channel = await server.agent.createChannel("alice", { name: "One file" });
  const { call } = toolsFor(channel.id);
  const asked = uploadRequestSchema.parse(
    await call("request_upload", { prompt: "The signed form", multiple: false }),
  );
  assert.equal(
    (await upload(channel.id, "form.pdf", "%PDF-1.7", { request: asked.requestId })).status,
    201,
  );
  const refused = await upload(channel.id, "second.pdf", "%PDF-1.7", { request: asked.requestId });
  assert.equal(refused.status, 409);
  const listing = (await (await api(`/channels/${channel.id}/files?path=uploads`)).json()) as {
    entries: ChannelFile[];
  };
  assert.deepEqual(
    listing.entries.map((e) => e.name),
    ["form.pdf"],
  );
  // A request is as full as it can be at the limit for many files.
  const many = uploadRequestSchema.parse(
    await call("request_upload", { prompt: "Everything you have" }),
  );
  for (let i = 0; i < uploadRequestLimits.files; i++)
    assert.equal(
      (await upload(channel.id, `doc-${i}.txt`, `doc ${i}`, { request: many.requestId })).status,
      201,
      `file ${i}`,
    );
  assert.equal(
    (await upload(channel.id, "one-too-many.txt", "x", { request: many.requestId })).status,
    409,
  );
});

test("a request can only be answered where it was asked, and only seen by those it was asked of", async () => {
  const channel = await server.agent.createChannel("alice", { name: "Where asked" });
  const other = await server.agent.createChannel("alice", { name: "Elsewhere" });
  const asked = uploadRequestSchema.parse(
    await toolsFor(channel.id).call("request_upload", { prompt: "A file" }),
  );
  // Not from another channel, not by guessing, not by a malformed id.
  assert.equal((await upload(other.id, "x.txt", "x", { request: asked.requestId })).status, 404);
  assert.equal((await api(`/channels/${other.id}/uploads/${asked.requestId}`)).status, 404);
  for (const id of ["0123456789abcdef", "nope", "../x", asked.requestId.toUpperCase()]) {
    assert.equal((await upload(channel.id, "x.txt", "x", { request: id })).status, 404, id);
    assert.equal(
      (await api(`/channels/${channel.id}/uploads/${encodeURIComponent(id)}`)).status,
      404,
      id,
    );
  }
  // A file that is not accepted leaves no record behind.
  assert.equal((await api(`/channels/${channel.id}/uploads/${asked.requestId}`)).status, 200);
  assert.deepEqual(
    (
      (await (
        await api(`/channels/${channel.id}/uploads/${asked.requestId}`)
      ).json()) as UploadRequestState
    ).files,
    [],
  );
  // A person's own orchestrator is private, and so are the requests made in it.
  const private1 = uploadRequestSchema.parse(
    await toolsFor(undefined, "main-chat").call("request_upload", { prompt: "My file" }),
  );
  assert.equal(private1.channelId, ORCHESTRATOR_CHANNEL_ID);
  assert.equal(
    (await api(`/channels/${ORCHESTRATOR_CHANNEL_ID}/uploads/${private1.requestId}`)).status,
    200,
  );
  assert.equal(
    (await api(`/channels/${ORCHESTRATOR_CHANNEL_ID}/uploads/${private1.requestId}`, bobToken))
      .status,
    404,
  );
  assert.equal(
    (await upload(ORCHESTRATOR_CHANNEL_ID, "x.txt", "x", { request: private1.requestId }, bobToken))
      .status,
    404,
  );
  assert.equal(
    (await upload(ORCHESTRATOR_CHANNEL_ID, "mine.txt", "x", { request: private1.requestId }))
      .status,
    201,
  );
});

test("request_upload works the way OpenCode calls it, and a task run is not offered it", async () => {
  const channel = await server.agent.createChannel("alice", { name: "Bridge ask" });
  const { tools, abort } = toolsFor(channel.id);
  const bridge = new HiveToolBridge("http://localhost:8787/api/hive-tools");
  const lease = bridge.lease(tools, abort.signal);
  const rpc = async (method: string, params: unknown = {}) =>
    (
      await bridge.routes.request("/", {
        method: "POST",
        headers: { Authorization: `Bearer ${lease.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json();
  const listed = (await rpc("tools/list")).result.tools.find(
    (t: { name: string }) => t.name === "request_upload",
  );
  assert.deepEqual(listed.inputSchema.required, ["prompt"]);
  assert.deepEqual(Object.keys(listed.inputSchema.properties).sort(), [
    "accept",
    "folder",
    "multiple",
    "prompt",
  ]);
  const reply = await rpc("tools/call", {
    name: "request_upload",
    arguments: { prompt: "The brief", accept: ["pdf"] },
  });
  assert.equal(reply.result.isError, undefined);
  assert.equal(
    uploadRequestSchema.parse(JSON.parse(reply.result.content[0].text)).accept?.[0],
    "pdf",
  );
  assert.equal(
    (await rpc("tools/call", { name: "request_upload", arguments: { prompt: "" } })).result.isError,
    true,
  );
  lease.release();
  // A task cannot wait in a chat, so it keeps every other conversation tool but not this one.
  const kept = sharedTaskTools(tools, [{ name: "ask_user" }, { name: "send_file" }]).map(
    (t) => t.name,
  );
  assert.ok(!kept.includes("request_upload"));
  assert.ok(!kept.includes("send_file"), "a tool the worker has itself wins");
  assert.ok(kept.includes("create_issue"));
  assert.equal(kept.length, tools.length - 2);
});
