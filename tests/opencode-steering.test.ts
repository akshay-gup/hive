import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { channelWorkspaceDir, diskOwnerForChannel } from "../apps/server/src/engine/threads.ts";
import type { TaskContext } from "../apps/server/src/engine/worker.ts";
import { runOpencodeTask } from "../apps/server/src/opencode/tasks.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import { localBoard, localFile, localNote, localTask } from "./helpers/local-task.ts";

/**
 * The OpenCode task run, against a stand-in for the OpenCode session. These check our side of the
 * conversation: what the agent is told, when it is told more, and what happens to what it says.
 */

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string;
const owner = "local-user";
const text = (value: string) => new TextEncoder().encode(value);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-steering-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  server = await createApp(db, config);
  server.agent.board = localBoard(server.agent);
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

type Prompt = {
  sessionID: string;
  model?: { providerID: string; modelID: string };
  tools?: Record<string, boolean>;
  parts: { type: string; text: string; synthetic?: boolean }[];
};

/** A stand-in OpenCode session: records every prompt, and lets the test play the agent's side. */
function session(
  options: { steer?: { pollMs: number; settleMs: number }; withTools?: boolean } = {},
) {
  const prompts: Prompt[] = [];
  const events: { kind: string; title: string; detail: string }[] = [];
  let listener: (event: unknown) => void = () => {};
  const controller = new AbortController();
  let onPrompt: (prompt: Prompt, index: number) => void | Promise<void> = () => {};
  const emit = (event: Record<string, unknown>) => listener({ id: "e", properties: {}, ...event });
  const say = (messageID: string, words: string) => {
    emit({ type: "message.updated", properties: { info: { id: messageID, role: "assistant" } } });
    emit({
      type: "message.part.updated",
      properties: { part: { id: `p-${messageID}`, messageID, type: "text", text: words } },
    });
  };
  const idle = () => emit({ type: "session.idle" });
  const busy = () => emit({ type: "session.status", properties: { status: { type: "busy" } } });
  const client = {
    session: {
      create: async () => ({ data: { id: "ses-1" } }),
      promptAsync: async (prompt: Prompt) => {
        prompts.push(prompt);
        await onPrompt(prompt, prompts.length);
        return {};
      },
      abort: async () => ({}),
    },
  };
  const runtime = {
    config: { dataDir: directory, model: "anthropic/claude-test" },
    pool: { forDirectory: () => client },
    tracker: { record: () => {}, remove: () => true, rejectAllForScope: async () => 0 },
    bus: {
      track: () => {},
      onEvent: (_scope: string, next: (event: unknown) => void) => {
        listener = next;
        return () => {
          listener = () => {};
        };
      },
      waitForConnection: async () => {},
      enqueue: async (_scope: string, action: () => unknown) => action(),
    },
    ...(options.withTools
      ? {
          hiveTools: {
            connect: async () => ({
              flags: { "hive_*": false, hive_abc_update_task: true },
              instructions: "[tools]",
              release: () => {},
            }),
          },
        }
      : {}),
    steer: options.steer ?? { pollMs: 10, settleMs: 40 },
  };
  return {
    prompts,
    events,
    controller,
    runtime,
    emit,
    say,
    idle,
    busy,
    reply: (handler: typeof onPrompt) => {
      onPrompt = handler;
    },
  };
}

/** Run the task as a worker would: claimed, with a lease, writing to the same row. */
async function run(
  fake: ReturnType<typeof session>,
  task: AgentTask,
  tools: { task?: () => AgentTask; outcome?: () => Partial<AgentTask> | undefined } = {},
  context: Partial<TaskContext> = {},
) {
  let current = task;
  const ctx: TaskContext = {
    signal: fake.controller.signal,
    guard: async () => {},
    checkpoint: async (patch) => {
      current = { ...current, ...patch };
      return current;
    },
    event: async (kind, title, detail = "") => {
      fake.events.push({ kind, title, detail });
    },
    ...context,
  };
  return runOpencodeTask(
    fake.runtime as never,
    server.agent,
    owner,
    task,
    ctx,
    [],
    tools.task || tools.outcome
      ? ({
          task: tools.task ?? (() => current),
          outcome: tools.outcome ?? (() => undefined),
        } as never)
      : undefined,
  );
}

async function newTask(prompt = "Plan the offsite") {
  const created = await localTask(server.agent, owner, { title: "Offsite", prompt });
  return { ...created, status: "running" as const, attempts: 1 };
}

test("the first prompt carries the task, the team's notes and the staged files, and the notes count as read", async () => {
  const task = await newTask();
  await localNote(server.agent, owner, task.id, { text: "Budget is $5k" });
  await localFile(server.agent, owner, task.id, { name: "wish.txt", bytes: text("a lake") });
  const fake = session();
  fake.reply((_prompt, index) => {
    if (index === 1) {
      fake.say("m1", "Done.\nTASK_COMPLETE: Shortlisted two venues");
      fake.idle();
    }
  });
  const result = await run(fake, task);

  assert.equal(fake.prompts.length, 1);
  const [context, prompt] = fake.prompts[0].parts;
  assert.equal(context.synthetic, true);
  assert.match(prompt.text, /Instructions: Plan the offsite/);
  assert.match(prompt.text, /## Notes from the team[\s\S]*Budget is \$5k/);
  assert.match(prompt.text, new RegExp(`attachments/${task.id}/wish\\.txt`));
  assert.match(prompt.text, /You never close a task yourself/);
  assert.deepEqual(fake.prompts[0].model, { providerID: "anthropic", modelID: "claude-test" });
  const workspace = channelWorkspaceDir(
    directory,
    diskOwnerForChannel("orchestrator", owner),
    "orchestrator",
  );
  assert.ok(
    existsSync(join(workspace, "attachments", task.id, "wish.txt")),
    "files are staged in the workspace",
  );
  const saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.notes?.[0].delivered, true);

  // The agent says it is finished; a person decides whether it is.
  assert.equal(result.status, "in_review");
  assert.equal(result.result, "Shortlisted two venues");
  assert.equal(result.state?.unconfirmed, false);
});

test("a run that ends without the completion marker is handed in as unconfirmed", async () => {
  const task = await newTask();
  const fake = session();
  fake.reply(() => {
    fake.say("m1", "I looked at three venues and liked the lake one.");
    fake.idle();
  });
  const result = await run(fake, task);
  assert.equal(result.status, "in_review");
  assert.equal(result.state?.unconfirmed, true);
  assert.match(String(result.result), /liked the lake one/);
  assert.ok(fake.events.some((e) => e.title === "Stopped without saying it was done"));
});

test("a question from the agent still waits for an answer", async () => {
  const task = await newTask();
  const fake = session();
  fake.reply(() => {
    fake.say("m1", "TASK_BLOCKED: Which city?");
    fake.idle();
  });
  assert.deepEqual(await run(fake, task), { status: "waiting_input", question: "Which city?" });
});

test("work the agent hands in through a tool is handed in for review, not done", async () => {
  const task = await newTask();
  const fake = session();
  fake.reply(() => {
    fake.say("m1", "Finished.");
    fake.idle();
  });
  const handedIn = { status: "in_review" as const, result: "From the tool" };
  const result = await run(fake, task, { outcome: () => handedIn });
  assert.equal(result, handedIn);
});

test("our own prompts are not taken for the agent's words", async () => {
  const task = await newTask();
  const fake = session();
  fake.reply(() => {
    // The task prompt comes back as a user message that happens to contain the marker lines.
    fake.emit({ type: "message.updated", properties: { info: { id: "u1", role: "user" } } });
    fake.emit({
      type: "message.part.updated",
      properties: {
        part: { id: "pu", messageID: "u1", type: "text", text: "TASK_COMPLETE: <what you did>" },
      },
    });
    fake.say("m1", "Still working on it.");
    fake.idle();
  });
  const result = await run(fake, task);
  assert.equal(result.state?.unconfirmed, true, "no marker from the agent means unconfirmed");
  assert.ok(!String(result.result).includes("what you did"));
});

test("a note added while the agent works is sent to the same session, with the same model and tools", async () => {
  const task = await newTask();
  const fake = session({ withTools: true });
  fake.reply(async (_prompt, index) => {
    if (index === 1) {
      // The agent is working. Meanwhile the team writes a note and adds a file. Both are on the
      // task before the run first looks, so they arrive as one update.
      await localNote(server.agent, "alice", task.id, { text: "Also check parking" });
      await localFile(server.agent, "alice", task.id, {
        name: "map.txt",
        bytes: text("north gate"),
      });
    }
    if (index === 2) {
      fake.busy();
      setTimeout(() => {
        fake.say("m1", "Checked parking too.\nTASK_COMPLETE: Venue plus parking");
        fake.idle();
      }, 30);
    }
  });
  const result = await run(fake, task);

  assert.equal(fake.prompts.length, 2);
  const [first, update] = fake.prompts;
  assert.equal(update.sessionID, first.sessionID);
  assert.deepEqual(update.model, first.model);
  assert.deepEqual(update.tools, { "hive_*": false, hive_abc_update_task: true });
  assert.deepEqual(update.tools, first.tools);
  assert.match(update.parts[0].text, /\[Update from the team while you work\]/);
  assert.match(update.parts[0].text, /Also check parking/);
  assert.match(
    update.parts[0].text,
    new RegExp(`New file attached: attachments/${task.id}/map\\.txt`),
  );
  assert.match(update.parts[0].text, /Finish with the completion marker/);
  assert.equal(update.parts.length, 1);

  const saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.notes?.[0].delivered, true);
  assert.ok(
    fake.events.some((e) => e.title === "Sent to the agent" && /Also check parking/.test(e.detail)),
  );
  assert.equal(result.status, "in_review");
  assert.equal(result.result, "Venue plus parking");
});

test("a note that arrives as the agent finishes is read before the run is closed out", async () => {
  const task = await newTask();
  // Polling is slow, so only the check after the agent stops can catch the note.
  const fake = session({ steer: { pollMs: 60_000, settleMs: 40 } });
  fake.reply(async (_prompt, index) => {
    if (index === 1) {
      await localNote(server.agent, "alice", task.id, { text: "Make it dog friendly" });
      fake.say("m1", "TASK_COMPLETE: First answer");
      fake.idle();
    }
    if (index === 2) {
      setTimeout(() => {
        fake.busy();
        fake.say("m2", "Made it dog friendly.\nTASK_COMPLETE: Dog friendly answer");
        fake.idle();
      }, 20);
    }
  });
  const result = await run(fake, task);
  assert.equal(fake.prompts.length, 2);
  assert.match(fake.prompts[1].parts[0].text, /Make it dog friendly/);
  assert.equal(result.result, "Dog friendly answer", "the last thing the agent said wins");
  assert.equal((await server.agent.getTask(owner, task.id)).notes?.[0].delivered, true);
});

test("an idle report that lands just after an update is confirmed before the run ends", async () => {
  const task = await newTask();
  const fake = session();
  fake.reply(async (_prompt, index) => {
    if (index === 1) {
      await localNote(server.agent, "alice", task.id, { text: "One more thing" });
      fake.say("m1", "TASK_COMPLETE: First pass");
    }
    if (index === 2) {
      // The session reports idle for the turn that was ending, then the update starts a new one.
      fake.idle();
      setTimeout(() => fake.busy(), 15);
      setTimeout(() => {
        fake.say("m2", "TASK_COMPLETE: Second pass");
        fake.idle();
      }, 90);
    }
  });
  const result = await run(fake, task);
  assert.equal(result.result, "Second pass", "the early idle did not end the run");
});

test("an update the session absorbed before going idle does not hold the run up", async () => {
  const task = await newTask();
  const fake = session();
  fake.reply(async (_prompt, index) => {
    if (index === 1) {
      await localNote(server.agent, "alice", task.id, { text: "Small tweak" });
      fake.say("m1", "TASK_COMPLETE: Done with the tweak");
    }
    if (index === 2) fake.idle(); // taken up in the same turn: nothing else will happen
  });
  const started = Date.now();
  const result = await run(fake, task);
  assert.equal(result.result, "Done with the tweak");
  assert.ok(Date.now() - started < 2_000);
});

test("when an update cannot be sent the note stays unread and the run still ends", async () => {
  const task = await newTask();
  const fake = session({ steer: { pollMs: 60_000, settleMs: 40 } });
  fake.reply(async (_prompt, index) => {
    if (index === 1) {
      await localNote(server.agent, "alice", task.id, { text: "Won't arrive" });
      fake.say("m1", "TASK_COMPLETE: Finished");
      fake.idle();
    }
    if (index === 2) throw new Error("session not found");
  });
  const result = await run(fake, task);
  assert.equal(result.status, "in_review");
  assert.equal(result.result, "Finished");
  assert.equal((await server.agent.getTask(owner, task.id)).notes?.[0].delivered, false);
  assert.ok(
    fake.events.some(
      (e) =>
        e.title === "Could not send an update to the agent" && /session not found/.test(e.detail),
    ),
  );
});

test("stopping the task ends the run at once, even between turns", async () => {
  const task = await newTask();
  const fake = session({ steer: { pollMs: 60_000, settleMs: 40 } });
  fake.reply(async (_prompt, index) => {
    if (index === 1) {
      await localNote(server.agent, "alice", task.id, { text: "A late note" });
      fake.say("m1", "TASK_COMPLETE: First");
      fake.idle();
    }
    // The follow-up for the late note is sent, and then the person stops the task.
    if (index === 2) setTimeout(() => fake.controller.abort(), 10);
  });
  const started = Date.now();
  await assert.rejects(run(fake, task), /Task interrupted/);
  assert.ok(Date.now() - started < 2_000, "did not wait for the run's timeout");
  await sleep(20);
});

const lostLease = async () => {
  throw new Error("Lost lease");
};

test("a run whose transcript cannot be saved fails", async () => {
  const task = await newTask();
  const fake = session();
  fake.reply(() => {
    fake.say("m1", "TASK_COMPLETE: Shortlisted two venues");
    fake.idle();
  });
  await assert.rejects(run(fake, task, {}, { guard: lostLease }), /Lost lease/);
});

test("the error that ended a run is not replaced by a failure to save its transcript", async () => {
  const task = await newTask();
  const fake = session();
  fake.reply(() => {
    fake.say("m1", "Looking into it.");
    fake.emit({
      type: "session.error",
      properties: { error: { name: "APIError", data: { message: "Forbidden: no API key" } } },
    });
  });
  await assert.rejects(run(fake, task, {}, { guard: lostLease }), /Forbidden: no API key/);
});

test("a stopped run says it was stopped, even if its transcript cannot be saved", async () => {
  const task = await newTask();
  const fake = session();
  fake.reply(() => {
    fake.say("m1", "Working on it.");
    setTimeout(() => fake.controller.abort(), 10);
  });
  await assert.rejects(run(fake, task, {}, { guard: lostLease }), /Task interrupted/);
  await sleep(20);
});

test("notes are only sent to a run that is going: nothing is sent once it has ended", async () => {
  const task = await newTask();
  const fake = session();
  fake.reply(() => {
    fake.say("m1", "TASK_COMPLETE: Quick one");
    fake.idle();
  });
  await run(fake, task);
  const sent = fake.prompts.length;
  await localNote(server.agent, "alice", task.id, { text: "After the fact" });
  await sleep(80);
  assert.equal(fake.prompts.length, sent, "no watcher is left polling");
  assert.equal((await server.agent.getTask(owner, task.id)).notes?.[0].delivered, false);
});
