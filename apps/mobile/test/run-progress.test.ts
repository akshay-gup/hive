import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CARD_TOOLS,
  formatElapsed,
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
    call("b", "browse_web", { url: "https://example.org" }),
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

test("the chat draws a card for exactly the tools that are kept out of the list", () => {
  const source = readFileSync(new URL("../src/chat.tsx", import.meta.url).pathname, "utf8");
  const drawn = [...source.matchAll(/useRenderTool\(\{\s*name: "([a-z_]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...drawn].sort(), [...CARD_TOOLS].sort());
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
