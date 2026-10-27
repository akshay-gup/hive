import { createHash, randomUUID } from "node:crypto";
import type { Board, WorkClient } from "../../apps/server/src/chat-runner/work-link.ts";
import type { Store } from "../../apps/server/src/db.ts";
import type { AgentService } from "../../apps/server/src/engine/service.ts";
import { inspectAttachment } from "../../apps/server/src/engine/task-files.ts";
import { AppError } from "../../packages/chat-core/src/errors.ts";
import {
  type AgentTask,
  createTaskSchema,
  GENERAL_PROJECT_ID,
  ORCHESTRATOR_CHANNEL_ID,
  type RunEvent,
  type TaskAttachment,
  type TaskNote,
} from "../../packages/domain/src/agent.ts";

/**
 * A task as the machine holds it while it works one the chat service lent it: the copy the worker runs. The
 * board's own rules (who may make a task, in which project) are the chat service's and are tested there;
 * these tests are about what the machine does with a task it has.
 */
export async function localTask(
  service: AgentService,
  owner: string,
  raw: unknown,
  idempotencyKey?: string,
  held = false,
): Promise<AgentTask> {
  const input = createTaskSchema.parse(raw);
  if (input.startAt && input.dueAt && input.startAt > input.dueAt)
    throw new AppError("startAt must not be after dueAt", 422);
  const id = idempotencyKey
    ? createHash("sha256").update(`task:${idempotencyKey}`).digest("hex")
    : randomUUID();
  const existing = await service.db.get<AgentTask>(owner, "tasks", id);
  if (existing) return existing;
  const channelId = input.channelId ?? ORCHESTRATOR_CHANNEL_ID;
  const titles =
    input.kind === "document"
      ? [
          "Find the source document",
          "Fill a new copy",
          "Prepare a reply",
          "Wait for your decision",
          "Record the outcome",
        ]
      : input.kind === "monitor"
        ? ["Check the source", "Compare with the last observation", "Report a meaningful change"]
        : input.kind === "finance"
          ? ["Validate transactions", "Calculate the summary", "Save your tracker"]
          : [];
  const now = new Date().toISOString();
  await service.ensure(owner);
  const task: AgentTask = {
    id,
    title: input.title ?? input.prompt?.slice(0, 90) ?? "Untitled task",
    prompt: input.prompt ?? "",
    kind: input.kind,
    goalId: input.goalId,
    projectId: input.projectId ?? GENERAL_PROJECT_ID,
    priority: input.priority,
    startAt: input.startAt ?? null,
    dueAt: input.dueAt ?? null,
    blockedBy: input.blockedBy,
    labels: input.labels,
    channelId,
    originChannelId: channelId,
    delegatedTo: null,
    threadId: input.threadId,
    createdBy: owner,
    status: held ? "paused" : "queued",
    plan: titles.map((title, i) => ({ id: String(i), title, status: "pending" as const })),
    evidence: [],
    input: input.input,
    state: {
      connectionId: (await service.workspace.connection(owner))?.id ?? null,
      ...(held && input.kind === "monitor" ? { initializingMonitor: true } : {}),
    },
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
  };
  await service.db.insertIfAbsent(owner, "tasks", task);
  return (await service.db.get<AgentTask>(owner, "tasks", id)) ?? task;
}

/** What a task's runs wrote as they went, oldest first. */
export async function eventsOf(db: Store, owner: string, taskId: string): Promise<RunEvent[]> {
  return (await db.listWhere<RunEvent>(owner, "run-events", "taskId", taskId)).sort(
    (a, b) => a.date.localeCompare(b.date) || (a.sequence ?? 0) - (b.sequence ?? 0),
  );
}

/** A task with what its runs wrote and made, as the app was once sent it. */
export async function detailOf(service: AgentService, owner: string, id: string) {
  const task = await service.getTask(owner, id);
  const history = await service.history({
    taskId: id,
    viewer: owner,
    fileIds: task.artifactIds,
    browserIds: [],
  });
  return { task, ...history };
}

/** What the chat service does when a person pauses, resumes or stops a task, for a task the machine holds. */
export async function controlLocal(
  service: AgentService,
  owner: string,
  id: string,
  action: "pause" | "resume" | "cancel" | "retry",
) {
  const task = await service.getTask(owner, id);
  const status =
    action === "cancel"
      ? "cancelled"
      : action === "pause"
        ? "paused"
        : task.actionId
          ? "waiting_approval"
          : "queued";
  return service.db.put(owner, "tasks", {
    ...task,
    status,
    leaseId: null,
    leaseUntil: null,
    error: undefined,
    // A watch started again counts its failures afresh.
    ...(task.kind === "monitor" && (action === "resume" || action === "retry")
      ? { state: { ...task.state, failures: 0, notice: null, initializingMonitor: false } }
      : {}),
  } as AgentTask);
}

/** What the chat service does when a person answers a question a task is waiting on. */
export async function answerLocal(
  service: AgentService,
  owner: string,
  id: string,
  answer: string,
  fields?: Record<string, string | boolean>,
) {
  await localNote(service, owner, id, { text: answer, kind: "answer" });
  const task = await service.getTask(owner, id);
  return service.db.put(owner, "tasks", {
    ...task,
    status: "queued" as const,
    question: undefined,
    input: { ...task.input, ...(fields ? { fields } : {}) },
  });
}

/** A person marked finished work done (the chat service does that; the machine is told of it). */
export async function markDone(service: AgentService, owner: string, id: string) {
  const task = await service.getTask(owner, id);
  if (task.status !== "in_review")
    throw new Error("Only work that is ready for review can be marked done");
  const done = await service.db.put(owner, "tasks", { ...task, status: "succeeded" as const });
  await service.outcome(done);
  return done;
}

/** A note a person wrote while the machine works the task: the room sends it, and the copy takes it. */
export async function localNote(
  service: AgentService,
  owner: string,
  id: string,
  input: { text: string; kind?: TaskNote["kind"] },
): Promise<TaskNote> {
  const note: TaskNote = {
    id: randomUUID(),
    text: input.text,
    kind: input.kind ?? "note",
    createdAt: new Date().toISOString(),
    createdBy: owner,
    delivered: false,
  };
  await service.db.appendItem(owner, "tasks", id, "notes", note);
  return note;
}

/** A file a person attached while the machine works the task: fetched, checked and kept for the run. */
export async function localFile(
  service: AgentService,
  owner: string,
  id: string,
  upload: { name: string; bytes: Uint8Array },
): Promise<TaskAttachment> {
  const checked = inspectAttachment(upload.name, upload.bytes);
  const attachment: TaskAttachment = {
    id: randomUUID(),
    name: checked.name,
    mimeType: checked.mimeType,
    size: upload.bytes.length,
    addedAt: new Date().toISOString(),
    addedBy: owner,
  };
  if (checked.mimeType === "application/pdf")
    attachment.fileId = (
      await service.files.import(owner, checked.name, upload.bytes, "Attached to a task")
    ).id;
  await service.taskFiles.save(id, attachment.id, upload.bytes);
  await service.db.appendItem(owner, "tasks", id, "attachments", attachment);
  return attachment;
}

/**
 * A board for tests of what the machine does with the tasks it holds: every task is visible, and a task's
 * status is whatever the machine's copy says. (Who may see what is the chat service's, and tested there.)
 */
export function localBoard(service: AgentService): Board {
  const client = (owner: string): WorkClient => ({
    call: async (op, args, key) => {
      const taskId = String(args.taskId ?? "");
      switch (op) {
        case "tasks.visible":
          return { ids: args.ids } as never;
        case "task.get":
          return (await service.getTask(owner, taskId)) as never;
        case "task.create": {
          const { held, ...fields } = args;
          return (await localTask(service, owner, fields, key, held === true)) as never;
        }
        case "task.update": {
          const task = await service.getTask(owner, taskId);
          const status = args.status as AgentTask["status"] | undefined;
          return (await service.db.put(owner, "tasks", {
            ...task,
            ...(status ? { status } : {}),
            state: status === "queued" ? { ...task.state, initializingMonitor: false } : task.state,
          })) as never;
        }
        case "task.control":
          return (await controlLocal(
            service,
            owner,
            taskId,
            args.action as "pause" | "resume" | "cancel" | "retry",
          )) as never;
        case "review.decided":
          return {} as never;
        default:
          throw new Error(`The test board does not do ${op}`);
      }
    },
  });
  return { forRun: () => client("local"), forTask: () => client("local"), forPerson: client };
}
