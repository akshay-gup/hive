import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { EventSchemas } from "@ag-ui/core";
import { shimFixture } from "./helpers/shim.ts";

/** The tools a chat reply can use, as the agent in the chat reaches them: through the shim and the tool bridge. */

const requestedUrl = "https://example.org/article";
const observed = {
  url: "https://example.org/article/final",
  title: "An observed article",
  text: "Actual article contents from the browser.",
  truncated: false,
};

async function browsing(t: TestContext, failure?: string) {
  const browserCalls: string[] = [];
  const f = await shimFixture(t, {
    browse: (path, body) => {
      browserCalls.push(path);
      if (failure) return { status: 502, data: { error: { message: failure } } };
      return {
        data: path.endsWith("/read")
          ? observed
          : {
              id: body.id,
              title: "Opened page",
              url: body.url,
              status: "active",
              updatedAt: new Date().toISOString(),
            },
      };
    },
  });
  return { ...f, browserCalls };
}

test("browse_web reaches the chat as real tool events, with the page the browser observed", async (t) => {
  const f = await browsing(t);
  f.whenPrompted(async ({ call, say, idle }) => {
    await call("browse_web", { url: requestedUrl });
    say("Here is a summary.");
    idle();
  });
  const chat = await f.run(`@hive Summarize ${requestedUrl}`);
  for (const event of chat.events) EventSchemas.parse(event);
  assert.deepEqual(
    chat.events.filter((event) => event.type.startsWith("TOOL_CALL")).map((event) => event.type),
    ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"],
  );
  assert.equal(chat.last, "RUN_FINISHED");
  const [shown] = chat.tools;
  assert.equal(shown.name, "browse_web");
  assert.deepEqual(shown.args, { url: requestedUrl });
  const { shot, ...page } = shown.result as { sessionId: string; shot?: string };
  assert.deepEqual(page, { sessionId: page.sessionId, ...observed });
  assert.match(page.sessionId, /^[a-f0-9-]{36}$/);
  // The picture of the page the steps list shows, kept by the workspace and named by the result.
  assert.match(shot ?? "", /^[a-f0-9-]{36}$/);
  assert.deepEqual(f.browserCalls, [
    "/sessions",
    `/sessions/${page.sessionId}/read`,
    `/sessions/${page.sessionId}/screenshot`,
  ]);
  assert.equal((await f.db.list("local-user", "tasks")).length, 0);
  assert.match(f.standIn.prompts[0].parts[0].text, /untrusted/);

  // The page is in a browser session the person can follow, and the next question reuses it.
  const { token } = await f.auth.session();
  const response = await f.app.request(`/api/browsers/${page.sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.url, observed.url);
  assert.match(session.previewUrl, new RegExp(`/api/browsers/${page.sessionId}/preview\\?`));
  await f.run(`@hive Summarize ${requestedUrl} again`);
  assert.equal((await f.db.list("local-user", "browsers")).length, 1);
});

test("browse_web reports a page that could not be opened as it is, not as a page", async (t) => {
  const f = await browsing(t, "Public page could not be opened");
  f.whenPrompted(async ({ call, idle }) => {
    await call("browse_web", { url: requestedUrl });
    idle();
  });
  const chat = await f.run(`@hive Summarize ${requestedUrl}`);
  assert.deepEqual(chat.tools[0].result, { error: "Public page could not be opened" });
  assert.deepEqual(f.browserCalls, ["/sessions"]);
  assert.equal((await f.db.list("local-user", "tasks")).length, 0);
});

test("a reply that has been stopped cannot open pages", async (t) => {
  const f = await browsing(t);
  let refused: unknown;
  f.whenPrompted(async ({ call }) => {
    await f.stop();
    try {
      await call("browse_web", { url: requestedUrl });
    } catch (error) {
      refused = error;
    }
  });
  await f.run(`@hive Summarize ${requestedUrl}`);
  assert.ok(refused, "the agent's tool call was refused");
  assert.deepEqual(f.browserCalls, []);
});

test("the agent searches and reads the workspace's mail without creating a task or sending", async (t) => {
  const f = await browsing(t);
  const actionsBefore = await f.db.list("local-user", "actions");
  f.whenPrompted(async ({ call, say, idle }) => {
    await call("search_mail", { query: "aquarium" });
    await call("read_mail_thread", { threadId: "trip-thread" });
    say("It leaves at 8:15.");
    idle();
  });
  const chat = await f.run("@hive Check my emails for the school trip");
  assert.equal(chat.tools.length, 2);
  const search = chat.tools[0].result as { matches: { threadId: string }[] };
  const read = chat.tools[1].result as { messages: { body: string }[]; truncated: boolean };
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0].threadId, "trip-thread");
  assert.equal("body" in search.matches[0], false);
  assert.match(read.messages[0].body, /8:15 AM/);
  assert.equal(read.truncated, false);
  assert.equal((await f.db.list("local-user", "tasks")).length, 0);
  assert.deepEqual(await f.db.list("local-user", "actions"), actionsBefore);
});

test("the mail tools say when mail is disconnected, and when a thread is not there", async (t) => {
  const f = await browsing(t);
  await f.db.put("local-user", "settings", { id: "google", enabled: false });
  let toolCall: { name: string; args: object } = {
    name: "search_mail",
    args: { query: "aquarium" },
  };
  f.whenPrompted(async ({ call, idle }) => {
    await call(toolCall.name, toolCall.args);
    idle();
  });
  const failure = async () =>
    ((await f.run("@hive Check my mail")).tools[0].result as { error: string }).error;
  assert.match(await failure(), /disconnected/);
  await f.db.put("local-user", "settings", { id: "google", enabled: true });
  toolCall = { name: "read_mail_thread", args: { threadId: "no-such-thread" } };
  assert.match(await failure(), /not found/);
});
