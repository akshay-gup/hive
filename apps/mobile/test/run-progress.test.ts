import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CARD_TOOLS,
  formatElapsed,
  interruptedTools,
  mergeItems,
  type ProgressStep,
  progressItems,
  progressStep,
  showsRunningStep,
  summarizeSteps,
} from "../src/run-progress.ts";

const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  function: { name, arguments: JSON.stringify(args) },
});
const result = (toolCallId: string, content: string) => ({ role: "tool", toolCallId, content });

test("a page, a command and a file read as what the agent did", () => {
  const fetched = progressStep(
    call("1", "webfetch", { url: "https://www.techcrunch.com/ai/" }),
    "page text",
    true,
  );
  assert.deepEqual(fetched, {
    id: "1",
    label: "Fetched techcrunch.com",
    detail: undefined,
    output: "page text",
    state: "done",
  });

  const ran = progressStep(
    call("2", "bash", { command: "ls -la", description: "List the folder" }),
    "total 0",
    true,
  );
  assert.equal(ran?.label, "Ran a command");
  assert.equal(ran?.detail, "List the folder");

  const read = progressStep(call("3", "read", { filePath: "/work/notes/plan.md" }), "# Plan", true);
  assert.equal(read?.label, "Read plan.md");
});

test("a step under way says what it is doing, and one that was cut off says it stopped", () => {
  const running = progressStep(
    call("1", "webfetch", { url: "https://example.org/x" }),
    undefined,
    true,
  );
  assert.equal(running?.label, "Fetching example.org");
  assert.equal(running?.state, "running");

  const stopped = progressStep(
    call("1", "webfetch", { url: "https://example.org/x" }),
    undefined,
    false,
  );
  assert.equal(stopped?.state, "stopped");
  assert.equal(stopped?.detail, "Stopped before it finished");
});

test("a failure says what went wrong, whether the server sent text or JSON", () => {
  const text = progressStep(
    call("1", "webfetch", { url: "https://example.org" }),
    "error: 503 Service Unavailable",
    true,
  );
  assert.equal(text?.state, "failed");
  assert.equal(text?.label, "Couldn't fetch example.org");
  assert.equal(text?.detail, "503 Service Unavailable");

  const json = progressStep(
    call("2", "create_issue", { title: "Book coach" }),
    '{"error":"Title is required"}',
    true,
  );
  assert.equal(json?.state, "failed");
  assert.equal(json?.label, "Couldn't create the ticket");
  assert.equal(json?.detail, "Title is required");
});

test("reading the workspace's status shows only if it fails", () => {
  assert.equal(progressStep(call("1", "agent_status"), '{"tasks":[],"goals":[]}', true), null);
  assert.equal(progressStep(call("2", "agent_status"), undefined, true), null);
  const failed = progressStep(
    call("3", "agent_status"),
    "error: The workspace is not available",
    true,
  );
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.label, "Couldn't check tasks, goals and ideas");
});

test("the agent's own to-do list is not shown, and an unknown tool still reads plainly", () => {
  assert.equal(progressStep(call("1", "todowrite", { todos: [] }), "ok", true), null);
  assert.equal(progressStep(call("2", "todoread"), "[]", true), null);
  assert.equal(progressStep(call("3", "inspect_pdf"), "ok", true)?.label, "Used inspect pdf");
});

test("arguments that are not JSON, or not an object, do not break a step", () => {
  for (const args of ["", "{", "[1,2]", "null"]) {
    const step = progressStep(
      { id: "1", function: { name: "webfetch", arguments: args } },
      "ok",
      true,
    );
    assert.equal(step?.label, "Fetched a page");
  }
});

test("steps between cards are gathered into lists, in the order they happened", () => {
  const calls = [
    call("a", "read", { filePath: "notes/plan.md" }),
    call("b", "send_file", { path: "a.pdf" }),
    call("c", "webfetch", { url: "https://example.org/news" }),
    call("d", "bash", { command: "date" }),
  ];
  const messages = [result("a", "{}"), result("b", '{"error":"no worker"}'), result("c", "text")];
  const items = progressItems(calls, messages, true);

  assert.deepEqual(
    items.map((item) => item.kind),
    ["steps", "card", "steps"],
  );
  const [first, card, last] = items;
  assert.ok(first.kind === "steps" && first.steps.map((s) => s.label).join() === "Read plan.md");
  assert.ok(card.kind === "card" && card.toolCall.id === "b");
  assert.ok(card.kind === "card" && card.toolMessage?.toolCallId === "b");
  assert.ok(
    last.kind === "steps" &&
      last.steps.map((s) => `${s.state}:${s.label}`).join() ===
        "done:Fetched example.org,running:Running a command",
  );
});

test("a page the browser read is a step with its title, site, text and browser", () => {
  const page = JSON.stringify({
    sessionId: "s1",
    title: "Clairic announced",
    url: "https://www.example.com/news/a",
    text: "Cloudflare announced a new thing.",
  });
  const calls = [
    call("a", "browse_web", { url: "https://www.example.com/news/a" }),
    call("b", "browse_web", { url: "https://blog.example.com/gone" }),
  ];
  const [list] = progressItems(calls, [result("a", page), result("b", '{"error":"404"}')], false);
  assert.ok(list.kind === "steps");
  const [read, missed] = list.steps;
  assert.equal(read.label, "Clairic announced");
  assert.equal(read.detail, "example.com");
  assert.equal(read.output, "Cloudflare announced a new thing.");
  assert.equal(read.browserId, "s1");
  assert.equal(missed.state, "failed");
  assert.equal(missed.label, "Couldn't read blog.example.com");
});

test("lists with nothing said between them become one list, cards stay where they are", () => {
  const a = progressItems([call("a", "bash", { command: "ls" })], [result("a", "x")], false);
  const b = progressItems([call("b", "bash", { command: "pwd" })], [result("b", "y")], false);
  const card = progressItems([call("c", "send_file")], [], false);
  const merged = mergeItems([...a, ...b, ...card, ...a]);
  assert.deepEqual(
    merged.map((item) => item.kind),
    ["steps", "card", "steps"],
  );
  assert.equal(merged[0].kind === "steps" && merged[0].steps.length, 2);
});

test("a message with only cards, or only hidden tools, has no list", () => {
  assert.deepEqual(
    progressItems([call("a", "send_file")], [], true).map((item) => item.kind),
    ["card"],
  );
  assert.deepEqual(progressItems([call("a", "todowrite")], [result("a", "ok")], true), []);
});

test("one line says what is happening now, or how the work went", () => {
  const step = (state: ProgressStep["state"], label = "A step"): ProgressStep => ({
    id: label + state,
    label,
    state,
  });
  assert.equal(
    summarizeSteps([step("done"), step("running", "Fetching example.org")]),
    "Working · Fetching example.org",
  );
  assert.equal(summarizeSteps([step("done")]), "Worked through 1 step");
  assert.equal(
    summarizeSteps([step("done"), step("failed"), step("done")]),
    "Worked through 3 steps · 1 didn't work",
  );
  assert.equal(summarizeSteps([step("done"), step("stopped")]), "Stopped · 2 steps");
});

test("the cards a channel draws are among the tools kept out of the list", () => {
  for (const name of ["present_choices", "request_upload"]) assert.ok(CARD_TOOLS.has(name), name);
});

test("a step that is under way is the one thing that says the agent is working", () => {
  const calls = [call("a", "read", { filePath: "/w/a.md" }), call("b", "bash", { command: "ls" })];
  // The second has not answered yet and the run is going: a step is moving.
  assert.equal(showsRunningStep(progressItems(calls, [result("a", "# a")], true)), true);
  // Everything answered: nothing is moving, so the dots may say it is still thinking.
  assert.equal(
    showsRunningStep(progressItems(calls, [result("a", "# a"), result("b", "x")], true)),
    false,
  );
  // A call that was cut off is stopped, not running.
  assert.equal(showsRunningStep(progressItems(calls, [result("a", "# a")], false)), false);
  // Nothing to show at all, or only hidden tools.
  assert.equal(showsRunningStep([]), false);
  assert.equal(showsRunningStep(progressItems([call("c", "todowrite")], [], true)), false);
});

test("how long the agent worked is said in words", () => {
  assert.equal(formatElapsed(12_000), "12 seconds");
  assert.equal(formatElapsed(1_000), "1 second");
  assert.equal(formatElapsed(60_000), "1 minute");
  assert.equal(formatElapsed(3 * 60_000 + 20_000), "3 minutes");
  assert.equal(formatElapsed(65 * 60_000), "1 hour 5 minutes");
  assert.equal(formatElapsed(2 * 3600_000), "2 hours");
});

test("a finished run says how long it took when that is known and worth saying", () => {
  const step = (state: "done" | "failed" | "running", label = "A step") => ({
    id: `${state}-${label}`,
    label,
    state,
  });
  assert.equal(summarizeSteps([step("done")], 3 * 60_000), "Worked for 3 minutes");
  assert.equal(summarizeSteps([step("done")], 2_000), "Worked through 1 step");
  assert.equal(summarizeSteps([step("done")]), "Worked through 1 step");
  assert.equal(
    summarizeSteps([step("done"), step("failed")], 90_000),
    "Worked for 2 minutes · 1 didn't work",
  );
  assert.equal(
    summarizeSteps([step("done"), step("running", "Fetching example.org")], 90_000),
    "Working · Fetching example.org",
  );
});

test("a page step carries the picture that was kept of it", () => {
  const page = JSON.stringify({
    sessionId: "s1",
    title: "A page",
    url: "https://example.com/a",
    text: "hello",
    shot: "11111111-2222-3333-4444-555555555555",
  });
  const step = progressStep(call("a", "browse_web", { url: "https://example.com/a" }), page, false);
  assert.equal(step?.shot, "11111111-2222-3333-4444-555555555555");
});

test("a tool shown as running when the run started again after it is cut off, and one still going is not", () => {
  const tool = (id: string, toolState: string) => ({ id, kind: "tool", title: "bash", toolState });
  const status = (id: string, title: string) => ({ id, kind: "status", title });
  const cut = interruptedTools([
    status("s1", "Started working"),
    tool("t1", "running"),
    tool("t2", "completed"),
    status("s2", "Resumed work"),
    tool("t3", "running"),
  ]);
  assert.deepEqual([...cut], ["t1"]);
});
