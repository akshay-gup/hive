import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseTaskOutcome,
  planFromTodos,
  TaskTextCollector,
} from "../apps/server/src/opencode/index.ts";

function partUpdated(messageID: string, text: string, synthetic = false) {
  return {
    id: `evt-${messageID}`,
    type: "message.part.updated",
    properties: {
      sessionID: "ses-1",
      part: { id: `part-${messageID}`, messageID, type: "text", synthetic, text },
    },
  };
}

function delta(messageID: string, text: string) {
  return {
    id: `evt-d-${messageID}`,
    type: "message.part.delta",
    properties: { sessionID: "ses-1", messageID, partID: `part-${messageID}`, delta: text },
  };
}

test("collector prefers snapshots and preserves message order", () => {
  const collector = new TaskTextCollector();
  collector.handle(partUpdated("m1", "hello "));
  collector.handle(delta("m1", "ignored after snapshot"));
  collector.handle({
    id: "mu",
    type: "message.updated",
    properties: { sessionID: "ses-1", info: { id: "m2", role: "assistant" } },
  });
  collector.handle(delta("m2", "streamed"));
  collector.handle(delta("m2", " text"));
  collector.handle(partUpdated("m3", "final"));
  assert.equal(collector.text(), "hello \n\nstreamed text\n\nfinal");
});

test("collector ignores synthetic parts and non-assistant deltas", () => {
  const collector = new TaskTextCollector();
  collector.handle(partUpdated("ctx", "[hive context] hidden", true));
  collector.handle(delta("user-msg", "user words"));
  collector.handle(partUpdated("m1", "visible"));
  assert.equal(collector.text(), "visible");
});

test("collector handles non-text parts without throwing", () => {
  const collector = new TaskTextCollector();
  collector.handle({
    id: "tool",
    type: "message.part.updated",
    properties: {
      sessionID: "ses-1",
      part: { id: "p1", messageID: "m1", type: "tool", callID: "c1", tool: "bash" },
    },
  });
  collector.handle({ id: "x", type: "session.status", properties: { sessionID: "ses-1" } });
  assert.equal(collector.text(), "");
});

test("parseTaskOutcome reads the last marker", () => {
  const text = [
    "Working on it.",
    "TASK_COMPLETE: first attempt summary",
    "Actually more to do.",
    "TASK_COMPLETE: final summary of the work",
  ].join("\n");
  assert.deepEqual(parseTaskOutcome(text), {
    kind: "complete",
    summary: "final summary of the work",
  });
});

test("parseTaskOutcome reads blocked markers", () => {
  assert.deepEqual(parseTaskOutcome("Stuck.\nTASK_BLOCKED: which account should I use?"), {
    kind: "blocked",
    question: "which account should I use?",
  });
});

test("parseTaskOutcome returns null without markers", () => {
  assert.equal(parseTaskOutcome("Just some text."), null);
  assert.equal(parseTaskOutcome("TASK_COMPLETE:"), null);
  assert.equal(parseTaskOutcome(""), null);
});

test("an approved-tool waiting outcome takes precedence over agent completion text", async () => {
  const { runOpencodeTask } = await import("../apps/server/src/opencode/tasks.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(`${tmpdir()}/hive-worker-tools-`);
  let listener: (event: unknown) => void = () => {};
  const task = {
    id: "task-test",
    title: "Review event",
    prompt: "Create event",
    state: {},
    evidence: [],
    artifactIds: [],
  };
  const client = {
    session: {
      create: async () => ({ data: { id: "ses-1" } }),
      promptAsync: async () => {
        listener(partUpdated("msg-1", "HIVE_TASK_COMPLETE: Done"));
        listener({ type: "session.idle", properties: {} });
        return {};
      },
    },
  };
  try {
    const result = await runOpencodeTask(
      {
        config: { dataDir: directory },
        pool: { forDirectory: () => client },
        tracker: {},
        bus: {
          track: () => {},
          onEvent: (_scope: string, next: (event: unknown) => void) => {
            listener = next;
            return () => {};
          },
          waitForConnection: async () => {},
          enqueue: async (_scope: string, action: () => unknown) => action(),
        },
      } as never,
      {
        db: {
          get: async () => null,
          list: async () => [],
          put: async (_o: string, _k: string, v: unknown) => v,
        },
        prepareBrief: async (_owner: string, claimed: unknown) => ({
          task: claimed,
          files: [],
          names: new Map(),
          text: "",
          noteIds: [],
        }),
        markNotesDelivered: async () => {},
        pendingUpdate: async () => null,
        finish: async () => {
          assert.fail("Must not finish an action awaiting review");
        },
        submitForReview: async () => {
          assert.fail("Must not hand in work while an action awaits review");
        },
      } as never,
      "owner",
      task as never,
      {
        signal: new AbortController().signal,
        event: async () => {},
        checkpoint: async () => {
          assert.fail("Must not overwrite the tool's checkpoint");
        },
      } as never,
      [],
      {
        task: () => task as never,
        outcome: () => ({ status: "waiting_approval", actionId: "review-1" }),
      },
    );
    assert.deepEqual(result, { status: "waiting_approval", actionId: "review-1" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the agent's todo list becomes the plan: its words and order, with dropped items left out", () => {
  assert.deepEqual(
    planFromTodos([
      { content: " Read the brief ", status: "completed", priority: "high" },
      { content: "Draft the reply", status: "in_progress", priority: "medium" },
      { content: "Ask for sign-off", status: "pending", priority: "low" },
      { content: "Tidy the folder", status: "cancelled", priority: "low" },
    ]),
    [
      { id: "0", title: "Read the brief", status: "succeeded" },
      { id: "1", title: "Draft the reply", status: "running" },
      { id: "2", title: "Ask for sign-off", status: "pending" },
    ],
  );
});

test("a todo list that is missing, empty or malformed is no plan", () => {
  for (const todos of [
    undefined,
    null,
    "steps",
    {},
    [],
    [null, {}, { content: "  " }, { content: 4, status: "pending" }],
  ])
    assert.deepEqual(planFromTodos(todos), []);
});

test("a long list is cut to what can be read at a glance, and a long item to a line", () => {
  const plan = planFromTodos(
    Array.from({ length: 40 }, () => ({ content: "x".repeat(500), status: "pending" })),
  );
  assert.equal(plan.length, 30);
  assert.equal(plan[0].title.length, 200);
});
