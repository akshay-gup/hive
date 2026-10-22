import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { channelWorkspaceDir } from "../apps/server/src/engine/threads.ts";
import { conversationTools } from "../apps/server/src/engine/tools.ts";
import { HiveToolBridge } from "../apps/server/src/opencode/hive-tools.ts";
import { ORCHESTRATOR_CHANNEL_ID } from "../packages/domain/src/agent.ts";
import { channelFileLimits, sentFileSchema } from "../packages/domain/src/workspace-files.ts";

let directory: string,
  db: Awaited<ReturnType<typeof createStore>>,
  server: Awaited<ReturnType<typeof createApp>>;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-channel-file-tools-"));
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
  await server.agent.ensure("alice");
});
after(async () => {
  await server.agent.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

const workspace = (channelId: string, owner = "shared") =>
  channelWorkspaceDir(directory, owner, channelId);
async function put(channelId: string, path: string, text: string, owner = "shared") {
  const file = join(workspace(channelId, owner), path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text);
}
/** The tools as the agent in a channel's thread has them. */
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
    { signal: abort.signal, requestKey: "run-1", channelId },
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

test("an agent shares a file it made, and the card is made from what comes back", async () => {
  const channel = await server.agent.createChannel("alice", { name: "Share files" });
  await put(channel.id, "reports/q3.md", "# Q3\n\nSpend is up 6%.");
  const { call } = toolsFor(channel.id);
  const result = await call("send_file", { path: "reports/q3.md", caption: "  The Q3 summary  " });
  const sent = sentFileSchema.parse(result);
  assert.equal(sent.channelId, channel.id);
  assert.equal(sent.caption, "The Q3 summary");
  assert.equal(sent.file.path, "reports/q3.md");
  assert.equal(sent.file.name, "q3.md");
  assert.equal(sent.file.kind, "markdown");
  assert.equal(sent.file.mimeType, "text/markdown");
  assert.equal(sent.file.size, 21);
  // Nothing in the result can outlive the link it would carry: it names the file and no more.
  assert.deepEqual(Object.keys(result).sort(), ["caption", "channelId", "file", "sent"]);
  assert.doesNotMatch(JSON.stringify(result), /signature|\/view\/|http|Spend is up/);
  // The path can be given the way the agent sees it from its own working folder.
  const absolute = await call("send_file", { path: join(workspace(channel.id), "reports/q3.md") });
  assert.equal(sentFileSchema.parse(absolute).file.path, "reports/q3.md");
  assert.equal("caption" in absolute, false);
});

test("a file that cannot be shared comes back as a reason the agent can act on", async () => {
  const channel = await server.agent.createChannel("alice", { name: "Bad paths" });
  await put(channel.id, "docs/ok.txt", "ok");
  await put(channel.id, "threads/abc.json", "{}");
  await writeFile(join(directory, "secret.txt"), "private");
  await symlink(join(directory, "secret.txt"), join(workspace(channel.id), "peek.txt"));
  const { call } = toolsFor(channel.id);
  for (const path of [
    "nope.txt",
    "docs",
    "../secret.txt",
    "/etc/passwd",
    join(directory, "secret.txt"),
    "threads/abc.json",
    "peek.txt",
    ".env",
  ]) {
    const result = await call("send_file", { path });
    assert.equal(result.sent, false, path);
    assert.equal(typeof result.error, "string", path);
  }
  assert.match(
    String((await call("send_file", { path: "nope.txt" })).error),
    /not found.*relative to its top/i,
  );
  assert.match(String((await call("send_file", { path: "docs" })).error), /not a file/i);
});

test("an agent with no file tools can write a text file as it shares it", async () => {
  const channel = await server.agent.createChannel("alice", { name: "Write files" });
  const { call } = toolsFor(channel.id);
  const made = sentFileSchema.parse(
    await call("send_file", { path: "plans/launch.md", content: "# Launch\n\n- Monday" }),
  );
  assert.equal(made.file.kind, "markdown");
  assert.equal(
    await readFile(join(workspace(channel.id), "plans/launch.md"), "utf8"),
    "# Launch\n\n- Monday",
  );
  // Sending it again with new content replaces it, which is how a document is revised.
  await call("send_file", { path: "plans/launch.md", content: "# Launch\n\n- Tuesday" });
  assert.equal(
    await readFile(join(workspace(channel.id), "plans/launch.md"), "utf8"),
    "# Launch\n\n- Tuesday",
  );
  // A web page or an SVG is text, so it can be written this way.
  assert.equal(
    (await call("send_file", { path: "site/index.html", content: "<h1>Hi</h1>" })).sent,
    true,
  );
  assert.equal(
    (
      await call("send_file", {
        path: "logo.svg",
        content: "<svg xmlns='http://www.w3.org/2000/svg'/>",
      })
    ).sent,
    true,
  );
  // A picture or a PDF is not text: writing text into it would only make a broken file.
  for (const path of ["photo.png", "report.pdf", "clip.mp4", "bundle.zip", "mystery"])
    assert.match(
      String((await call("send_file", { path, content: "not really" })).error),
      /only text files/i,
      path,
    );
  const refused = await call("send_file", { path: "../escape.md", content: "x" });
  assert.equal(refused.sent, false);
  assert.equal((await call("send_file", { path: "empty.md", content: "" })).sent, false);
  // The limit is checked before anything is written.
  assert.throws(() =>
    call("send_file", { path: "huge.md", content: "x".repeat(channelFileLimits.writeBytes + 1) }),
  );
});

test("a file is shared from the workspace the agent is working in", async () => {
  const channel = await server.agent.createChannel("alice", { name: "Which workspace" });
  const thread = await server.agent.registerThread("alice", channel.id);
  await put(channel.id, "team.txt", "shared");
  await put(ORCHESTRATOR_CHANNEL_ID, "mine.txt", "private", "alice");
  // A tool that is told its channel uses it.
  assert.equal(
    sentFileSchema.parse(await toolsFor(channel.id).call("send_file", { path: "team.txt" }))
      .channelId,
    channel.id,
  );
  // One that is not finds it from the thread it is running in...
  const bound = toolsFor(undefined, thread.threadId);
  assert.equal(
    sentFileSchema.parse(await bound.call("send_file", { path: "team.txt" })).channelId,
    channel.id,
  );
  // ...and a chat that belongs to no channel is the person's own orchestrator, which is private.
  const main = toolsFor(undefined, "main-chat");
  assert.equal(
    sentFileSchema.parse(await main.call("send_file", { path: "mine.txt" })).channelId,
    ORCHESTRATOR_CHANNEL_ID,
  );
  assert.equal((await main.call("send_file", { path: "team.txt" })).sent, false);
  assert.equal(
    (await toolsFor(undefined, "main-chat", "bob").call("send_file", { path: "mine.txt" })).sent,
    false,
  );
  // Nothing can be written into an archived channel.
  await server.agent.archiveChannel("alice", channel.id);
  assert.match(
    String((await toolsFor(channel.id).call("send_file", { path: "new.md", content: "x" })).error),
    /archived/i,
  );
});

test("send_file works the way OpenCode calls it, through the tool bridge", async () => {
  const channel = await server.agent.createChannel("alice", { name: "Bridge files" });
  await put(channel.id, "out/report.csv", "a,b\n1,2");
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
    (t: { name: string }) => t.name === "send_file",
  );
  assert.deepEqual(Object.keys(listed.inputSchema.properties).sort(), [
    "caption",
    "content",
    "path",
  ]);
  assert.deepEqual(listed.inputSchema.required, ["path"]);
  const reply = await rpc("tools/call", {
    name: "send_file",
    arguments: { path: "out/report.csv" },
  });
  assert.equal(reply.result.isError, undefined);
  const sent = sentFileSchema.parse(JSON.parse(reply.result.content[0].text));
  assert.equal(sent.file.kind, "csv");
  // A bad call is an error the model sees, not a crash.
  const bad = await rpc("tools/call", { name: "send_file", arguments: {} });
  assert.equal(bad.result.isError, true);
  lease.release();
});

test("a run that has been stopped does not share anything", async () => {
  const channel = await server.agent.createChannel("alice", { name: "Stopped" });
  await put(channel.id, "a.txt", "a");
  const { call, abort } = toolsFor(channel.id);
  abort.abort();
  await assert.rejects(call("send_file", { path: "a.txt" }));
});
