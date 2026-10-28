import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { z } from "zod";
import {
  Access,
  isDm,
  isIn,
  isPublic,
  managesChannel,
} from "../../../../packages/chat-core/src/access.ts";
import { ChannelPeople } from "../../../../packages/chat-core/src/channel-people.ts";
import { AppError } from "../../../../packages/chat-core/src/errors.ts";
import {
  type AgentArtifact,
  type AgentIdentity,
  type AgentMachineView,
  type AgentTask,
  type Channel,
  type ChannelThread,
  createChannelSchema,
  type Evidence,
  type IdeaBatch,
  type NotificationPrefs,
  notificationPrefsSchema,
  ORCHESTRATOR_CHANNEL_ID,
  type RunEvent,
} from "../../../../packages/domain/src/agent.ts";
import type {
  ActionProposal,
  Artifact,
  BrowserSession,
  Mail,
  ProposalInput,
} from "../../../../packages/domain/src/index.ts";
import { type Mentionable, withHandles } from "../../../../packages/domain/src/mentions.ts";
import type { ActionService } from "../actions.ts";
import type { BrowserService } from "../browser.ts";
import { type Board, noBoard } from "../chat-runner/work-link.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import type { Files } from "../files.ts";
import { createJevService, type JevService } from "../jev/service.ts";
import { backgroundFailure } from "../log.ts";
import type { OpencodeTaskRuntime } from "../opencode/index.ts";
import { requesterNames } from "../requesters.ts";
import type { WorkspaceService } from "../workspace.ts";
import { inlineLimits, renderBrief } from "./brief.ts";
import { ChannelFiles } from "./channel-files.ts";
import { ChannelManager } from "./channels.ts";
import { analyzeSpending } from "./finance.ts";
import { executeTask } from "./task-executor.ts";
import { type StagedFile, TaskFiles } from "./task-files.ts";
import {
  channelWorkspaceDir,
  diskOwnerForChannel,
  LocalDiskThreadStore,
  SHARED_OWNER,
  type ThreadBindingStore,
} from "./threads.ts";
import { UploadRequests } from "./upload-requests.ts";
import { type TaskContext, TaskWorker } from "./worker.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const date = () => new Date().toISOString();
const _terminal = new Set(["succeeded", "failed", "cancelled"]);
/** How many of a task's latest steps the app is sent with its history. */
const HISTORY_EVENTS = 400;
/** How long the board's answer to which tasks a person may see is kept. */
const VISIBILITY_MS = 10_000;
export class AgentService {
  readonly worker: TaskWorker;
  /** Set by createApp: told when the worker is done with a task it was lent, so the task can be given back. */
  taskFinished?: (owner: string, task: AgentTask) => Promise<void>;
  /** Set by createApp: how the agent's tools change the board, which the chat service keeps. */
  board: Board = noBoard;
  /** Report a failed shared mail source to the room, which chooses who is told. */
  sourceFailure?: () => Promise<void>;
  /** Deliver shared-mail suggestions to the room; only pending transport records stay here. */
  publishIdeas?: (batch: Omit<IdeaBatch, "id">) => Promise<void>;
  /** Which task ids the board last said a person may see. */
  private readonly visibility = new Map<
    string,
    { at: number; checked: Set<string>; seen: Set<string> }
  >();
  private maintenance?: ReturnType<typeof setInterval>;
  private refreshing = false;
  private channels?: ChannelManager;
  /** threadId → binding, keyed `${owner}/${threadId}`. Invalidated on write. */
  private readonly threadChannelCache = new Map<string, ChannelThread>();
  /** threadId → until when it is known to be bound to no channel, keyed `${owner}/${threadId}`. */
  private readonly unboundThreads = new Map<string, number>();
  /**
   * Set by createApp. Task-worker execution runs as OpenCode sessions through it, and a renamed
   * thread's session title follows.
   */
  opencodeRuntime?: OpencodeTaskRuntime;
  /** The bytes of the files attached to tasks, and how they reach an agent. */
  readonly taskFiles: TaskFiles;
  /** What is in each channel's workspace: what the agent makes there and what people add. */
  readonly channelFiles: ChannelFiles;
  /** What an agent has asked people to upload, and what they have uploaded for it. */
  readonly uploadRequests: UploadRequests;
  /** The choice cards an agent can show (`present_choices`), or null when JEV_MODE is off. */
  readonly jev: JevService | null;
  /** What each person may open: everything, but for a guest, who has only the channels they were added to, and a private channel, which is its members'. */
  readonly access: Access;
  /** Who is in each channel, who manages it, and who may change either. */
  readonly people: ChannelPeople;
  constructor(
    readonly db: Store,
    readonly config: Config,
    readonly workspace: WorkspaceService,
    readonly files: Files,
    readonly actions: ActionService,
    readonly browser: BrowserService,
    readonly threads: ThreadBindingStore = new LocalDiskThreadStore(config.dataDir),
    jev: JevService | null = createJevService(db, config),
  ) {
    this.jev = jev;
    this.access = new Access(db, Boolean(config.managed));
    this.people = new ChannelPeople(db, this.access);
    this.taskFiles = new TaskFiles(config.dataDir);
    this.channelFiles = new ChannelFiles(config, files, (owner, id) => this.getChannel(owner, id));
    this.uploadRequests = new UploadRequests(db);
    this.worker = new TaskWorker(db, (owner, task, context) => this.execute(owner, task, context), {
      finished: (owner, task) => this.taskFinished?.(owner, task) ?? Promise.resolve(),
      // In orchestrator mode the main process only runs orchestrator-channel tasks;
      // per-channel workers (spawned separately) claim their own channels.
      channelId: config.manageChannels ? ORCHESTRATOR_CHANNEL_ID : config.workerChannelId,
    });
  }
  /**
   * Tasks the room lent this machine that it was working when it stopped: what their runs reached is
   * announced (once; the notices are keyed), and the copies go. The room has them back as interrupted and
   * lends them again, so nothing here runs one on its own.
   */
  async recoverCopies() {
    for (const { owner, value } of await this.db.scan<AgentTask>("tasks")) {
      await this.taskFiles
        .removeAll(value.id, this.workspaceOf(value, owner))
        .catch((error) => backgroundFailure("remove a lost run's files", error));
      await this.db.remove(owner, "tasks", value.id);
    }
  }
  /** Settled once the copies a stop left behind are dealt with: tasks are not taken before. */
  recovered: Promise<void> = Promise.resolve();
  start() {
    this.recovered = this.recoverCopies().catch((error) =>
      backgroundFailure("recover lent tasks", error),
    );
    void this.recovered.finally(() => this.worker.start());
    // In orchestrator mode the main process also manages per-channel workers.
    // (A channel worker itself never manages: workerChannelId is set there.)
    if (this.config.manageChannels && !this.config.workerChannelId) {
      this.channels = new ChannelManager(this.db, this.config);
      this.channels.start();
    }
    // Maintenance is independent of the HTTP response and reconciles durable records.
    void this.maintain().catch((error) => backgroundFailure("initial maintenance", error));
    this.maintenance = setInterval(() => {
      void this.maintain().catch((error) => backgroundFailure("maintenance", error));
    }, 60000);
  }
  async stop() {
    if (this.maintenance) clearInterval(this.maintenance);
    this.maintenance = undefined;
    await this.channels?.stop();
    this.channels = undefined;
    await this.worker.stop();
    while (this.refreshing) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  private async maintain() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (const { owner, value } of await this.db.scan<{ id: string; lastIdeasAt?: string }>(
        "agent-settings",
      )) {
        if (value.id !== "identity") continue;
        if (!value.lastIdeasAt || Date.now() - Date.parse(value.lastIdeasAt) > 15 * 60000)
          await this.refreshIdeas(owner).catch(async (error) => {
            backgroundFailure("refresh mail source", error);
            await this.sourceFailure?.();
          });
      }
    } finally {
      this.refreshing = false;
    }
  }
  async ensure(owner: string) {
    await this.db.insertIfAbsent(owner, "agent-settings", {
      id: "identity",
      name: "Hive",
      tone: "warm",
    });
    // Maintenance works on shared records as the workspace itself, which has no orchestrator chat.
    if (owner !== SHARED_OWNER) await this.ensureOrchestratorChannel(owner);
  }
  /** The orchestrator channel always exists: the fixed control-plane surface. */
  async ensureOrchestratorChannel(owner: string): Promise<Channel> {
    const existing = await this.db.get<Channel>(owner, "channels", ORCHESTRATOR_CHANNEL_ID);
    if (existing) return existing;
    const now = new Date().toISOString();
    const channel: Channel = {
      id: ORCHESTRATOR_CHANNEL_ID,
      name: "Orchestrator",
      status: "active",
      createdBy: owner,
      createdAt: now,
      updatedAt: now,
      workerPid: null,
      lastActiveAt: now,
    };
    await this.db.insertIfAbsent(owner, "channels", channel);
    // Best-effort: give the orchestrator its own private directory.
    try {
      await mkdir(channelWorkspaceDir(this.config.dataDir, owner, ORCHESTRATOR_CHANNEL_ID), {
        recursive: true,
      });
    } catch {
      /* storage unavailable */
    }
    return (await this.db.get<Channel>(owner, "channels", ORCHESTRATOR_CHANNEL_ID)) ?? channel;
  }
  /** Channels are shared across users; each user's orchestrator is private. */
  private channelOwner(channelId: string, owner: string): string {
    return diskOwnerForChannel(channelId, owner);
  }
  /** Fetch a channel by id, from the shared store or the user's own. */
  async getChannel(owner: string, channelId: string): Promise<Channel | null> {
    return this.db.get<Channel>(this.channelOwner(channelId, owner), "channels", channelId);
  }
  /**
   * Record on a channel that it has work. Only these fields are written, so this cannot undo a
   * change made to the channel at the same moment, such as someone being taken out of it.
   */
  private async touchChannel(owner: string, channelId: string, patch: Partial<Channel>) {
    await this.db.compareAndSwap(
      this.channelOwner(channelId, owner),
      "channels",
      channelId,
      {},
      patch,
    );
  }
  /**
   * A workspace that knows its people starts with a #general everyone is in, so a new team has
   * somewhere to talk at once. Only a workspace with no channels at all gets one: an archived one
   * counts, so it does not come back after someone put it away.
   */
  private async ensureGeneral(owner: string, channels: Channel[]): Promise<Channel[]> {
    if (channels.length > 0) return channels;
    const person = await this.access.person(owner);
    if (!person?.email || person.role === "guest") return channels;
    const now = new Date().toISOString();
    const general: Channel = {
      id: "general",
      name: "general",
      status: "active",
      createdBy: owner,
      createdAt: now,
      updatedAt: now,
      workerPid: null,
      lastActiveAt: now,
      visibility: "public",
      everyone: true,
      members: [],
      managers: [],
      topic: "Where the team talks about anything",
    };
    // Two people opening a new workspace at once make the same channel, so this only writes it
    // where it is not already.
    if (!(await this.db.get<Channel>(SHARED_OWNER, "channels", general.id)))
      await this.db.put(SHARED_OWNER, "channels", general);
    try {
      await mkdir(channelWorkspaceDir(this.config.dataDir, SHARED_OWNER, general.id), {
        recursive: true,
      });
    } catch {
      /* storage unavailable */
    }
    return [general];
  }
  /** The people who may be mentioned in a channel: those who can open it, but the asker. */
  async mentionable(owner: string, channelId: string): Promise<Mentionable[]> {
    await this.access.assertChannel(owner, channelId);
    const channel = await this.getChannel(owner, channelId);
    if (!channel) return [];
    const person = await this.access.person(owner);
    const everyone = withHandles(await this.access.openers(channel));
    // Only what is typed and shown: the ids people are known by here stay here.
    return everyone
      .filter((who) => who.email !== person?.email)
      .map(({ email, name, handle, role }) => ({ email, name, handle, role }))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  }
  /** Record that someone wrote in a channel, for the unread mark of the others in it. */
  async noteMessage(owner: string, channelId: string): Promise<void> {
    if (channelId === ORCHESTRATOR_CHANNEL_ID) return;
    const person = await this.access.person(owner);
    if (!person?.email) return;
    await this.touchChannel(owner, channelId, {
      lastMessageAt: new Date().toISOString(),
      lastMessageBy: person.email,
    });
  }
  /** What this person wants to be told about: all of it, until they turn something off. */
  async notificationPrefs(owner: string): Promise<NotificationPrefs> {
    const saved = await this.db.get<NotificationPrefs & { id: string }>(
      owner,
      "notification-prefs",
      "me",
    );
    return {
      mentions: saved?.mentions ?? true,
      work: saved?.work ?? true,
      muted: saved?.muted ?? [],
    };
  }
  async setNotificationPrefs(owner: string, raw: unknown): Promise<NotificationPrefs> {
    const input = notificationPrefsSchema.parse(raw);
    const now = await this.notificationPrefs(owner);
    const next: NotificationPrefs = {
      mentions: input.mentions ?? now.mentions,
      work: input.work ?? now.work,
      muted: [...new Set(input.muted ?? now.muted)].sort(),
    };
    await this.db.put(owner, "notification-prefs", { id: "me", ...next });
    return next;
  }
  /** When this person last had each channel open. */
  async readMarks(owner: string): Promise<Record<string, string>> {
    return (
      (await this.db.get<{ id: string; at: Record<string, string> }>(owner, "reads", "channels"))
        ?.at ?? {}
    );
  }
  /** The person has the channel open: everything written in it so far is read. */
  async markRead(owner: string, channelId: string): Promise<void> {
    if (channelId === ORCHESTRATOR_CHANNEL_ID) return;
    const scope = await this.access.scope(owner);
    if (!scope.allows(channelId)) throw new AppError("Channel not found", 404);
    const at = { ...(await this.readMarks(owner)), [channelId]: new Date().toISOString() };
    await this.db.put(owner, "reads", { id: "channels", at });
  }
  async listChannels(owner: string): Promise<Channel[]> {
    // Only the channels this person may open: a guest has no orchestrator chat, and a private
    // channel is not listed to anyone who is not in it.
    const visible = await this.access.visibleChannels(
      owner,
      await this.ensureGeneral(owner, await this.db.list<Channel>(SHARED_OWNER, "channels")),
    );
    if (await this.access.isGuest(owner)) return visible;
    await this.ensureOrchestratorChannel(owner);
    const orchestrator = await this.db.get<Channel>(owner, "channels", ORCHESTRATOR_CHANNEL_ID);
    return orchestrator ? [...visible, orchestrator] : visible;
  }
  async createChannel(owner: string, raw: unknown): Promise<Channel> {
    const input = createChannelSchema.parse(raw);
    const person = await this.access.person(owner);
    if (person?.role === "guest") throw new AppError("A guest can't create a channel", 403);
    if (input.visibility === "private" && !person?.email)
      throw new AppError("Private channels need a workspace that knows its people", 409);
    await this.ensureOrchestratorChannel(owner);
    if (input.id === ORCHESTRATOR_CHANNEL_ID) throw new AppError("Channel id is reserved", 409);
    const slug =
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || randomUUID().slice(0, 8);
    const id = input.id ?? slug;
    if (await this.db.get<Channel>(SHARED_OWNER, "channels", id))
      throw new AppError("Channel already exists", 409);
    const now = new Date().toISOString();
    const channel: Channel = {
      id,
      name: input.name,
      status: "active",
      createdBy: owner,
      createdAt: now,
      updatedAt: now,
      workerPid: null,
      lastActiveAt: now,
      // Where people are known, a channel starts as just the person who made it, who manages it.
      ...(person?.email
        ? {
            visibility: input.visibility ?? "public",
            everyone: false,
            members: [person.email],
            managers: [person.email],
          }
        : {}),
    };
    await this.db.put(SHARED_OWNER, "channels", channel);
    // Best-effort: give the channel its own directory on local disk.
    // This must not fail channel creation.
    try {
      await mkdir(channelWorkspaceDir(this.config.dataDir, SHARED_OWNER, channel.id), {
        recursive: true,
      });
    } catch {
      /* storage unavailable */
    }
    return channel;
  }
  /**
   * Put a channel away. A channel's managers, the owner and the admins can archive one, and anyone in
   * a private channel (its last person cannot leave it); the owner and admins can archive any, a
   * private one they are not in too.
   */
  async archiveChannel(owner: string, id: string): Promise<Channel> {
    if (id === ORCHESTRATOR_CHANNEL_ID)
      throw new AppError("The orchestrator channel cannot be archived", 409);
    const scope = await this.access.scope(owner);
    const person = scope.person;
    if (person?.role === "guest") throw new AppError("A guest can't archive a channel", 403);
    const runs = person?.role === "owner" || person?.role === "admin";
    if (!runs && !scope.allows(id)) throw new AppError("Channel not found", 404);
    const channel = await this.db.get<Channel>(SHARED_OWNER, "channels", id);
    if (!channel) throw new AppError("Channel not found", 404);
    if (isDm(channel))
      throw scope.allows(id)
        ? new AppError("A direct message can't be archived", 409)
        : new AppError("Channel not found", 404);
    if (
      person &&
      !runs &&
      !managesChannel(person, channel) &&
      !(!isPublic(channel) && isIn(person, channel))
    )
      throw new AppError(
        "Only a channel manager, an admin or the owner can archive a public channel",
        403,
      );
    const updated = await this.db.compareAndSwap<Channel>(
      SHARED_OWNER,
      "channels",
      id,
      {},
      { status: "archived", updatedAt: new Date().toISOString() },
    );
    if (!updated) throw new AppError("Channel not found", 404);
    return updated;
  }
  /**
   * Bind a new conversation thread to a channel. The thread id is
   * server-generated; the binding is a JSON file in the channel's workspace
   * dir (`threads/<threadId>.json`). Bindings are append-only, never rebound.
   */
  async registerThread(
    owner: string,
    channelId: string,
    name?: string,
    parentMessageId?: string,
  ): Promise<ChannelThread> {
    const channel = await this.getChannel(owner, channelId);
    if (!channel || channel.status === "archived") throw new AppError("Channel not found", 404);
    const existing = await this.threads.list(owner, channelId);
    const binding: ChannelThread = {
      threadId: randomUUID(),
      channelId,
      name: name?.trim().slice(0, 80) || `Thread ${existing.length + 1}`,
      createdAt: new Date().toISOString(),
      ...(parentMessageId?.trim() ? { parentMessageId: parentMessageId.trim().slice(0, 120) } : {}),
    };
    await this.threads.write(owner, binding);
    this.threadChannelCache.set(`${owner}/${binding.threadId}`, binding);
    await this.touchChannel(owner, channelId, {
      status: "active",
      lastActiveAt: binding.createdAt,
      updatedAt: binding.createdAt,
    });
    return binding;
  }
  /**
   * Idempotently bind a client-known thread id to a channel. Used for the
   * orchestrator's main chat thread, whose id originates on the client.
   */
  async ensureThreadBinding(
    owner: string,
    threadId: string,
    channelId: string,
    name?: string,
  ): Promise<ChannelThread> {
    const cached = await this.channelOfThread(owner, threadId);
    if (cached) return cached;
    const channel = await this.getChannel(owner, channelId);
    if (!channel || channel.status === "archived") throw new AppError("Channel not found", 404);
    const binding: ChannelThread = {
      threadId,
      channelId,
      name: name?.trim().slice(0, 80) || "Main chat",
      createdAt: new Date().toISOString(),
    };
    await this.threads.write(owner, binding);
    this.threadChannelCache.set(`${owner}/${threadId}`, binding);
    return binding;
  }
  /** Rename a thread's display name. The binding (thread → channel) is untouched. */
  async renameThread(owner: string, threadId: string, name: string): Promise<ChannelThread> {
    const binding = await this.channelOfThread(owner, threadId);
    if (!binding) throw new AppError("Thread is not bound to a channel", 404);
    const renamed: ChannelThread = { ...binding, name };
    await this.threads.write(owner, renamed);
    this.threadChannelCache.set(`${owner}/${threadId}`, renamed);
    // Keep the OpenCode session title in sync when the thread is bound.
    const runtime = this.opencodeRuntime;
    if (runtime && renamed.opencodeSessionId) {
      const directory = channelWorkspaceDir(
        this.config.dataDir,
        diskOwnerForChannel(renamed.channelId, owner),
        renamed.channelId,
      );
      const sessionId = renamed.opencodeSessionId;
      void runtime.pool
        .forDirectory(directory)
        .session.update({ sessionID: sessionId, directory, title: name })
        .catch(() => undefined);
    }
    return renamed;
  }
  /** Threads bound to a channel, oldest first. */
  async listChannelThreads(owner: string, channelId: string): Promise<ChannelThread[]> {
    const channel = await this.getChannel(owner, channelId);
    if (!channel) throw new AppError("Channel not found", 404);
    return this.threads.list(owner, channelId);
  }
  /** Reverse lookup: which channel does this thread belong to? Cached, and a thread with none is remembered for a moment. */
  async channelOfThread(owner: string, threadId: string): Promise<ChannelThread | null> {
    const key = `${owner}/${threadId}`;
    const cached = this.threadChannelCache.get(key);
    if (cached) return cached;
    // Every request about a thread asks this, and the orchestrator's main chat is bound to no
    // channel until its first message: do not read every binding from disk for each of them.
    if ((this.unboundThreads.get(key) ?? 0) > Date.now()) return null;
    const all = await this.threads.scan(owner);
    this.threadChannelCache.clear();
    for (const binding of all) this.threadChannelCache.set(`${owner}/${binding.threadId}`, binding);
    const found = this.threadChannelCache.get(key) ?? null;
    if (!found) {
      if (this.unboundThreads.size > 500) this.unboundThreads.clear();
      this.unboundThreads.set(key, Date.now() + 5000);
    }
    return found;
  }
  /**
   * Which of these ids are tasks the person may see. The board is the chat service's, so it is asked, for the
   * ids this machine holds things about and no more; if it cannot answer, none are shown.
   */
  private async visibleTaskIds(owner: string, ids: (string | undefined)[]): Promise<Set<string>> {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!wanted.length) return new Set();
    const known = this.visibility.get(owner);
    const fresh = known && Date.now() - known.at < VISIBILITY_MS ? known : undefined;
    const have = fresh ?? { at: Date.now(), checked: new Set<string>(), seen: new Set<string>() };
    const ask = wanted.filter((id) => !have.checked.has(id));
    if (ask.length) {
      try {
        const { ids: seen } = await this.board
          .forPerson(owner)
          .call<{ ids: string[] }>("tasks.visible", { ids: ask });
        for (const id of ask) have.checked.add(id);
        for (const id of seen) have.seen.add(id);
        this.visibility.set(owner, have);
      } catch {
        // Not answered: nothing that names a task is shown, and it is asked again next time.
      }
    }
    return new Set(wanted.filter((id) => have.seen.has(id)));
  }
  /** What a guest is shown of the machine: results of tasks they may see. Notices come from the room. */
  private async guestSnapshot(owner: string): Promise<AgentMachineView> {
    const [artifacts, identity] = await Promise.all([
      this.db.list<AgentArtifact>(owner, "agent-artifacts"),
      this.db.get<AgentIdentity>(owner, "agent-settings", "identity"),
    ]);
    const visible = await this.visibleTaskIds(owner, [...artifacts.map((a) => a.taskId)]);
    return {
      notifications: [],
      ideas: [],
      artifacts: artifacts.filter((artifact) => !artifact.taskId || visible.has(artifact.taskId)),
      identity: identity ?? { name: "Hive", tone: "warm" },
      worker: { running: this.worker.running, lastTickAt: this.worker.lastTickAt },
    };
  }
  /**
   * The browser windows this person may be shown. The ones the agent opened in a private channel's
   * threads belong to the people in that channel.
   */
  async visibleBrowsers<T extends { id: string }>(owner: string, sessions: T[]): Promise<T[]> {
    const scope = await this.access.scope(owner);
    if (!scope.person || sessions.length === 0) return sessions;
    const hidden = new Set<string>();
    for (const link of await this.db.list<{ id: string; sessionId: string }>(
      owner,
      "chat-browsers",
    )) {
      const channelId = link.id.startsWith("channel:")
        ? link.id.slice("channel:".length)
        : (await this.channelOfThread(owner, link.id))?.channelId;
      if (channelId && !scope.allows(channelId)) hidden.add(link.sessionId);
    }
    return sessions.filter((session) => !hidden.has(session.id));
  }
  /**
   * The reviews (and the receipts of what came of them) this person may be shown: the ones the agent
   * prepared for a task of a private channel they are not in are not.
   */
  async visibleReviews<A extends { id: string; taskId?: string }, E extends { actionId?: string }>(
    owner: string,
    reviews: A[],
    receipts: E[],
  ): Promise<{ reviews: A[]; receipts: E[] }> {
    const scope = await this.access.scope(owner);
    if (!scope.person) return { reviews, receipts };
    const visible = await this.visibleTaskIds(
      owner,
      reviews.map((review) => review.taskId),
    );
    const hidden = new Set(
      reviews.filter((review) => review.taskId && !visible.has(review.taskId)).map((r) => r.id),
    );
    return {
      reviews: reviews.filter((review) => !hidden.has(review.id)),
      receipts: receipts.filter((receipt) => !receipt.actionId || !hidden.has(receipt.actionId)),
    };
  }
  /** What the machine keeps of the agent, for the app to lay beside the board (which the chat service keeps). */
  async snapshot(owner: string): Promise<AgentMachineView> {
    const scope = await this.access.scope(owner);
    if (scope.person?.role === "guest") return this.guestSnapshot(owner);
    await this.ensure(owner);
    const [artifacts, identity] = await Promise.all([
      this.db.list<AgentArtifact>(owner, "agent-artifacts"),
      this.db.get<AgentIdentity>(owner, "agent-settings", "identity"),
    ]);
    const heartbeat =
      (await this.db.get<{ lastTickAt: string }>("system", "worker-status", "tasks")) ??
      (await this.db.get<{ lastTickAt: string }>(
        "system",
        "worker-status",
        `tasks:${ORCHESTRATOR_CHANNEL_ID}`,
      ));
    // What belongs to a task of a private channel or project is shown to those who may see the task.
    const visible = await this.visibleTaskIds(owner, [...artifacts.map((a) => a.taskId)]);
    return {
      notifications: [],
      ideas: [],
      artifacts: artifacts.filter((artifact) => !artifact.taskId || visible.has(artifact.taskId)),
      identity: identity ?? { name: "Hive", tone: "warm" },
      worker: {
        running:
          this.worker.running ||
          Boolean(heartbeat && Date.now() - Date.parse(heartbeat.lastTickAt) < 15000),
        lastTickAt: heartbeat?.lastTickAt ?? this.worker.lastTickAt,
      },
    };
  }
  async getTask(owner: string, id: string) {
    const task = await this.db.get<AgentTask>(owner, "tasks", id);
    if (!task) throw new AppError("Task not found", 404);
    return task;
  }
  /** What the machine keeps of a task's runs, for a person the chat service has checked may see the task. */
  async history(ask: { taskId: string; viewer: string; fileIds: string[]; browserIds: string[] }) {
    const { viewer: owner, taskId: id } = ask;
    const files = (await this.db.list<Artifact>(owner, "files")).filter((file) =>
      ask.fileIds.includes(file.id),
    );
    const browsers = (await this.db.list<BrowserSession>(owner, "browsers")).filter((browser) =>
      ask.browserIds.includes(browser.id),
    );
    return {
      files: files.map((file) => this.files.signed(owner, file)),
      browsers: browsers.map((browser) => this.browser.decorate(owner, browser)),
      events: (await this.db.listWhere<RunEvent>(owner, "run-events", "taskId", id))
        .sort((a, b) => a.date.localeCompare(b.date) || (a.sequence ?? 0) - (b.sequence ?? 0))
        .slice(-HISTORY_EVENTS),
      artifacts: await this.db.listWhere<AgentArtifact>(owner, "agent-artifacts", "taskId", id),
    };
  }
  /** The folder a task's runs work in, where its files are staged for the agent. */
  workspaceOf(task: AgentTask, owner: string): string {
    const channelId = task.originChannelId ?? ORCHESTRATOR_CHANNEL_ID;
    return channelWorkspaceDir(
      this.config.dataDir,
      diskOwnerForChannel(channelId, task.createdBy ?? owner),
      channelId,
    );
  }
  /**
   * The brief a run starts from, built from the task as it is now: notes and files can arrive
   * between a worker claiming the task and the run starting. With a `workspace` the files are copied
   * there for the agent to read; without one, short text files are pasted into the brief.
   */
  async prepareBrief(owner: string, claimed: AgentTask, workspace?: string) {
    const current = await this.db.get<AgentTask>(owner, "tasks", claimed.id);
    const task: AgentTask = {
      ...claimed,
      notes: current?.notes ?? claimed.notes,
      attachments: current?.attachments ?? claimed.attachments,
    };
    const names = await requesterNames(this.db, [
      ...(task.notes ?? []).map((note) => note.createdBy),
      ...(task.attachments ?? []).map((file) => file.addedBy),
    ]);
    const files: StagedFile[] = workspace
      ? await this.taskFiles.stage(task, workspace)
      : this.taskFiles.layout(task);
    const inline = workspace
      ? undefined
      : await this.taskFiles.readText(task, files, inlineLimits.file + 1);
    return {
      task,
      files,
      names,
      text: renderBrief({ task, names, files, staged: Boolean(workspace), inline }),
      /** The notes this brief is the first to carry. Mark them delivered once the agent has it. */
      noteIds: (task.notes ?? []).filter((note) => !note.delivered).map((note) => note.id),
    };
  }
  /** What was added to a task since its agent last heard: notes it has not read, files not yet in its workspace. */
  async pendingUpdate(owner: string, taskId: string, known: ReadonlySet<string>) {
    const task = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (!task) return null;
    const notes = (task.notes ?? []).filter((note) => !note.delivered);
    const files = (task.attachments ?? []).filter((file) => !known.has(file.id));
    return notes.length || files.length ? { task, notes, files } : null;
  }
  async markNotesDelivered(owner: string, taskId: string, noteIds: string[]) {
    if (noteIds.length)
      await this.db.patchItems(owner, "tasks", taskId, "notes", noteIds, { delivered: true });
  }
  async standInIds(): Promise<string[]> {
    return (await this.db.list<Channel>(SHARED_OWNER, "channels"))
      .filter((channel) => channel.createdBy === "chat")
      .map((channel) => channel.id);
  }
  /**
   * Take away everything this machine kept for a channel that was deleted in the chat service: the
   * agent's sessions in it, what it learned there, its folder and its record. Tasks are the projects',
   * not the channel's, and stay. Only a channel the machine holds as a stand-in is touched, and a failure part-way
   * leaves the record, so it is tried again when the machine next connects.
   */
  async purgeChannel(channelId: string): Promise<void> {
    if (channelId === ORCHESTRATOR_CHANNEL_ID) return;
    const channel = await this.db.get<Channel>(SHARED_OWNER, "channels", channelId);
    if (channel?.createdBy !== "chat") return;
    const directory = channelWorkspaceDir(this.config.dataDir, SHARED_OWNER, channelId);
    const runtime = this.opencodeRuntime;
    if (runtime)
      for (const binding of await this.threads.list(SHARED_OWNER, channelId))
        if (binding.opencodeSessionId)
          await runtime.pool
            .forDirectory(directory)
            .session.delete({ sessionID: binding.opencodeSessionId, directory })
            .catch(() => undefined);
    for (const kind of ["ideas"] as const)
      for (const item of await this.db.list<{ id: string; channelId?: string }>(SHARED_OWNER, kind))
        if (item.channelId === channelId) await this.db.remove(SHARED_OWNER, kind, item.id);
    await rm(directory, { recursive: true, force: true });
    await this.db.remove(SHARED_OWNER, "channels", channelId);
  }
  async refreshIdeas(owner: string) {
    if (!this.publishIdeas) throw new AppError("Ideas need a connection to the chat service", 503);
    const w = await this.workspace.snapshot(owner);
    const sent = (mail: Mail) => /^Sent\b/i.test(mail.label);
    const clip = (text: string, length: number) => Array.from(text).slice(0, length).join("");
    const ideas: IdeaBatch["ideas"] = [];
    for (const mail of w.mail
      .filter(
        (m) =>
          !sent(m) &&
          m.attachments.length &&
          /form|permission|complete|fill|sign/i.test(`${m.subject} ${m.body}`),
      )
      .slice(0, 5)) {
      ideas.push({
        id: hash(`document:${mail.id}:${mail.body}`),
        title: clip(`I can help with ${mail.subject}`, 160),
        reason: clip(
          `${mail.sender} sent a document that may need your attention. I can prepare it and a reply for your review.`,
          4000,
        ),
        evidence: [this.mailEvidence(mail)],
        prompt: clip(
          `Help complete the PDF from “${mail.subject}” and prepare a reply for review.`,
          12000,
        ),
        kind: "document",
        input: { messageId: mail.id },
        status: "new",
      });
    }
    for (const mail of w.mail
      .filter((m) => !sent(m) && /coffee|meet|available|schedule/i.test(`${m.subject} ${m.body}`))
      .slice(0, 5)) {
      ideas.push({
        id: hash(`coordination:${mail.id}`),
        title: clip(`I can help coordinate ${mail.subject}`, 160),
        reason: clip(
          `${mail.sender} mentioned getting together. I can check your calendar and prepare a response for review.`,
          4000,
        ),
        evidence: [this.mailEvidence(mail)],
        prompt: clip(
          `Review the email “${mail.subject}”, check my calendar, and propose a next step. Ask me about missing preferences before preparing a reply.`,
          12000,
        ),
        kind: "agent",
        input: { messageId: mail.id },
        status: "new",
      });
    }
    await this.publishIdeas({
      ideas,
      sentMessageIds: w.mail
        .filter(sent)
        .map((m) => m.id)
        .slice(0, 5000),
    });
    await this.ensure(owner);
    await this.db.compareAndSwap(owner, "agent-settings", "identity", {}, { lastIdeasAt: date() });
    return { queued: true };
  }
  mailEvidence(mail: Mail): Evidence {
    return {
      id: mail.id,
      kind: "mail",
      title: Array.from(mail.subject).slice(0, 500).join(""),
      excerpt: mail.body.slice(0, 400),
    };
  }
  async artifact(
    owner: string,
    task: AgentTask,
    kind: AgentArtifact["kind"],
    title: string,
    summary: string,
    data: Record<string, unknown>,
    key: string = kind,
  ) {
    const value: AgentArtifact = {
      id: hash(`${task.id}:${key}`),
      taskId: task.id,
      kind,
      title,
      summary,
      data,
      createdAt: date(),
    };
    await this.db.put(owner, "agent-artifacts", value);
    return value;
  }
  async prepare(
    owner: string,
    task: AgentTask,
    input: ProposalInput,
    key: string,
    context: TaskContext,
  ) {
    await context.guard();
    const connection = await this.workspace.connection(owner);
    if (connection?.id !== task.state.connectionId)
      throw new AppError(
        "Google connection changed during this task. Start a new task using the current account.",
        409,
      );
    const proposal = await this.actions.propose(owner, input, `${task.id}:${key}`, task.id);
    if (proposal.status === "succeeded") return proposal;
    if (proposal.status !== "awaiting_review" && proposal.status !== "executing")
      throw new AppError(
        `Reviewed action ${proposal.status}: ${proposal.error ?? "No further action was taken"}`,
        409,
      );
    try {
      await context.checkpoint({ actionId: proposal.id });
    } catch (error) {
      if (proposal.status === "awaiting_review")
        await this.actions.decide(owner, proposal.id, proposal.hash, "deny");
      throw error;
    }
    if (proposal.status === "awaiting_review")
      await context.event(
        "approval",
        proposal.title,
        `Review prepared for ${proposal.account ?? "the connected account"}`,
      );
    return proposal;
  }
  private async execute(
    owner: string,
    task: AgentTask,
    context: TaskContext,
  ): Promise<Partial<AgentTask>> {
    await context.event(
      "status",
      task.attempts === 1 ? "Started working" : "Resumed work",
      task.prompt,
    );
    if (task.actionId) {
      const action = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (!action) throw new Error("The linked review could not be found");
      if (action.status === "succeeded") {
        await context.event("result", "Approved action completed", action.result);
        if (task.kind === "document")
          return this.finish(task, context, action.result ?? "Reply completed");
        task = await context.checkpoint({
          state: { ...task.state, approvalResult: action.result },
          actionId: null,
        });
      } else if (action.status !== "awaiting_review" && action.status !== "executing")
        throw new Error(
          `Reviewed action ${action.status}: ${action.error ?? "No further action was taken"}`,
        );
      else return { status: "waiting_approval" };
    }
    if (task.kind === "document") return this.document(owner, task, context);
    if (task.kind === "finance") {
      await context.event("step", "Analyzing the imported transactions");
      const csv = z.string().parse(task.input.csv);
      const data = analyzeSpending(csv);
      const artifact = await this.artifact(
        owner,
        task,
        "finance",
        "Spending tracker",
        `${data.count} transactions · ${data.spending.toFixed(2)} spent`,
        data,
      );
      task = await context.checkpoint({
        artifactIds: [artifact.id],
        evidence: [
          {
            id: task.id,
            kind: "user",
            title: "Your transaction CSV",
            excerpt: `${data.count} rows; ${data.period.from} through ${data.period.to}`,
          },
        ],
      });
      return this.finish(task, context, artifact.summary);
    }
    return executeTask(this, owner, task, context);
  }
  /** Workflows that run as plain code (documents, watches, spending) finish themselves. */
  async finish(task: AgentTask, context: TaskContext, result: string) {
    await context.guard();
    await context.event("result", "Work completed", result);
    return {
      status: "succeeded" as const,
      result,
      plan: task.plan.map((s) => ({ ...s, status: "succeeded" as const })),
    };
  }
  /**
   * An agent's finished work goes to a person, who marks it done or sends it back (see `accept` and
   * `addNote`). `unconfirmed` is for a run that stopped without saying the work was complete.
   */
  async submitForReview(
    task: AgentTask,
    context: TaskContext,
    result: string,
    options: { unconfirmed?: boolean } = {},
  ) {
    await context.guard();
    await context.event(
      "result",
      options.unconfirmed ? "Stopped without saying it was done" : "Ready for your review",
      result,
    );
    return {
      status: "in_review" as const,
      result,
      state: { ...task.state, unconfirmed: Boolean(options.unconfirmed) },
      ...(options.unconfirmed
        ? {}
        : { plan: task.plan.map((s) => ({ ...s, status: "succeeded" as const })) }),
    };
  }
  /**
   * A person finished a task, or stopped it, in the chat service: what that sets going here is done. A review
   * the task was waiting on is declined, since nothing is waiting for it any more.
   */
  async outcome(task: AgentTask) {
    const owner = task.createdBy ?? SHARED_OWNER;
    if (task.status === "cancelled" && task.actionId) {
      const action = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (action?.status === "awaiting_review")
        await this.actions
          .decide(owner, action.id, action.hash, "deny")
          .catch((error) => backgroundFailure("decline a stopped task's review", error));
    }
  }
  private async document(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    let source = task.state.source as { mail: Mail; fileId: string } | undefined;
    if (!source) {
      const w = await this.workspace.snapshot(owner);
      const mail = w.mail.find((m) => m.id === task.input.messageId);
      if (!mail) throw new Error("Choose a current email with a PDF attachment to start this task");
      const ref = mail.attachments[0];
      if (!ref) throw new Error("This email has no PDF attachment");
      await ctx.guard();
      let file: Artifact;
      try {
        file = await this.files.get(owner, ref);
      } catch (error) {
        if (!(error instanceof AppError && error.status === 404)) throw error;
        file = await this.workspace.importAttachment(owner, ref);
      }
      source = { mail, fileId: file.id };
      task = await ctx.checkpoint({
        state: { ...task.state, source },
        evidence: [this.mailEvidence(mail)],
        plan: task.plan.map((s, i) => ({ ...s, status: i === 0 ? "succeeded" : "pending" })),
      });
      await ctx.event("step", "Found the document", file.name);
    }
    const fields = z
      .record(z.string(), z.union([z.string(), z.boolean()]))
      .optional()
      .parse(task.input.fields);
    if (!fields || !Object.keys(fields).length) {
      const file = await this.files.get(owner, source.fileId);
      const names = file.fields
        ?.filter((f) => f.type !== "unsupported")
        .map((f) => f.name)
        .join(", ");
      if (!names)
        throw new Error(
          "This PDF has no supported fillable fields. Open it in Files to review it.",
        );
      return {
        status: "waiting_input",
        question: `Enter the form values you want to use. Supported fields: ${names}. The original PDF will stay intact.`,
        state: {
          ...task.state,
          source,
          missingFields: file.fields?.filter((f) => f.type !== "unsupported"),
        },
      };
    }
    let filledId = typeof task.state.filledId === "string" ? task.state.filledId : undefined;
    if (!filledId) {
      await ctx.guard();
      const filled = await this.files.fill(owner, source.fileId, fields);
      filledId = filled.id;
      task = await ctx.checkpoint({
        state: { ...task.state, source, filledId },
        artifactIds: [filledId],
        plan: task.plan.map((s, i) => ({ ...s, status: i <= 1 ? "succeeded" : "pending" })),
      });
      await ctx.event("step", "Saved a filled copy", filled.name);
    }
    const input: ProposalInput = {
      kind: "email.send",
      data: {
        to: [source.mail.from],
        cc: [],
        bcc: [],
        subject: /^re:/i.test(source.mail.subject)
          ? source.mail.subject
          : `Re: ${source.mail.subject}`,
        body:
          typeof task.input.reply === "string"
            ? task.input.reply
            : "Hello,\n\nPlease find the completed form attached.\n\nThank you.",
        attachmentIds: [filledId],
        threadId: source.mail.threadId,
        replyToMessageId: source.mail.id,
      },
    };
    const proposal = await this.prepare(owner, task, input, "document-reply", ctx);
    return {
      status: "waiting_approval",
      actionId: proposal.id,
      plan: task.plan.map((s, i) => ({
        ...s,
        status: i < 3 ? "succeeded" : i === 3 ? "waiting" : "pending",
      })),
    };
  }
}
