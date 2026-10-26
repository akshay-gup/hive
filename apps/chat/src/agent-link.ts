import {
  type Access,
  canOpen,
  managesChannel,
  type Person,
} from "../../../packages/chat-core/src/access.ts";
import { agentOn, agentRefusal } from "../../../packages/chat-core/src/agent-trigger.ts";
import { AppError } from "../../../packages/chat-core/src/errors.ts";
import type { Files } from "../../../packages/chat-core/src/files.ts";
import type { Message, Messages } from "../../../packages/chat-core/src/messages.ts";
import { isActive, RUN_LIMITS, type Run, type Runs } from "../../../packages/chat-core/src/runs.ts";
import { SHARED_OWNER } from "../../../packages/chat-core/src/shared.ts";
import type { RecordStore } from "../../../packages/chat-core/src/store.ts";
import type { Channel } from "../../../packages/domain/src/agent.ts";
import type { ChatMessage } from "../../../packages/domain/src/chat.ts";
import {
  type AgentExtra,
  type ContextMessage,
  MAX_EXTRA_BYTES,
  type PromptChoice,
  REASON_TEXT,
  type RoomFrame,
  type RunnerFrame,
  type RunReason,
  type RunStart,
  type RunStatus,
  runnerFrameSchema,
} from "../../../packages/domain/src/chat-agent.ts";
import { withHandles } from "../../../packages/domain/src/mentions.ts";
import type { Filing } from "./filing.ts";
import { signedPath } from "./uploads.ts";

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
/** The least between two calls for the machine to be woken. */
const WAKE_EVERY_MS = 30_000;

export interface AgentLinkDeps {
  store: RecordStore;
  access: Access;
  messages: Messages;
  runs: Runs;
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
  workspaceId: () => string | null;
  linkKey: () => string | undefined;
  /** Ask for the agent's machine to be started. */
  wake: () => void;
  clock: () => number;
}

/**
 * The agent's side of a workspace's chat: what becomes of a mention. A mention makes a run; the run is sent
 * to the machine the agent runs on, which writes the agent's reply as it goes; people answer what the agent
 * asks and can stop it. What a run is lives here, and who may do what is decided here each time, so the
 * machine is trusted with nothing but the words of its own reply: every frame it sends is held to a run
 * that is still going, and only that run's reply is changed.
 */
export class AgentLink {
  private maxRuns: number = RUN_LIMITS.defaultMaxRuns;
  private pumping: Promise<void> = Promise.resolve();
  private lastWake = 0;

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
        return;
      case "file.begin":
        return this.fileBegin(frame);
      case "file.done":
        return this.fileDone(frame);
      case "renew":
        return; // The connection's token is the Durable Object's to renew; see room.ts.
    }
  }

  private async hello(frame: Extract<RunnerFrame, { t: "hello" }>) {
    const { runs, store } = this.deps;
    if (frame.capacity) this.maxRuns = frame.capacity.maxRuns;
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
    this.send({ t: "welcome", limits: { maxRunMs: RUN_LIMITS.maxRunMs }, resume: keep });
    await this.pump();
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
      frame.status === "failed" ? "error" : frame.status === "stopped" ? "user" : "ok",
      { body: frame.body, steps: frame.steps },
      false,
    );
    // Said even if it had already ended here, so the machine can let go of it.
    this.send({ t: "ack", runId: frame.runId });
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
    const { runs } = this.deps;
    if (!this.deps.runner()) {
      if (runs.active().some((r) => r.state === "queued")) this.wakeMachine();
      return;
    }
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

  private wakeMachine() {
    const now = this.deps.clock();
    if (now - this.lastWake < WAKE_EVERY_MS) return;
    this.lastWake = now;
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
      before = messages.page(run.channelId, {
        before: trigger.seq,
        limit: CONTEXT_BEFORE,
      }).messages;
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
    await this.pump();
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
    runs.prune();
    await this.pump();
    return runs.hasActive();
  }
}
