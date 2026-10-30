import assert from "node:assert/strict";
import { test } from "node:test";
import { people, wired } from "./helpers/chat-wired.ts";
import type { FakeTurn } from "./helpers/fake-opencode.ts";

/** The tools a chat reply can use, as the agent reaches them in a person's own chat: through the room and the tool bridge. */

const requestedUrl = "https://example.org/article";
const observed = {
  url: "https://example.org/article/final",
  title: "An observed article",
  text: "Actual article contents from the browser.",
  truncated: false,
};
/** Whoever asks is this account's person on the machine. */
const max = people.max.id;

async function browsing(
  t: Parameters<typeof wired>[0],
  behave: (turn: FakeTurn) => void | Promise<void>,
  failure?: string,
) {
  const browserCalls: string[] = [];
  const f = await wired(t, behave, {
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
  return { ...f, browserCalls, mine: await f.own() };
}

test("browse_web reaches the chat as a tool step, with the page the browser observed", async (t) => {
  const f = await browsing(t, async ({ call, say }) => {
    await call("browse_web", { url: requestedUrl });
    say("Here is a summary.");
  });
  const chat = await f.say("max", f.mine.id, `Summarize ${requestedUrl}`);
  assert.equal(chat.status, "done");
  assert.equal(chat.text, "Here is a summary.");
  const shown = chat.tools[0];
  assert.ok(shown);
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
  assert.equal((await f.db.list(max, "tasks")).length, 0);
  assert.match(f.opencode.prompts[0]?.context ?? "", /untrusted/);

  // The page is in a browser session the person can follow, and the next question reuses it.
  const { token } = await f.server.auth.session();
  const response = await f.server.app.request(`/api/browsers/${page.sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.url, observed.url);
  assert.match(session.previewUrl, new RegExp(`/api/browsers/${page.sessionId}/preview\\?`));
  await f.say("max", f.mine.id, `Summarize ${requestedUrl} again`);
  assert.equal((await f.db.list(max, "browsers")).length, 1);
});

test("browse_web reports a page that could not be opened as it is, not as a page", async (t) => {
  const f = await browsing(
    t,
    async ({ call }) => {
      await call("browse_web", { url: requestedUrl });
    },
    "Public page could not be opened",
  );
  const chat = await f.say("max", f.mine.id, `Summarize ${requestedUrl}`);
  assert.deepEqual(chat.tools[0]?.result, { error: "Public page could not be opened" });
  assert.deepEqual(f.browserCalls, ["/sessions"]);
  assert.equal((await f.db.list(max, "tasks")).length, 0);
});

test("a reply that has been stopped cannot open pages", async (t) => {
  let refused: unknown;
  let stop: () => Promise<unknown> = async () => undefined;
  const f = await browsing(t, async ({ call }) => {
    await stop();
    // The agent goes on after Stop and tries the tool anyway.
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      await call("browse_web", { url: requestedUrl });
    } catch (error) {
      refused = error;
    }
  });
  stop = async () => {
    const run = f.core.runs.active()[0];
    assert.ok(run);
    return f.call("max", "POST", `/v1/runs/${run.id}/stop`);
  };
  await f.say("max", f.mine.id, `Summarize ${requestedUrl}`);
  await f.until("the agent's tool call to be answered", () => refused !== undefined);
  assert.ok(refused, "the agent's tool call was refused");
  assert.deepEqual(f.browserCalls, []);
});

test("the agent searches and reads the person's mail without creating a task or sending", async (t) => {
  const f = await browsing(t, async ({ call, say }) => {
    await call("search_mail", { query: "aquarium" });
    await call("read_mail_thread", { threadId: "trip-thread" });
    say("It leaves at 8:15.");
  });
  await f.server.workspace.ensureSample(max, f.server.actions);
  const actionsBefore = await f.db.list(max, "actions");
  const chat = await f.say("max", f.mine.id, "Check my emails for the school trip");
  assert.equal(chat.tools.length, 2);
  const search = chat.tools[0]?.result as { matches: { threadId: string }[] };
  const read = chat.tools[1]?.result as { messages: { body: string }[]; truncated: boolean };
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0]?.threadId, "trip-thread");
  assert.equal("body" in (search.matches[0] ?? {}), false);
  assert.match(read.messages[0]?.body ?? "", /8:15 AM/);
  assert.equal(read.truncated, false);
  assert.equal((await f.db.list(max, "tasks")).length, 0);
  assert.deepEqual(await f.db.list(max, "actions"), actionsBefore);
});

test("the mail tools say when mail is disconnected, and when a thread is not there", async (t) => {
  let toolCall: { name: string; args: object } = {
    name: "search_mail",
    args: { query: "aquarium" },
  };
  const f = await browsing(t, async ({ call }) => {
    await call(toolCall.name, toolCall.args);
  });
  await f.server.workspace.ensureSample(max, f.server.actions);
  await f.db.put(max, "settings", { id: "google", enabled: false });
  const failure = async () => {
    const shown = (await f.say("max", f.mine.id, "Check my mail")).tools[0];
    assert.ok(shown);
    return (shown.result as { error: string }).error;
  };
  assert.match(await failure(), /disconnected/);
  await f.db.put(max, "settings", { id: "google", enabled: true });
  toolCall = { name: "read_mail_thread", args: { threadId: "no-such-thread" } };
  assert.match(await failure(), /not found/);
});
