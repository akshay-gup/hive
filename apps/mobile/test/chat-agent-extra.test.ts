import assert from "node:assert/strict";
import { test } from "node:test";
import { agentOnIn, agentView, asksAgent } from "../src/chat-agent-extra.ts";

const call = (id: string, name: string, args: object = {}) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const steps = [
  {
    id: "a1",
    role: "assistant",
    content: "Let me look.",
    toolCalls: [call("c1", "browse_web", { url: "https://example.com" })],
  },
  {
    id: "t1",
    role: "tool",
    toolCallId: "c1",
    content: JSON.stringify({
      title: "Example",
      url: "https://example.com",
      text: "hi",
      sessionId: "b1",
    }),
  },
  { id: "a2", role: "assistant", toolCalls: [call("c2", "create_issue", { title: "x" })] },
];

test("version 2 task choices remain usable after a run ends, and future versions fall back to text", () => {
  const prompt = {
    prompt: { kind: "task_project", id: "request", title: "Proposal", askedBy: "u1" },
    requestId: "room-choice",
  };
  const extra = { v: 2, runId: "r1", askedBy: "u1", status: "done", steps: [], prompts: [prompt] };
  const view = agentView(extra);
  assert.ok(view);
  assert.equal(view.working, false);
  assert.equal(view.prompts[0]?.prompt.kind, "task_project");
  assert.equal(view.segments[0]?.prompts[0]?.prompt.id, "request");
  assert.equal(agentView({ ...extra, v: 3 }), null);
});

test("a run in progress is a view with its steps, the one under way still moving", () => {
  const view = agentView({ v: 1, runId: "r1", askedBy: "u1", status: "working", steps });
  assert.ok(view);
  assert.equal(view.working, true);
  assert.equal(view.queued, false);
  assert.equal(view.askedBy, "u1");
  assert.equal(view.steps.length, 2);
  assert.equal(view.steps[0]?.state, "done");
  assert.equal(view.steps[0]?.label, "Example");
  assert.equal(view.steps[1]?.state, "running");
  assert.equal(view.stepMoving, true);
  assert.equal(view.ended, undefined);
});

test("a run that ended has no moving step, and one that did not end well says why in words", () => {
  const done = agentView({ v: 1, runId: "r1", askedBy: "u1", status: "done", steps });
  assert.equal(done?.working, false);
  assert.equal(done?.steps[1]?.state, "stopped");
  assert.equal(done?.stepMoving, false);
  const stopped = agentView({
    v: 1,
    runId: "r1",
    askedBy: "u1",
    status: "stopped",
    reason: "access",
    steps: [],
  });
  assert.equal(stopped?.ended?.status, "stopped");
  assert.match(stopped?.ended?.text ?? "", /can no longer open this channel/);
  const failed = agentView({ v: 1, runId: "r1", askedBy: "u1", status: "failed", steps: [] });
  assert.equal(failed?.ended?.text, "It did not finish.");
  const user = agentView({
    v: 1,
    runId: "r1",
    askedBy: "u1",
    status: "stopped",
    reason: "user",
    steps: [],
  });
  assert.equal(user?.ended?.text, "Stopped.");
});

test("a queued run says it is waiting", () => {
  const view = agentView({ v: 1, runId: "r1", askedBy: "u1", status: "queued", steps: [] });
  assert.equal(view?.queued, true);
  assert.equal(view?.working, false);
});

test("what the agent asked stays in the order it was asked, and a run waiting is marked so", () => {
  const view = agentView({
    v: 1,
    runId: "r1",
    askedBy: "u1",
    status: "working",
    steps: [],
    prompts: [
      {
        prompt: { kind: "approval", id: "p1", title: "bash: ls" },
        answered: { by: "u2", byName: "Mia", at: "t", choice: { reply: "once" } },
      },
      { prompt: { kind: "question", id: "p2", questions: [] } },
    ],
  });
  assert.deepEqual(
    view?.prompts.map((p) => p.prompt.id),
    ["p1", "p2"],
  );
  assert.equal(view?.waiting, true);
  const answered = agentView({
    v: 1,
    runId: "r1",
    askedBy: "u1",
    status: "working",
    steps: [],
    prompts: [
      {
        prompt: { kind: "approval", id: "p1", title: "x" },
        answered: { by: "u2", byName: "Mia", at: "t", choice: { reply: "reject" } },
      },
    ],
  });
  assert.equal(answered?.waiting, false);
});

test("what is not an agent's record, or is one this app does not know, is not a view", () => {
  for (const extra of [
    null,
    undefined,
    "x",
    3,
    [],
    {},
    { v: 3, runId: "r", status: "done" },
    { v: 1, status: "done" },
    { v: 1, runId: "r", status: "nonsense" },
  ])
    assert.equal(agentView(extra), null);
});

test("a record with junk in its steps still reads, showing what it can", () => {
  const view = agentView({
    v: 1,
    runId: "r1",
    askedBy: "u1",
    status: "done",
    steps: [
      null,
      3,
      "x",
      { role: "assistant", toolCalls: [{ nope: 1 }, "x"] },
      { role: "tool" },
      ...steps,
    ],
    prompts: [null, { prompt: 3 }],
  });
  assert.equal(view?.steps.length, 2);
  assert.deepEqual(view?.prompts, []);
});

test("the agent is on in a public channel unless switched off, in a private one only if switched on, never in a direct message", () => {
  assert.equal(agentOnIn({}), true);
  assert.equal(agentOnIn({ visibility: "public", agent: false }), false);
  assert.equal(agentOnIn({ visibility: "private" }), false);
  assert.equal(agentOnIn({ visibility: "private", agent: true }), true);
  assert.equal(agentOnIn({ kind: "dm", agent: true }), false);
});

test("a message asks for the agent when it names it", () => {
  assert.equal(asksAgent("@hive what is up"), true);
  assert.equal(asksAgent("hello @Hive!"), true);
  assert.equal(asksAgent("hive@example.com"), false);
  assert.equal(asksAgent("@hiver"), false);
  assert.equal(asksAgent("the hive"), false);
});

test("what the agent asked comes up where it was asked: the steps before it, then the ones after", () => {
  const ask = (id: string, steps: number, chars: number, answered = false) => ({
    prompt: { kind: "question", id, questions: [{ header: "h", question: "q", options: [] }] },
    after: { steps, chars },
    ...(answered
      ? { answered: { by: "u1", byName: "Max", at: "", choice: { dismiss: true } } }
      : {}),
  });
  const view = agentView({
    v: 1,
    runId: "r1",
    askedBy: "u1",
    status: "working",
    steps,
    prompts: [ask("p2", 3, 40), ask("p1", 2, 10, true)],
  });
  assert.ok(view);
  assert.equal(view.segments.length, 3);
  // The one asked after two steps comes before the one asked after three, whatever order they were kept in.
  assert.deepEqual(
    view.segments.map((s) => s.prompts.map((p) => p.prompt.id)),
    [["p1"], ["p2"], []],
  );
  assert.deepEqual(
    view.segments.map((s) => s.endsAt),
    [10, 40, null],
  );
  assert.deepEqual(
    view.segments.map((s) => s.steps.length),
    [1, 1, 0],
    "the web page before the first question, the issue before the second",
  );
});

test("a question that does not say where it was asked goes after everything", () => {
  const view = agentView({
    v: 1,
    runId: "r1",
    askedBy: "u1",
    status: "working",
    steps,
    prompts: [{ prompt: { kind: "approval", id: "p1", title: "bash" } }],
  });
  assert.equal(view?.segments.length, 1);
  assert.equal(view?.segments[0]?.prompts.length, 1);
  assert.equal(view?.segments[0]?.endsAt, null);
});
