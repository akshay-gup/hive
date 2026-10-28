import { z } from "zod";
import {
  type Access,
  canOpen,
  managesChannel,
  type Person,
} from "../../../packages/chat-core/src/access.ts";
import type { AgentFlags } from "../../../packages/chat-core/src/agent-flags.ts";
import { agentOn, agentRefusal } from "../../../packages/chat-core/src/agent-trigger.ts";
import { AppError } from "../../../packages/chat-core/src/errors.ts";
import type { Files } from "../../../packages/chat-core/src/files.ts";
import type { Goals } from "../../../packages/chat-core/src/goals.ts";
import type { Ideas } from "../../../packages/chat-core/src/ideas.ts";
import type { Message, Messages } from "../../../packages/chat-core/src/messages.ts";
import { isActive, RUN_LIMITS, type Run, type Runs } from "../../../packages/chat-core/src/runs.ts";
import { SHARED_OWNER } from "../../../packages/chat-core/src/shared.ts";
import type { RecordStore } from "../../../packages/chat-core/src/store.ts";
import type { Tasks } from "../../../packages/chat-core/src/work.ts";
import { TASK_LIMITS } from "../../../packages/chat-core/src/work.ts";
import type { Work } from "../../../packages/chat-core/src/work-rules.ts";
import {
  type AgentTask,
  type Channel,
  ORCHESTRATOR_CHANNEL_ID,
} from "../../../packages/domain/src/agent.ts";
import type { WatchMode } from "../../../packages/domain/src/agent-watch.ts";
import type { ChatMessage } from "../../../packages/domain/src/chat.ts";
import {
  type AgentExtra,
  type ContextMessage,
  MAX_EXTRA_BYTES,
  type PromptChoice,
  REASON_TEXT,
  type RoomFrame,
  type RoutineFireAsk,
  type RunnerFrame,
  type RunReason,
  type RunStart,
  type RunStatus,
  runnerFrameSchema,
  type TaskHistoryAsk,
} from "../../../packages/domain/src/chat-agent.ts";
import { withHandles } from "../../../packages/domain/src/mentions.ts";
import { makeTicket, readTicket, TICKET_MS } from "./board-ticket.ts";
import type { Filing } from "./filing.ts";
import type { Routines } from "./routines.ts";
import { signedPath } from "./uploads.ts";
import type { WorkNotices } from "./work-notices.ts";

/** The agent's machine, as the room can reach it: the one connection it holds. */
export interface RunnerLink {
  send(text: string): void;
  close(code: number, reason: string): void;
}

const statusOf = (run: Run): RunStatus =>
  run.state === "queued" || run.state === "sent"
    ? "queued"
    : run.state === "running"
      ? "working"
      : run.state;

/** How much of a thread, and of the channel before a message of its own, the agent is shown. */
const CONTEXT_CHARS = 24_000;
const CONTEXT_BEFORE = 15;
const CONTEXT_REPLIES = 40;
const CONTEXT_PEOPLE = 50;
/** How long a file's address works for the machine to fetch it. */
const FILE_LINK_MS = 5 * 60_000;
/** The least between two calls for the machine to be woken, and how long that grows to while it does not come. */
const WAKE_EVERY_MS = 30_000;
const WAKE_EVERY_MAX_MS = 10 * 60_000;

export interface AgentLinkDeps {
  store: RecordStore;
  flags: AgentFlags;
  access: Access;
  messages: Messages;
  runs: Runs;
  tasks: Tasks;
  /** The board's rules: what the agent does to it it does as the person it works for. */
  work: Work;
  goals: Goals;
  ideas: Ideas;
  routines: Routines;
  notices: WorkNotices;
  files: Files;
  filing: Filing;
  /** The machine's connection, if there is one. The room may sleep, so this is asked for each time. */
  runner: () => RunnerLink | null;
  /** A message as the app is shown it, with the agent's name on it. */
  show: (message: Message) => Promise<ChatMessage>;
  /** Show a message as it is, to those who may see it: not kept, and no number of its own. */
  stream: (channelId: string, message: ChatMessage) => void;
  /** A message that was changed and kept is announced. */
  edited: (message: ChatMessage) => void;
  /** The person who asked is told the run is over. */
  notifyEnd: (run: Run, reply: Message) => Promise<void>;
  /** The person who asked is told the agent is waiting for them (or anyone) to decide something. */
  notifyAsk: (run: Run, reply: Message) => Promise<void>;
  /** A task the machine holds changed (taken, ended, cut off, or said how far it is): `quiet` for the last. */
  taskTouched: (task: AgentTask, quiet: boolean) => void;
  workspaceId: () => string | null;
  linkKey: () => string | undefined;
  /** Ask for the agent's machine to be started. */
  wake: () => void;
  /** There is work to look at soon (a task came up, or is due later): the room's upkeep is to run. */
  soon: () => void;
  clock: () => number;
}

/**
 * The agent's side of a workspace's chat: what becomes of a mention. A mention makes a run; the run is sent
 * to the machine the agent runs on, which writes the agent's reply as it goes; people answer what the agent
 * asks and can stop it. What a run is lives here, and who may do what is decided here each time, so the
 * machine writes only replies bound to a run that is still going. A source-error report carries only a time;
 * the room chooses its notice text and recipients.
 */
export class AgentLink {
  private maxRuns: number = RUN_LIMITS.defaultMaxRuns;
  private maxTasks: number = TASK_LIMITS.defaultMaxTasks;
  private pumping: Promise<void> = Promise.resolve();
  private lastWake = 0;
  /** Wakes asked for since the machine last connected: each waits longer than the one before. */
  private wakes = 0;
  /** What the room asked the machine for and has no answer to yet. */
  private readonly asking = new Map<
    string,
    {
      resolve: (body: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly deps: AgentLinkDeps) {}

  private send(frame: RoomFrame): boolean {
    const link = this.deps.runner();
    if (!link) return false;
    try {
      link.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** What is done when the agent is seen opening the machine's own data: only marked, or turned down where it can be. */
  async watchMode(): Promise<WatchMode> {
    const kept = await this.deps.store.get<{ id: string; mode?: string }>(
      "system",
      "agent",
      "watch",
    );
    return kept?.mode === "enforce" ? "enforce" : "audit";
  }

  async setWatchMode(mode: WatchMode): Promise<void> {
    await this.deps.store.put("system", "agent", { id: "watch", mode });
    this.send({ t: "watch", mode });
  }

  // What the machine says

  /** A frame that is not understood, or is for a run that is over, changes nothing. */
  async onFrame(text: string): Promise<void> {
    let frame: RunnerFrame;
    try {
      frame = runnerFrameSchema.parse(JSON.parse(text));
    } catch {
      return;
    }
    switch (frame.t) {
      case "hello":
        return this.hello(frame);
      case "run.ack":
        if (this.deps.runs.markRunning(frame.runId)) await this.rewrite(frame.runId, true);
        return;
      case "run.say":
        return this.say(frame);
      case "run.ask": {
        const before = this.deps.runs.get(frame.runId)?.prompts.length ?? 0;
        const run = this.deps.runs.addPrompt(
          frame.runId,
          frame.prompt,
          frame.requestId,
          frame.after,
        );
        if (!run) return;
        await this.rewrite(run.id, true);
        // Told when it is asked, not when the run is over, which may be never if it waits for the answer.
        const reply = run.prompts.length > before ? this.deps.messages.get(run.replyId) : null;
        if (reply && !reply.deletedAt) await this.deps.notifyAsk(run, reply);
        return;
      }
      case "run.asked.done":
        this.deps.runs.closePrompt(frame.runId, frame.promptId);
        return this.rewrite(frame.runId, true);
      case "run.end":
        return this.end(frame);
      case "channels.have":
        return this.channelsHave(frame.ids);
      case "beat":
        this.deps.runs.beat(frame.runIds);
        if (frame.tasks?.length) this.deps.tasks.beat(frame.tasks);
        return;
      case "task.ack":
        if (this.deps.tasks.ack(frame.taskId, frame.leaseId)) return;
        // Not the lease the room holds: the machine is told to let go of it.
        this.send({ t: "task.stop", taskId: frame.taskId, leaseId: frame.leaseId });
        return;
      case "task.checkpoint": {
        const saved = this.deps.tasks.checkpoint(frame.taskId, frame.leaseId, frame.patch);
        if (saved) this.deps.taskTouched(saved, true);
        else this.send({ t: "task.stop", taskId: frame.taskId, leaseId: frame.leaseId });
        return;
      }
      case "task.end":
        return this.taskEnd(frame);
      case "task.outcome.done": {
        const pending = await this.deps.store.get<{ id: string; at: string }>(
          "system",
          "outcomes",
          frame.taskId,
        );
        if (pending?.at === frame.at)
          await this.deps.store.remove("system", "outcomes", frame.taskId);
        return;
      }
      case "work.call":
        return this.workCall(frame);
      case "ideas.batch":
        await this.deps.ideas.receive(frame.batch);
        this.send({ t: "ideas.ack", id: frame.batch.id });
        return;
      case "source.error": {
        const now = this.deps.clock();
        // Old delivery records and clock skew do not let a machine invent unlimited future notices.
        if (frame.at <= now + 60_000 && frame.at >= now - 7 * 24 * 60 * 60_000) {
          const hour = Math.floor(frame.at / 3_600_000);
          for (const [owner, person] of await this.deps.access.byId()) {
            // The shared mailbox is available to the team, not to guests.
            if (person.role === "guest") continue;
            this.deps.notices.tell(owner, {
              key: `source-error:${hour}`,
              kind: "update",
              title: "Mail connection needs attention",
              body: "Reconnect the mail connection or refresh Ideas to see the error.",
            });
          }
        }
        this.send({ t: "source.error.ack", at: frame.at });
        return;
      }
      case "work.answer": {
        const waiting = this.asking.get(frame.reqId);
        if (!waiting) return;
        this.asking.delete(frame.reqId);
        clearTimeout(waiting.timer);
        if (frame.ok) waiting.resolve(frame.body);
        else
          waiting.reject(new AppError(frame.error ?? "The agent's machine could not answer", 502));
        return;
      }
      case "file.begin":
        return this.fileBegin(frame);
      case "file.done":
        return this.fileDone(frame);
      case "agent.flag": {
        // Who asked and where come from the run the room holds, not from what the machine says.
        const run = frame.finding.runId ? this.deps.runs.get(frame.finding.runId) : null;
        if (frame.finding.runId && !run) return;
        this.deps.flags.add(
          crypto.randomUUID(),
          frame.finding,
          run ? { id: run.id, channelId: run.channelId, askedBy: run.askedBy } : null,
        );
        return;
      }
      case "renew":
        return; // The connection's token is the Durable Object's to renew; see room.ts.
    }
  }

  private async hello(frame: Extract<RunnerFrame, { t: "hello" }>) {
    const { runs, tasks, store } = this.deps;
    this.wakes = 0;
    if (frame.capacity) {
      this.maxRuns = frame.capacity.maxRuns;
      this.maxTasks = frame.capacity.maxTasks ?? TASK_LIMITS.defaultMaxTasks;
    }
    if (frame.identity)
      await store.put("system", "agent", {
        id: "identity",
        name: frame.identity.name,
        ...(frame.identity.avatar ? { avatar: frame.identity.avatar } : {}),
      });
    const reported = new Set(frame.active.map((a) => a.runId));
    const keep: string[] = [];
    for (const run of runs.active()) {
      if (run.state === "queued") continue;
      if (reported.has(run.id)) {
        runs.markRunning(run.id);
        keep.push(run.id);
      } else if (run.state === "running") {
        // Its machine restarted and lost it: it is sent again to carry on, and the reply keeps what it had.
        if (runs.restart(run.id)) await this.rewrite(run.id, true);
        else await this.finish(run.id, "failed", "lost", {}, false);
      } else runs.requeue(run.id);
    }
    // A task it still holds goes on; one it lost (it restarted under it) is cut off, and one it never took is given out again.
    const held = new Set((frame.tasks ?? []).map((t) => t.leaseId));
    const keepTasks: string[] = [];
    for (const task of tasks.leased()) {
      if (held.has(task.leaseId)) {
        tasks.ack(task.id, task.leaseId);
        keepTasks.push(task.leaseId);
      } else if (task.acked) tasks.interrupt(task.id, task.leaseId);
      else tasks.end(task.id, task.leaseId, {}, { requeue: true });
    }
    this.send({
      t: "welcome",
      limits: { maxRunMs: RUN_LIMITS.maxRunMs },
      resume: keep,
      resumeTasks: keepTasks,
      watch: await this.watchMode(),
    });
    await this.sendOutcomes();
    await this.pump();
  }

  /** The machine is done with a task, or was cut off. Said again until the room says it has it. */
  private async taskEnd(frame: Extract<RunnerFrame, { t: "task.end" }>) {
    const { tasks } = this.deps;
    const ended = tasks.end(frame.taskId, frame.leaseId, frame.patch, {
      requeue: frame.requeue,
      stalled: frame.stalled,
    });
    if (ended) this.deps.taskTouched(ended, false);
    this.send({ t: "task.ended", taskId: frame.taskId, leaseId: frame.leaseId });
    await this.pump();
    if (this.deps.tasks.nextScheduledMs() !== null) this.deps.soon();
  }

  private async say(frame: Extract<RunnerFrame, { t: "run.say" }>) {
    const taken = this.deps.runs.say(frame.runId, frame.n);
    if (!taken.taken) return;
    await this.write(frame.runId, { body: frame.body, steps: frame.steps }, taken.keep);
  }

  private async end(frame: Extract<RunnerFrame, { t: "run.end" }>) {
    await this.finish(
      frame.runId,
      frame.status,
      frame.status === "failed"
        ? (frame.reason ?? "error")
        : frame.status === "stopped"
          ? "user"
          : "ok",
      { body: frame.body, steps: frame.steps },
      false,
    );
    // Said even if it had already ended here, so the machine can let go of it.
    this.send({ t: "ack", runId: frame.runId });
  }

  // The board, as the agent changes it

  /** What the app hands the machine so the agent can change the board for this person in the app's own chat. */
  boardTicket(userId: string): { ticket: string; expiresAt: number } {
    const key = this.deps.linkKey();
    const workspaceId = this.deps.workspaceId();
    if (!key || !workspaceId) throw new AppError("Tickets are not set up", 503);
    const exp = this.deps.clock() + TICKET_MS;
    return { ticket: makeTicket(key, { workspaceId, userId, exp }), expiresAt: exp };
  }

  /**
   * The agent changes the board. Who it does it as, and in which channel, comes from the run or the task it
   * holds, never from the frame: it can do what that person could do, and nothing of anyone else's.
   */
  private async workCall(frame: Extract<RunnerFrame, { t: "work.call" }>) {
    const { runs, tasks, work, goals, routines } = this.deps;
    const refuse = (error: string, status: number) =>
      void this.send({ t: "work.result", reqId: frame.reqId, ok: false, error, status });
    let actor: string;
    let channelId: string | undefined;
    let run: Run | null = null;
    if (frame.runId) {
      run = runs.get(frame.runId);
      if (!run || !isActive(run)) return refuse("This run is over", 409);
      actor = run.askedBy;
      channelId = run.channelId;
    } else if (frame.ticket) {
      const key = this.deps.linkKey();
      const workspace = this.deps.workspaceId();
      const who =
        key && workspace ? readTicket(key, workspace, frame.ticket, this.deps.clock()) : null;
      if (!who) return refuse("Open the app again to let the agent change the board", 401);
      actor = who;
    } else {
      const task = frame.taskId ? tasks.get(frame.taskId) : null;
      if (!task || !frame.leaseId || task.leaseId !== frame.leaseId || !task.createdBy)
        return refuse("This task is not being worked on", 409);
      actor = task.createdBy;
      channelId = task.originChannelId ?? task.channelId;
    }
    const args = frame.args;
    const home: { channelId?: string } =
      channelId && channelId !== ORCHESTRATOR_CHANNEL_ID ? { channelId } : {};
    try {
      let body: unknown;
      switch (frame.op) {
        case "task.create":
          {
            const { held, ...fields } = args;
            body = await work.createTask(
              actor,
              { ...fields, ...home },
              { key: frame.key, held: held === true },
            );
          }
          break;
        case "task.update": {
          const { taskId, ...patch } = args;
          body = await work.updateTask(actor, String(taskId ?? ""), patch, "agent");
          break;
        }
        case "task.delete":
          body = await work.deleteTask(actor, String(args.taskId ?? ""));
          break;
        case "project.create":
          body = await work.createProject(actor, args);
          break;
        case "project.update": {
          const { projectId, ...patch } = args;
          body = await work.updateProject(actor, String(projectId ?? ""), patch);
          break;
        }
        case "project.delete":
          body = await work.deleteProject(actor, String(args.projectId ?? ""));
          break;
        case "task.get":
          body = (
            await work.present(actor, [await work.getTask(actor, String(args.taskId ?? ""))])
          )[0];
          break;
        case "task.control":
          body = await work.control(
            actor,
            String(args.taskId ?? ""),
            z.enum(["pause", "resume", "cancel", "retry"]).parse(args.action),
          );
          break;
        case "tasks.visible":
          body = {
            ids: await work.visibleIds(
              actor,
              z
                .array(z.string().max(100))
                .max(500)
                .parse(args.ids ?? []),
            ),
          };
          break;
        case "routine.create":
          body = await routines.create(actor, args, {
            ...home,
            ...(run ? { rootId: run.rootId } : {}),
          });
          break;
        case "routine.list":
          body = { routines: await routines.list(actor) };
          break;
        case "routine.update": {
          const { routineId, ...patch } = args;
          body = await routines.update(actor, String(routineId ?? ""), patch);
          break;
        }
        case "routine.remove":
          body = await routines.remove(actor, String(args.routineId ?? ""));
          break;
        case "routine.hook":
          body = await routines.hookOn(actor, String(args.routineId ?? ""), args.change === true);
          break;
        case "routine.memo": {
          const memo = z
            .string()
            .max(4000)
            .parse(args.memo ?? "");
          body = run
            ? await routines.setMemo(run.id, run.triggerId, memo)
            : await routines.setMemoFor(actor, String(args.routineId ?? ""), memo);
          break;
        }
        case "goal.create":
          body = await goals.create(actor, args, {
            ...home,
            ...(frame.key ? { id: `goal:${frame.key}`.slice(0, 120) } : {}),
          });
          break;
        case "goal.update": {
          const { goalId, ...patch } = args;
          body = await goals.update(actor, String(goalId ?? ""), patch);
          break;
        }
        case "goal.list":
          body = { goals: await goals.list(actor) };
          break;
        case "review.decided":
          body = await work.reviewDecided(
            actor,
            String(args.taskId ?? ""),
            String(args.actionId ?? ""),
          );
          break;
        case "board":
          body = {
            tasks: await work.tasksFor(actor),
            projects: await work.projectsFor(actor),
            goals: await goals.list(actor),
            ideas: await this.deps.ideas.list(actor),
          };
          break;
      }
      this.send({ t: "work.result", reqId: frame.reqId, ok: true, body });
    } catch (error) {
      if (error instanceof AppError) refuse(error.message, error.status);
      else refuse("The board could not do that", 500);
    }
  }

  /**
   * Ask the machine for what only it keeps about a task (its run history) on behalf of a person the room
   * has already checked may see the task. Fails if the machine is not connected or does not answer.
   */
  askMachine(task: AgentTask, viewer: string, ms = 15_000): Promise<unknown> {
    const browserIds = [task.state?.browserId, task.state?.sessionId].filter(
      (id): id is string => typeof id === "string",
    );
    return this.askRaw(
      {
        op: "task.history",
        taskId: task.id,
        viewer,
        fileIds: task.artifactIds ?? [],
        browserIds,
      },
      ms,
    );
  }

  private askRaw(what: TaskHistoryAsk | RoutineFireAsk, ms: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const reqId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.asking.delete(reqId);
        reject(new AppError("The agent's machine did not answer", 503));
      }, ms);
      this.asking.set(reqId, { resolve, reject, timer });
      if (!this.send({ t: "work.ask", reqId, ...what })) {
        this.asking.delete(reqId);
        clearTimeout(timer);
        reject(new AppError("The agent's machine is asleep", 503));
      }
    });
  }

  /**
   * Wake the agent in a person's own chat for a routine of theirs, which only the machine can do (that chat is
   * kept there). "later" when the machine is not here: it is woken, and the routine tries again soon.
   */
  async fireOwnRoutine(
    owner: string,
    routine: { id: string; title: string; note: string; memo: string },
  ): Promise<"sent" | "later" | "failed"> {
    if (!this.deps.runner()) {
      this.wakeMachine();
      return "later";
    }
    const person = await this.deps.access.person(owner);
    if (!person) return "failed";
    try {
      await this.askRaw(
        {
          op: "routine.fire",
          routine,
          owner: {
            id: owner,
            email: person.email,
            name: person.name,
            role: person.role ?? "member",
          },
          ticket: this.boardTicket(owner).ticket,
        },
        20_000,
      );
      return "sent";
    } catch {
      return "failed";
    }
  }

  // Files the agent puts in its reply

  /** The agent may send a file for a run that is going, as the person who asked would: their rights, their room. */
  private async fileBegin(frame: Extract<RunnerFrame, { t: "file.begin" }>) {
    const refuse = (error: string) =>
      void this.send({ t: "file.refused", reqId: frame.reqId, error });
    const run = this.deps.runs.get(frame.runId);
    const workspace = this.deps.workspaceId();
    if (!run || !isActive(run) || !workspace) return refuse("This run is over");
    const have = this.deps.files.ofMessages([run.replyId]).get(run.replyId)?.length ?? 0;
    if (have >= RUN_LIMITS.filesPerRun)
      return refuse(`At most ${RUN_LIMITS.filesPerRun} files go in one reply`);
    try {
      const begun = await this.deps.filing.begin(run.askedBy, workspace, {
        channelId: run.channelId,
        name: frame.name,
        mime: frame.mime || "application/octet-stream",
        bytes: frame.bytes,
      });
      this.send({
        t: "file.upload",
        reqId: frame.reqId,
        fileId: begun.fileId,
        path: `/w/${workspace}${begun.upload}`,
      });
    } catch (error) {
      refuse(error instanceof AppError ? error.message : "The file could not be sent");
    }
  }

  private async fileDone(frame: Extract<RunnerFrame, { t: "file.done" }>) {
    const refuse = (error: string) =>
      void this.send({ t: "file.refused", reqId: frame.reqId, error });
    const { runs, files, messages } = this.deps;
    const run = runs.get(frame.runId);
    if (!run || !isActive(run)) return refuse("This run is over");
    const file = files.get(frame.fileId);
    // Only a file this run was given room for, by the person who asked, in this channel, and still unattached.
    if (
      !file ||
      file.state !== "ready" ||
      file.uploaderId !== run.askedBy ||
      file.channelId !== run.channelId ||
      file.messageId
    )
      return refuse("That file did not arrive");
    const reply = messages.get(run.replyId);
    if (!reply || reply.deletedAt) return refuse("The reply is gone");
    try {
      files.attach([file.id], reply.id, run.channelId, run.askedBy);
    } catch (error) {
      return refuse(error instanceof AppError ? error.message : "The file could not be added");
    }
    this.deps.edited(await this.deps.show(messages.get(reply.id) as Message));
    this.send({ t: "file.attached", reqId: frame.reqId });
  }

  // The reply message

  /** `extra` of a run's reply: the room's own words on how it is going, with what the run did. */
  private extraFor(run: Run, steps: unknown[]): AgentExtra {
    return {
      v: 1,
      runId: run.id,
      askedBy: run.askedBy,
      status: statusOf(run),
      ...(run.reason && run.reason !== "ok" ? { reason: run.reason } : {}),
      steps,
      ...(run.prompts.length ? { prompts: run.prompts } : {}),
    };
  }

  /** Write the run's reply: kept, or only shown. The room makes `extra`'s status and prompts itself. */
  private async write(
    runId: string,
    change: { body?: string; steps?: unknown[] },
    keep: boolean,
  ): Promise<void> {
    const { messages, runs } = this.deps;
    const run = runs.get(runId);
    const message = run && messages.get(run.replyId);
    if (!run || !message || message.deletedAt) return;
    const before = message.extra as Partial<AgentExtra> | null;
    let extra = this.extraFor(run, change.steps ?? before?.steps ?? []);
    if (JSON.stringify(extra).length > MAX_EXTRA_BYTES) {
      // Too much to keep: the latest of what it did is what matters.
      extra = this.extraFor(run, extra.steps.slice(-80));
      if (JSON.stringify(extra).length > MAX_EXTRA_BYTES) extra = this.extraFor(run, []);
    }
    const body = change.body ?? message.body;
    if (!keep) {
      this.deps.stream(message.channelId, await this.deps.show({ ...message, body, extra }));
      return;
    }
    const patched = messages.patchAgent(message.id, { body, extra });
    if (patched) this.deps.edited(await this.deps.show(patched));
  }

  private rewrite(runId: string, keep: boolean) {
    return this.write(runId, {}, keep);
  }

  /** The run is over, one way or another: the reply says so, the person who asked is told, and the next goes. */
  async finish(
    runId: string,
    state: "done" | "failed" | "stopped",
    reason: RunReason,
    final: { body?: string; steps?: unknown[] } = {},
    tellMachine = true,
    /** False when called from sending runs itself, which goes on to the next anyway. */
    next = true,
  ): Promise<void> {
    const { runs, messages } = this.deps;
    const before = runs.get(runId);
    const ended = runs.end(runId, state, reason);
    if (!before || !ended) return;
    if (tellMachine && (before.state === "sent" || before.state === "running"))
      this.send({
        t: "run.stop",
        runId,
        by: "room",
        reason: reason === "user" ? "user" : reason === "timeout" ? "timeout" : "access",
      });
    const existing = messages.get(ended.replyId)?.body ?? "";
    const body = final.body?.trim() ? final.body : existing;
    await this.write(
      runId,
      { body: body.trim() ? body : REASON_TEXT[reason], steps: final.steps },
      true,
    );
    const reply = messages.get(ended.replyId);
    if (reply && state !== "stopped") await this.deps.notifyEnd(ended, reply);
    if (next) await this.pump();
  }

  // Making and sending runs

  /**
   * Make a run for a mention, and the reply it will write in. Called inside the same transaction as the
   * message that asked, so there is never one without the other. A refusal still makes the reply, saying
   * why, so there is one way things go.
   */
  trigger(input: { channel: Channel; trigger: Message; asker: Person }): {
    run: Run;
    reply: Message;
  } {
    const { messages, runs } = this.deps;
    const { channel, trigger, asker } = input;
    const rootId = trigger.threadRoot ?? trigger.id;
    const refusal = agentRefusal(channel) ?? runs.check(asker.id, channel.id);
    const id = crypto.randomUUID();
    const extra: AgentExtra = {
      v: 1,
      runId: id,
      askedBy: asker.id,
      status: refusal ? "failed" : "queued",
      ...(refusal ? { reason: refusal } : {}),
      steps: [],
    };
    const { message: reply } = messages.post({
      channelId: channel.id,
      authorId: "agent",
      authorKind: "agent",
      body: refusal ? REASON_TEXT[refusal] : "",
      extra,
      threadRoot: rootId,
    });
    const run = runs.create({
      id,
      channelId: channel.id,
      rootId,
      triggerId: trigger.id,
      replyId: reply.id,
      askedBy: asker.id,
      askerRole: asker.role ?? "member",
      ...(refusal ? { state: "failed" as const, reason: refusal } : {}),
    });
    return { run, reply };
  }

  /** Send what is waiting to the machine, or wake it. One at a time, so two callers do not send a run twice. */
  pump(): Promise<void> {
    this.pumping = this.pumping
      .then(() => this.pumpNow())
      .catch((error) => {
        console.error(`[Hive chat] could not send runs to the agent: ${String(error)}`);
      });
    return this.pumping;
  }

  private async pumpNow() {
    const { runs, tasks } = this.deps;
    if (!this.deps.runner()) {
      if (runs.active().some((r) => r.state === "queued") || tasks.hasDue()) this.wakeMachine();
      return;
    }
    await this.giveOutTasks();
    for (let i = 0; i < 16; i++) {
      const next = runs.nextToSend(this.maxRuns);
      if (!next) return;
      const start = await this.startFor(next);
      // It may have ended while the room looked at who may ask.
      if (runs.get(next.id)?.state !== "queued") continue;
      if (typeof start === "string") {
        await this.finish(next.id, "failed", start, {}, false, false);
        continue;
      }
      runs.markSent(next.id);
      if (!this.send({ t: "run.start", run: start })) {
        runs.requeue(next.id);
        return;
      }
    }
  }

  /** Give the machine the tasks that are due, as many as it can take. */
  private async giveOutTasks() {
    const { tasks, access } = this.deps;
    for (let i = 0; i < 16 && tasks.inHand() < this.maxTasks; i++) {
      const next = tasks.nextDue();
      if (!next) return;
      const owner = await access.person(next.createdBy ?? "");
      const leaseId = crypto.randomUUID();
      const task = tasks.claim(next.id, leaseId);
      if (!task) continue;
      if (!owner?.email) {
        // Whoever made it is gone: nobody to work it for.
        tasks.end(task.id, leaseId, {
          status: "failed",
          error: "Whoever asked for this is no longer here",
        });
        continue;
      }
      const home =
        task.originChannelId && task.originChannelId !== ORCHESTRATOR_CHANNEL_ID
          ? await this.deps.store.get<Channel>(SHARED_OWNER, "channels", task.originChannelId)
          : null;
      const sent = this.send({
        t: "task.start",
        start: {
          task: this.withFileLinks(task),
          leaseId,
          owner: {
            id: owner.id,
            email: owner.email,
            name: owner.name,
            role: owner.role ?? "member",
          },
          ...(home
            ? {
                channel: {
                  id: home.id,
                  name: home.name,
                  topic: home.topic ?? "",
                  visibility: home.visibility ?? "public",
                },
              }
            : {}),
        },
      });
      if (!sent) {
        tasks.end(task.id, leaseId, {}, { requeue: true });
        return;
      }
      this.deps.taskTouched(task, false);
    }
  }

  private wakeMachine() {
    const now = this.deps.clock();
    const gap = Math.min(WAKE_EVERY_MS * 2 ** Math.max(0, this.wakes - 1), WAKE_EVERY_MAX_MS);
    if (now - this.lastWake < gap) return;
    this.lastWake = now;
    this.wakes++;
    this.deps.wake();
  }

  /** What the machine needs for a run, once the room has checked again that the asker may still ask. */
  private async startFor(run: Run): Promise<RunStart | RunReason> {
    const { store, access, messages, files } = this.deps;
    const asker = await access.person(run.askedBy);
    const channel = await store.get<Channel>(SHARED_OWNER, "channels", run.channelId);
    if (!asker?.email || !channel || !canOpen(asker, channel)) return "access";
    const refusal = agentRefusal(channel);
    if (refusal) return refusal;
    const trigger = messages.get(run.triggerId);
    if (!trigger || trigger.deletedAt) return "access";
    const known = await access.byId();
    const nameOf = (id: string) =>
      id === "agent" ? "Hive" : known.get(id)?.name || known.get(id)?.email || "Someone";
    const toContext = (m: Message): ContextMessage => ({
      id: m.id,
      author: nameOf(m.authorId),
      kind: m.authorKind,
      body: m.body,
      at: m.createdAt,
    });
    // The thread so far, or what came before a message of the channel's own.
    let before: Message[];
    if (trigger.threadRoot) {
      const root = messages.get(trigger.threadRoot);
      const replies = messages
        .replies(trigger.threadRoot, { limit: 500 })
        .filter((m) => m.seq < trigger.seq)
        .slice(-CONTEXT_REPLIES);
      before = [...(root && !root.deletedAt ? [root] : []), ...replies];
    } else {
      before = messages
        .page(run.channelId, {
          before: trigger.seq,
          limit: CONTEXT_BEFORE,
        })
        .messages.flatMap((m) => {
          // The agent answers in a thread under the message, which the channel's own list does not
          // show: without its answer an earlier request looks undone, and it would be done again.
          const answer =
            m.authorKind !== "agent" && m.replyCount > 0
              ? messages
                  .replies(m.id, { limit: 50 })
                  .find((r) => r.authorKind === "agent" && !r.deletedAt && r.body.trim())
              : undefined;
          return answer ? [m, answer] : [m];
        });
    }
    // The agent's empty replies (a run that did not get far) say nothing.
    const context = before
      .filter((m) => !m.deletedAt && (m.authorKind !== "agent" || m.body.trim()))
      .map(toContext);
    let chars = context.reduce((n, m) => n + m.body.length, 0);
    while (chars > CONTEXT_CHARS && context.length > 1) chars -= context.shift()?.body.length ?? 0;
    const people = withHandles(await access.openers(channel))
      .slice(0, CONTEXT_PEOPLE)
      .map((p) => ({ name: p.name || p.email, handle: p.handle }));
    const workspace = this.deps.workspaceId();
    const key = this.deps.linkKey();
    const attached = files.ofMessages([trigger.id]).get(trigger.id) ?? [];
    // A routine woke the agent: it is told which, and what it kept for itself.
    const woke = this.deps.routines.byTrigger(trigger.id);
    const routineStart = woke
      ? {
          routine: {
            id: woke.id,
            title: String((woke.data as { title?: unknown }).title ?? ""),
            memo: String((woke.data as { memo?: unknown }).memo ?? ""),
          },
        }
      : {};
    // Sent before, and the reply has something: the agent carries on from there.
    const reply = run.attempt > 0 ? messages.get(run.replyId) : null;
    const earlier = (reply?.extra as Partial<AgentExtra> | null)?.steps ?? [];
    const resume =
      reply && (reply.body.trim() || earlier.length)
        ? { body: reply.body, steps: earlier }
        : undefined;
    return {
      id: run.id,
      attempt: run.attempt + 1,
      channel: {
        id: channel.id,
        name: channel.name,
        topic: channel.topic ?? "",
        visibility: channel.visibility ?? "public",
      },
      thread: { rootId: run.rootId, messages: context },
      ...routineStart,
      text: trigger.body,
      asker: {
        id: asker.id,
        email: asker.email,
        name: asker.name,
        role: asker.role ?? "member",
      },
      people,
      files:
        workspace && key
          ? attached.map((f) => ({
              id: f.id,
              name: f.name,
              mime: f.mime,
              bytes: f.bytes,
              path: `/w/${workspace}${signedPath(key, {
                workspaceId: workspace,
                kind: "dl",
                fileId: f.id,
                variant: "file",
                exp: this.deps.clock() + FILE_LINK_MS,
              })}`,
            }))
          : [],
      mode: "ask",
      ...(resume ? { resume } : {}),
    };
  }

  // What people do

  private async channelFor(person: Person, run: Run): Promise<Channel> {
    const channel = await this.deps.store.get<Channel>(SHARED_OWNER, "channels", run.channelId);
    if (!channel || !canOpen(person, channel)) throw new AppError("Run not found", 404);
    return channel;
  }

  /** Stop a run: its asker, a manager of the channel, an admin or the owner. */
  async stop(person: Person, runId: string): Promise<{ ok: true }> {
    const run = this.deps.runs.get(runId);
    if (!run) throw new AppError("Run not found", 404);
    const channel = await this.channelFor(person, run);
    if (!isActive(run)) return { ok: true };
    if (run.askedBy !== person.id && !managesChannel(person, channel))
      throw new AppError(
        "Only who asked, a channel manager, an admin or the owner can stop this",
        403,
      );
    await this.finish(runId, "stopped", "user");
    return { ok: true };
  }

  /** Answer what the agent asked: anyone who can open the channel but a guest; the first answer is taken. */
  async answer(
    person: Person,
    runId: string,
    promptId: string,
    choice: PromptChoice,
  ): Promise<{ ok: true }> {
    const { runs } = this.deps;
    const run = runs.get(runId);
    if (!run) throw new AppError("Run not found", 404);
    await this.channelFor(person, run);
    if (person.role === "guest") throw new AppError("A guest can look; a teammate decides", 403);
    if (!isActive(run)) throw new AppError("This run is over", 409);
    const asked = run.prompts.find((p) => p.prompt.id === promptId);
    if (!asked) throw new AppError("Nothing was asked", 404);
    const fits =
      asked.prompt.kind === "approval"
        ? "reply" in choice
        : "answers" in choice || "dismiss" in choice;
    if (!fits) throw new AppError("That is not an answer to this", 422);
    if (!runs.answer(runId, promptId, { id: person.id, name: person.name || person.email }, choice))
      throw new AppError("This was already answered", 409);
    this.send({
      t: "run.answer",
      runId,
      promptId,
      requestId: asked.requestId ?? "",
      by: person.id,
      choice,
    });
    await this.rewrite(runId, true);
    return { ok: true };
  }

  // What changed under a run

  /** The channel or the people in it changed: runs whose asker may no longer ask here are stopped. */
  async recheck(channelId?: string): Promise<void> {
    const { runs, store, access } = this.deps;
    for (const run of runs.active()) {
      if (channelId && run.channelId !== channelId) continue;
      const channel = await store.get<Channel>(SHARED_OWNER, "channels", run.channelId);
      const asker = await access.person(run.askedBy);
      const why: RunReason | null =
        !channel || !asker || !canOpen(asker, channel)
          ? "access"
          : channel.status === "archived"
            ? "archived"
            : !agentOn(channel)
              ? "disabled"
              : null;
      if (why) await this.finish(run.id, "stopped", why);
    }
  }

  /** A person's access has ended: what they asked for stops. */
  async revoked(personId: string): Promise<void> {
    for (const run of this.deps.runs.active())
      if (run.askedBy === personId) await this.finish(run.id, "stopped", "access");
  }

  /** A message was deleted: if it started a run or is its reply, the run stops. */
  async messageGone(messageId: string): Promise<void> {
    for (const run of this.deps.runs.active())
      if (run.triggerId === messageId || run.replyId === messageId)
        await this.finish(run.id, "stopped", "user");
  }

  /** A channel is gone. */
  async channelGone(channelId: string): Promise<void> {
    for (const run of this.deps.runs.active())
      if (run.channelId === channelId) await this.finish(run.id, "stopped", "access");
    this.deps.runs.removeOfChannel(channelId);
    // What the machine kept for it goes too. A machine that is not here asks when it next connects.
    this.send({ t: "channels.gone", ids: [channelId] });
  }

  /** The machine says which channels it keeps something for: it is told which no longer exist. */
  private async channelsHave(ids: string[]): Promise<void> {
    const gone: string[] = [];
    for (const id of ids)
      if (!(await this.deps.store.get<Channel>(SHARED_OWNER, "channels", id))) gone.push(id);
    if (gone.length) this.send({ t: "channels.gone", ids: gone });
  }

  /** The machine's connection ended: what was sent and not taken goes back to wait for the next. */
  async disconnected(): Promise<void> {
    for (const run of this.deps.runs.active())
      if (run.state === "sent") this.deps.runs.requeue(run.id);
    this.deps.tasks.requeueUnacked();
    await this.pump();
  }

  /**
   * A person (or the agent's tool) changed a task: a machine holding it lets go if it was paused, stopped or
   * taken away, is told of notes added, and a task that is due now is given out.
   */
  async taskChanged(task: AgentTask, before: AgentTask | null, removed = false): Promise<void> {
    const lease = before?.leaseId;
    if (lease && (removed || task.leaseId !== lease))
      this.send({ t: "task.stop", taskId: task.id, leaseId: lease });
    else if (lease && task.leaseId === lease) {
      const known = new Set((before?.notes ?? []).map((n) => n.id));
      const added = (task.notes ?? []).filter((n) => !known.has(n.id));
      if (added.length)
        this.send({ t: "task.note", taskId: task.id, leaseId: lease, notes: added });
      const had = new Set((before?.attachments ?? []).map((a) => a.id));
      const files = (this.withFileLinks(task).attachments ?? []).filter((a) => !had.has(a.id));
      if (files.length) this.send({ t: "task.files", taskId: task.id, leaseId: lease, files });
    }
    // A person finished it or stopped it: the machine has things to do about that (a goal's milestone, a
    // notice, declining a review it was waiting on).
    if (
      !removed &&
      (task.status === "succeeded" || task.status === "cancelled") &&
      before?.status !== task.status
    )
      await this.deps.store.put("system", "outcomes", { id: task.id, at: task.updatedAt });
    if (!removed) await this.sendOutcomes();
    if (!removed) await this.pump();
    if (!removed && (this.deps.tasks.hasActive() || this.deps.tasks.nextScheduledMs() !== null))
      this.deps.soon();
  }

  /** The task with the address of each of its files, below the origin the machine reaches the room at. */
  private withFileLinks(task: AgentTask): AgentTask {
    const workspace = this.deps.workspaceId();
    if (!task.attachments?.length || !workspace) return task;
    return {
      ...task,
      attachments: task.attachments.map((file) => {
        const path = this.deps.work.fileLink(file.id);
        return path ? { ...file, url: `/w/${workspace}${path}` } : file;
      }),
    };
  }

  /** Tell the machine of tasks people finished, until it says it has done what they call for. */
  private async sendOutcomes() {
    const { store, tasks } = this.deps;
    for (const { id, at } of await store.list<{ id: string; at: string }>("system", "outcomes")) {
      const task = tasks.get(id);
      if (!task) await store.remove("system", "outcomes", id);
      else if (task.updatedAt === at && !this.send({ t: "task.outcome", task })) return;
    }
  }

  /**
   * The room's upkeep: what waited, ran or asked too long, and what went quiet. Returns whether runs are
   * still going, which is whether the room is to be woken again soon.
   */
  async maintain(): Promise<boolean> {
    const { runs } = this.deps;
    for (const { run, reason } of runs.expired()) await this.finish(run.id, "failed", reason);
    const now = this.deps.clock();
    // Without a connection a run gets longer to come back before it is given up on.
    const grace = this.deps.runner() ? 0 : RUN_LIMITS.lostGraceMs;
    for (const run of runs.quiet())
      if (now - (run.beatMs ?? run.createdMs) > RUN_LIMITS.beatStaleMs + grace)
        await this.finish(run.id, "failed", "lost", {}, false);
    // A task the machine has not been heard of holding is cut off; it is tried again, a few times.
    const { tasks } = this.deps;
    for (const task of tasks.quiet(grace)) tasks.interrupt(task.id, task.leaseId);
    // A review nobody decided has run out: the task goes back to the agent, which finds it so.
    for (const id of tasks.staleReviews()) {
      const saved = tasks.change(
        id,
        { status: "queued", updatedAt: new Date(now).toISOString() },
        {
          status: "waiting_approval",
          leaseId: null,
        },
      );
      if (saved) this.deps.taskTouched(saved, false);
    }
    runs.prune();
    await this.pump();
    return runs.hasActive() || tasks.hasActive() || tasks.hasDue() || tasks.hasReviews();
  }
}
