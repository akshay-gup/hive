import { z } from "zod";
import type { AgentTask, TaskAttachment, TaskNote } from "./agent.ts";
import { WATCH_STOP_TEXT, type WatchMode, watchFindingSchema } from "./agent-watch.ts";

/**
 * How the agent and the chat service talk. The agent's reply to a mention is one message (`author_kind`
 * agent) whose `extra` says how the run is going and what it did; the machine the agent runs on holds a
 * connection to the chat service and trades the frames below over it. The service checks every frame
 * against the run it belongs to, so a frame can only ever change that run's own reply.
 */

export const RUN_STATUS = ["queued", "working", "done", "failed", "stopped"] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

/** Why a run ended as it did, in a word the reply can say in full. */
export const RUN_REASONS = [
  "ok",
  "user",
  "access",
  "timeout",
  "no-runner",
  "lost",
  "busy",
  "limit",
  "dm",
  "disabled",
  "archived",
  "error",
  "watch",
] as const;
export type RunReason = (typeof RUN_REASONS)[number];

/** What an agent's reply says when a run ended without anything to show, in words people read. */
export const REASON_TEXT: Record<RunReason, string> = {
  ok: "",
  user: "Stopped.",
  access: "Stopped, because the person who asked can no longer open this channel.",
  timeout: "This took too long, so it was stopped.",
  "no-runner": "The agent could not be reached. Try again in a minute.",
  lost: "The agent stopped unexpectedly. Mention it again to retry.",
  busy: "The agent is busy with other requests. Try again in a moment.",
  limit: "That is a lot of requests for the agent. Try again in a few minutes.",
  dm: "The agent does not work in direct messages.",
  disabled: "The agent is not switched on in this channel. A channel manager can switch it on.",
  archived: "This channel is archived.",
  error: "Something went wrong, so the agent stopped.",
  watch: WATCH_STOP_TEXT,
};

const text = (max: number) => z.string().max(max);

/** One question the agent asks, as the app shows it (the same shape the old question card took). */
export const askedQuestionSchema = z.object({
  header: text(200),
  question: text(2000),
  options: z.array(z.object({ label: text(200), description: text(500) })).max(12),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional(),
});

/** What the agent is waiting for people to decide: to be allowed to do something, or an answer. */
export const promptSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    id: text(100),
    /** What it wants to do, in a line (a command, a file). */
    title: text(300),
    detail: text(4000).optional(),
    tool: text(100).optional(),
  }),
  z.object({
    kind: z.literal("question"),
    id: text(100),
    questions: z.array(askedQuestionSchema).min(1).max(8),
  }),
]);
export type RunPrompt = z.infer<typeof promptSchema>;

/** What a person chose for a prompt. */
export const choiceSchema = z.union([
  z.object({ reply: z.enum(["once", "reject"]) }),
  z.object({ answers: z.array(z.array(text(2000)).max(20)).max(8) }),
  z.object({ dismiss: z.literal(true) }),
]);
export type PromptChoice = z.infer<typeof choiceSchema>;

/** Where in the reply a prompt was asked: how many steps and how many letters of its words came before it. */
export const promptPlaceSchema = z.object({
  steps: z.number().int().min(0).max(10_000),
  chars: z.number().int().min(0).max(100_000),
});
export type PromptPlace = z.infer<typeof promptPlaceSchema>;

export interface PromptState {
  prompt: RunPrompt;
  /** Where in the reply it was asked, so the app shows it where it came up. */
  after?: PromptPlace;
  /** What the machine will answer with. Kept by the room; never sent to the app. */
  requestId?: string;
  /** When it was asked, which is when the wait for an answer starts. */
  askedAt?: string;
  /** Filled in by the room when someone answers. */
  answered?: { by: string; byName: string; at: string; choice: PromptChoice };
}

/** The most `extra` of an agent's reply may weigh once written down. */
export const MAX_EXTRA_BYTES = 256 * 1024;

/**
 * `extra` of an agent's message. `steps` are the run's messages as the old chat kept them (assistant text,
 * tool calls and what came back), which the app already knows how to show. The room writes `status`,
 * `reason` and `prompts` itself; whatever the machine says of those is not taken.
 */
export interface AgentExtra {
  v: 1;
  runId: string;
  /** Who asked (their id), for who may stop it. */
  askedBy: string;
  status: RunStatus;
  reason?: RunReason;
  steps: unknown[];
  prompts?: PromptState[];
}

export const stepsSchema = z.array(z.unknown()).max(600);

/** What the machine says to the room (untrusted: every field is checked). */
/** A task the machine holds, and the lease it was given it under: every frame about the task names both. */
export const taskLeaseSchema = z.object({ taskId: text(100), leaseId: text(100) });
export type TaskLease = z.infer<typeof taskLeaseSchema>;

/** The most a report of progress on a task may weigh once written down. */
export const MAX_TASK_PATCH_BYTES = 200_000;
const taskPatchSchema = z
  .record(z.string(), z.unknown())
  .refine((patch) => JSON.stringify(patch).length <= MAX_TASK_PATCH_BYTES, "Too much at once");

/** What the agent can do to the board (see `work.call`). */
export const WORK_OPS = [
  "task.create",
  "task.update",
  "task.delete",
  "project.create",
  "project.update",
  "project.delete",
  "board",
  /** One task, as the person may see it. */
  "task.get",
  /** Pause, resume, cancel or retry a task. */
  "task.control",
  /** Which of these task ids the person may see (the machine holds things that name tasks, and shows only those). */
  "tasks.visible",
  /** A review the agent prepared for a task has been decided: the task is to carry on. */
  "review.decided",
  /** Routines: a note the agent writes to itself and a time; made, listed, changed, removed, and the memo the run that one woke keeps. */
  "routine.create",
  "routine.list",
  "routine.update",
  "routine.remove",
  "routine.memo",
  /** Goals: made, changed (pausing one pauses its tasks the person may work on), and listed as the person may see them. */
  "goal.create",
  "goal.update",
  "goal.list",
] as const;
export type WorkOp = (typeof WORK_OPS)[number];

export const runnerFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    v: z.number().int(),
    identity: z
      .object({
        name: text(80),
        avatar: z.enum(["sky", "sand", "lilac"]).optional(),
      })
      .optional(),
    capacity: z
      .object({
        maxRuns: z.number().int().min(1).max(8),
        /** Tasks it works on at once, besides runs. */
        maxTasks: z.number().int().min(1).max(8).optional(),
      })
      .optional(),
    /** The runs it is working on, so the room knows which survived a restart of the room or the machine. */
    active: z.array(z.object({ runId: text(100), n: z.number().int().min(0) })).max(16),
    /** The tasks it holds, by the lease it was given them under. */
    tasks: z.array(taskLeaseSchema).max(16).optional(),
  }),
  z.object({ t: z.literal("renew"), token: text(4000) }),
  z.object({ t: z.literal("run.ack"), runId: text(100) }),
  z.object({
    t: z.literal("run.say"),
    runId: text(100),
    n: z.number().int().min(1),
    body: text(40_000),
    steps: stepsSchema,
  }),
  z.object({
    t: z.literal("run.ask"),
    runId: text(100),
    prompt: promptSchema,
    /** What the machine will answer with, so an answer can be told what it answers. */
    requestId: text(200),
    /** What the reply held when it was asked. */
    after: promptPlaceSchema.optional(),
  }),
  z.object({ t: z.literal("run.asked.done"), runId: text(100), promptId: text(100) }),
  /** The channels the machine keeps something for, to be told which no longer exist. */
  z.object({ t: z.literal("channels.have"), ids: z.array(text(100)).max(1000) }),
  z.object({
    t: z.literal("run.end"),
    runId: text(100),
    n: z.number().int().min(1),
    status: z.enum(["done", "failed", "stopped"]),
    body: text(40_000),
    steps: stepsSchema,
    error: text(500).optional(),
    /** Why a failed run failed, when it was the watch that stopped it. */
    reason: z.literal("watch").optional(),
  }),
  z.object({
    t: z.literal("beat"),
    runIds: z.array(text(100)).max(16),
    /** The tasks it still holds. */
    tasks: z.array(taskLeaseSchema).max(16).optional(),
  }),
  /** The machine has taken the task it was given. */
  z.object({ t: z.literal("task.ack"), ...taskLeaseSchema.shape }),
  /** Progress on a task it holds: fields of the task, laid over it. A field set to null is taken away. */
  z.object({
    t: z.literal("task.checkpoint"),
    ...taskLeaseSchema.shape,
    patch: taskPatchSchema,
  }),
  /**
   * The machine is done with a task it held: `patch` says how it ended (its status among it), or `requeue`
   * says it was cut off and is to be given out again. Said again until the room says it has it.
   */
  z.object({
    t: z.literal("task.end"),
    ...taskLeaseSchema.shape,
    patch: taskPatchSchema,
    requeue: z.boolean().optional(),
    stalled: z.boolean().optional(),
  }),
  /** The agent touched something of the machine's own (see agent-watch.ts); the service says who asked and where. */
  z.object({ t: z.literal("agent.flag"), finding: watchFindingSchema }),
  /** The agent has a file to put in its reply: the room says where to send the bytes. */
  z.object({
    t: z.literal("file.begin"),
    runId: text(100),
    reqId: text(100),
    name: text(500).min(1),
    mime: text(200),
    bytes: z.number().int().positive(),
  }),
  /** The bytes were sent: the room puts the file in the reply. */
  z.object({
    t: z.literal("file.done"),
    runId: text(100),
    reqId: text(100),
    fileId: text(100),
  }),
  /**
   * The agent changes the board, as the person it is working for: a chat run (by `runId`) or a task run (by the
   * task and its lease). The room says who that is and what they may do; the machine names no one.
   */
  z.object({
    t: z.literal("work.call"),
    reqId: text(100),
    runId: text(100).optional(),
    taskId: text(100).optional(),
    leaseId: text(100).optional(),
    /** In the app's own chat with the agent there is no run: the app gives the machine a ticket for the person. */
    ticket: text(2000).optional(),
    op: z.enum(WORK_OPS),
    args: z.record(z.string(), z.unknown()),
    /** The same call said again (a retry) does not do it twice. */
    key: text(200).optional(),
  }),
  /** The machine has done what a finished task calls for (`task.outcome`). */
  z.object({ t: z.literal("task.outcome.done"), taskId: text(100), at: text(100) }),
  /** The answer to something the room asked (`work.ask`). */
  z.object({
    t: z.literal("work.answer"),
    reqId: text(100),
    ok: z.boolean(),
    body: z.unknown().optional(),
    error: text(500).optional(),
  }),
]);
export type RunnerFrame = z.infer<typeof runnerFrameSchema>;

/** What the room says to the machine. */
export interface RunStart {
  id: string;
  attempt: number;
  channel: { id: string; name: string; topic: string; visibility: "public" | "private" };
  /** The message that started it, and the thread it is in (the first message is the thread's root). */
  thread: { rootId: string; messages: ContextMessage[] };
  text: string;
  asker: { id: string; email: string; name: string; role: "owner" | "admin" | "member" | "guest" };
  people: { name: string; handle: string }[];
  /** The files on the message that asked, each to be fetched from the path (on the chat service) for a few minutes. */
  files: { id: string; name: string; mime: string; bytes: number; path: string }[];
  mode: "ask";
  /** Set when a routine woke the agent: which one, and what the agent kept for itself last time. */
  routine?: { id: string; title: string; memo: string };
  /**
   * Set when the run was sent before and its machine restarted: what the reply held then. The agent carries
   * on from there, in the session it already has, and the reply goes on from this.
   */
  resume?: { body: string; steps: unknown[] };
}
export interface ContextMessage {
  id: string;
  author: string;
  kind: "person" | "agent" | "system";
  body: string;
  at: string;
}

/** A task the room hands to the machine to work on, with the person it is worked on for. */
export interface TaskStart {
  task: AgentTask;
  leaseId: string;
  owner: { id: string; email: string; name: string; role: string };
  /** The channel the task is kept in the folder of, when it has one: the machine makes room for it. */
  channel?: { id: string; name: string; topic: string; visibility: "public" | "private" };
}

export type RoomFrame =
  | {
      t: "welcome";
      limits: { maxRunMs: number };
      resume: string[];
      /** The tasks it holds that the room keeps lending it (by lease); any other it lets go of. */
      resumeTasks?: string[];
      watch?: WatchMode;
    }
  | { t: "task.start"; start: TaskStart }
  /** People added notes to a task the machine is working on: the agent is told of them. */
  | { t: "task.note"; taskId: string; leaseId: string; notes: TaskNote[] }
  /** People attached files to a task the machine is working on (each with an address to fetch it from). */
  | { t: "task.files"; taskId: string; leaseId: string; files: TaskAttachment[] }
  /** The task is no longer the machine's to work on (paused, cancelled, or the lease was lost): let go of it. */
  | { t: "task.stop"; taskId: string; leaseId: string }
  /** The room has the end of the task. */
  | { t: "task.ended"; taskId: string; leaseId: string }
  /** The owner changed what is done when the agent is seen opening the machine's own data. */
  | { t: "watch"; mode: WatchMode }
  | { t: "run.start"; run: RunStart }
  | {
      t: "run.answer";
      runId: string;
      promptId: string;
      requestId: string;
      by: string;
      choice: PromptChoice;
    }
  | { t: "run.stop"; runId: string; by: string; reason: "user" | "access" | "timeout" }
  | { t: "ack"; runId: string }
  /** These channels are gone (deleted): what the machine kept for them goes too. */
  | { t: "channels.gone"; ids: string[] }
  /** Where to send a file's bytes: an address on the chat service, good for a few minutes. */
  | { t: "file.upload"; reqId: string; fileId: string; path: string }
  | { t: "file.attached"; reqId: string }
  | { t: "file.refused"; reqId: string; error: string }
  /**
   * A person finished a task (marked it done): what that sets going on the machine (the goal it counts toward,
   * the notice) is done there. Said again, at each connection, until the machine says it is done.
   */
  | { t: "task.outcome"; task: AgentTask }
  /** What a `work.call` came to: the board's answer, or why not. */
  | { t: "work.result"; reqId: string; ok: true; body: unknown }
  | { t: "work.result"; reqId: string; ok: false; error: string; status: number }
  /** The room asks the machine for what only it keeps (a task's run history) for a person who may see the task. */
  | {
      t: "work.ask";
      reqId: string;
      op: "task.history";
      taskId: string;
      viewer: string;
      /** What the task says it made and used, so the machine finds those and nothing else. */
      fileIds: string[];
      browserIds: string[];
    }
  | { t: "closing"; reason: string };
