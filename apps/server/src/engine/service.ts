import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  type AgentArtifact,
  type AgentIdentity,
  type AgentMemory,
  type AgentNotification,
  type AgentTask,
  type AgentWorkspace,
  addNoteSchema,
  type Channel,
  type ChannelThread,
  createChannelSchema,
  createProjectSchema,
  createTaskSchema,
  type Evidence,
  type Goal,
  goalInputSchema,
  type Idea,
  type Monitor,
  monitorInputSchema,
  ORCHESTRATOR_CHANNEL_ID,
  type Project,
  type RunEvent,
  type TaskAttachment,
  type TaskNote,
  type TaskStatus,
  taskBriefLimits,
  updateProjectSchema,
  updateTaskSchema,
} from "../../../../packages/domain/src/agent.ts";
import type {
  ActionProposal,
  Artifact,
  BrowserSession,
  Mail,
  ProposalInput,
} from "../../../../packages/domain/src/index.ts";
import type { ActionService } from "../actions.ts";
import type { BrowserService } from "../browser.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Files } from "../files.ts";
import { createJevService, type JevService } from "../jev/service.ts";
import { backgroundFailure } from "../log.ts";
import type { OpencodeTaskRuntime } from "../opencode/index.ts";
import { requesterNames, withRequester } from "../requesters.ts";
import type { WorkspaceService } from "../workspace.ts";
import { inlineLimits, renderBrief } from "./brief.ts";
import { ChannelFiles } from "./channel-files.ts";
import { ChannelManager } from "./channels.ts";
import { analyzeSpending } from "./finance.ts";
import { executeTask } from "./task-executor.ts";
import { inspectAttachment, type StagedFile, TaskFiles } from "./task-files.ts";
import {
  channelWorkspaceDir,
  diskOwnerForChannel,
  LocalDiskThreadStore,
  SHARED_OWNER,
  type ThreadBindingStore,
} from "./threads.ts";
import { UploadRequests } from "./upload-requests.ts";
import { LostLeaseError, type TaskContext, TaskWorker } from "./worker.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const date = () => new Date().toISOString();
const terminal = new Set(["succeeded", "failed", "cancelled"]);
export class AgentService {
  readonly worker: TaskWorker;
  private maintenance?: ReturnType<typeof setInterval>;
  private refreshing = false;
  private channels?: ChannelManager;
  /** threadId → binding, keyed `${owner}/${threadId}`. Invalidated on write. */
  private readonly threadChannelCache = new Map<string, ChannelThread>();
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
    this.taskFiles = new TaskFiles(config.dataDir);
    this.channelFiles = new ChannelFiles(config, files, (owner, id) => this.getChannel(owner, id));
    this.uploadRequests = new UploadRequests(db);
    this.worker = new TaskWorker(db, (owner, task, context) => this.execute(owner, task, context), {
      settled: (owner, task) => this.publishOutcome(owner, task),
      // In orchestrator mode the main process only runs orchestrator-channel tasks;
      // per-channel workers (spawned separately) claim their own channels.
      channelId: config.manageChannels ? ORCHESTRATOR_CHANNEL_ID : config.workerChannelId,
    });
  }
  start() {
    this.worker.start();
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
      // Recover publications if the process exited after committing an outcome.
      for (const { owner, value } of await this.db.scan<AgentTask>("tasks"))
        await this.publishOutcome(value.createdBy ?? owner, value);
      for (const { owner, value } of await this.db.scan<Monitor>("monitors"))
        await this.activateMonitor(owner, value);
      for (const { owner, value } of await this.db.scan<Idea>("ideas"))
        if (
          value.status === "accepted" &&
          value.taskId &&
          !(await this.db.get(owner, "tasks", value.taskId))
        )
          await this.decideIdea(owner, value.id, "accept").catch(async (error) => {
            backgroundFailure("recover accepted idea", error);
            await this.notify(
              owner,
              "Accepted idea needs attention",
              "Open the idea again after making room for another task.",
              undefined,
              `idea-recovery:${value.id}`,
            );
          });
      for (const { owner, value } of await this.db.scan<{ id: string; lastIdeasAt?: string }>(
        "agent-settings",
      )) {
        if (value.id !== "identity") continue;
        if (!value.lastIdeasAt || Date.now() - Date.parse(value.lastIdeasAt) > 15 * 60000)
          await this.refreshIdeas(owner).catch(async () => {
            await this.notify(
              owner,
              "Source refresh needs attention",
              "Reconnect the source or refresh Ideas to see the error.",
              undefined,
              `source-error:${Math.floor(Date.now() / 3600000)}`,
            );
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
  /** Persist a channel under its owner (shared, or the user's own orchestrator). */
  private async putChannel(owner: string, channel: Channel): Promise<void> {
    await this.db.put(this.channelOwner(channel.id, owner), "channels", channel);
  }
  async listChannels(owner: string): Promise<Channel[]> {
    await this.ensureOrchestratorChannel(owner);
    const shared = await this.db.list<Channel>(SHARED_OWNER, "channels");
    const orchestrator = await this.db.get<Channel>(owner, "channels", ORCHESTRATOR_CHANNEL_ID);
    return orchestrator ? [...shared, orchestrator] : shared;
  }
  async createChannel(owner: string, raw: unknown): Promise<Channel> {
    const input = createChannelSchema.parse(raw);
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
  async archiveChannel(id: string): Promise<Channel> {
    if (id === ORCHESTRATOR_CHANNEL_ID)
      throw new AppError("The orchestrator channel cannot be archived", 409);
    const channel = await this.db.get<Channel>(SHARED_OWNER, "channels", id);
    if (!channel) throw new AppError("Channel not found", 404);
    const updated: Channel = {
      ...channel,
      status: "archived",
      updatedAt: new Date().toISOString(),
    };
    await this.db.put(SHARED_OWNER, "channels", updated);
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
    await this.putChannel(owner, {
      ...channel,
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
  /** Reverse lookup: which channel does this thread belong to? Cached. */
  async channelOfThread(owner: string, threadId: string): Promise<ChannelThread | null> {
    const key = `${owner}/${threadId}`;
    const cached = this.threadChannelCache.get(key);
    if (cached) return cached;
    const all = await this.threads.scan(owner);
    this.threadChannelCache.clear();
    for (const binding of all) this.threadChannelCache.set(`${owner}/${binding.threadId}`, binding);
    return this.threadChannelCache.get(key) ?? null;
  }
  /** A thread's work queue: tasks delegated from it, in creation order. */
  async threadTasks(owner: string, threadId: string): Promise<AgentTask[]> {
    const tasks = await this.db.list<AgentTask>(owner, "tasks");
    return tasks
      .filter((t) => t.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  /**
   * Tasks visible in a channel: owned by it, or delegated elsewhere but requested here. Everyone
   * sees a shared channel's work; the orchestrator is each person's own, so it lists theirs.
   */
  async channelTasks(owner: string, channelId: string): Promise<AgentTask[]> {
    const tasks = await this.db.list<AgentTask>(owner, "tasks");
    return tasks.filter(
      (t) =>
        ((t.channelId ?? ORCHESTRATOR_CHANNEL_ID) === channelId ||
          (t.originChannelId ?? ORCHESTRATOR_CHANNEL_ID) === channelId) &&
        (channelId !== ORCHESTRATOR_CHANNEL_ID || (t.createdBy ?? owner) === owner),
    );
  }
  /**
   * Hand a task to the orchestrator or another channel. The task keeps its
   * origin channel so status stays visible where the work was requested.
   * Only non-running tasks can be delegated; a worker mid-execution should
   * checkpoint to waiting first.
   */
  async delegateTask(
    owner: string,
    id: string,
    target: string,
    reason?: string,
  ): Promise<AgentTask> {
    const task = await this.getTask(owner, id);
    if (task.status === "running" && task.leaseId)
      throw new AppError("Task is running; checkpoint it to waiting before delegating", 409);
    if (target !== ORCHESTRATOR_CHANNEL_ID) {
      const channel = await this.getChannel(owner, target);
      if (!channel || channel.status === "archived")
        throw new AppError("Target channel not found", 404);
    }
    const updated: AgentTask = {
      ...task,
      originChannelId: task.originChannelId ?? task.channelId ?? ORCHESTRATOR_CHANNEL_ID,
      channelId: target,
      delegatedTo: target,
      delegationReason: reason?.slice(0, 500),
      // Paused work stays paused, and work waiting for review stays that way: moving it to another
      // channel must not send it back to the agent.
      status: task.status === "paused" || task.status === "in_review" ? task.status : "queued",
      leaseId: null,
      leaseUntil: null,
      updatedAt: new Date().toISOString(),
    };
    await this.db.put(owner, "tasks", updated);
    const channel = await this.getChannel(owner, target);
    if (channel)
      await this.putChannel(owner, {
        ...channel,
        status: "active",
        lastActiveAt: new Date().toISOString(),
      });
    return updated;
  }
  async snapshot(owner: string): Promise<AgentWorkspace> {
    await this.ensure(owner);
    const [tasks, goals, projects, monitors, ideas, memories, artifacts, notifications, identity] =
      await Promise.all([
        this.db.list<AgentTask>(owner, "tasks"),
        this.db.list<Goal>(owner, "goals"),
        this.db.list<Project>(owner, "projects"),
        this.db.list<Monitor>(owner, "monitors"),
        this.db.list<Idea>(owner, "ideas"),
        this.db.list<AgentMemory>(owner, "memories"),
        this.db.list<AgentArtifact>(owner, "agent-artifacts"),
        this.db.list<AgentNotification>(owner, "notifications"),
        this.db.get<AgentIdentity>(owner, "agent-settings", "identity"),
      ]);
    const heartbeat =
      (await this.db.get<{ lastTickAt: string }>("system", "worker-status", "tasks")) ??
      (await this.db.get<{ lastTickAt: string }>(
        "system",
        "worker-status",
        `tasks:${ORCHESTRATOR_CHANNEL_ID}`,
      ));
    return {
      tasks: await this.present(owner, tasks),
      goals,
      projects,
      monitors,
      ideas,
      memories,
      artifacts,
      notifications,
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
  /**
   * Tasks as a client sees them: who asked, who wrote each note and added each file, and a signed
   * download link for each file. The names and links are for display and are never stored.
   */
  private async present(owner: string, tasks: AgentTask[]): Promise<AgentTask[]> {
    const names = await requesterNames(
      this.db,
      tasks.flatMap((task) => [
        task.createdBy,
        ...(task.notes ?? []).map((note) => note.createdBy),
        ...(task.attachments ?? []).map((file) => file.addedBy),
      ]),
    );
    const nameOf = (id?: string) => (id ? names.get(id) : undefined);
    return tasks.map((task) => {
      const named = withRequester(task, names);
      if (!named.notes?.length && !named.attachments?.length) return named;
      return {
        ...named,
        ...(named.notes && {
          notes: named.notes.map((note) => ({
            ...note,
            createdByName: nameOf(note.createdBy),
            mine: note.createdBy === owner,
          })),
        }),
        ...(named.attachments && {
          attachments: named.attachments.map((file) => ({
            ...file,
            addedByName: nameOf(file.addedBy),
            mine: file.addedBy === owner,
            url: this.files.signPath(
              owner,
              `/api/agent/tasks/${task.id}/attachments/${file.id}/content`,
            ),
          })),
        }),
      };
    });
  }
  async detail(owner: string, id: string) {
    const task = await this.getTask(owner, id);
    const files = (await this.db.list<Artifact>(owner, "files")).filter((file) =>
      task.artifactIds.includes(file.id),
    );
    const browsers = (await this.db.list<BrowserSession>(owner, "browsers")).filter((browser) =>
      [task.state.browserId, task.state.sessionId].includes(browser.id),
    );
    return {
      task: (await this.present(owner, [task]))[0],
      files: files.map((file) => this.files.signed(owner, file)),
      browsers: browsers.map((browser) => this.browser.decorate(owner, browser)),
      events: (await this.db.listWhere<RunEvent>(owner, "run-events", "taskId", id)).sort(
        (a, b) => a.date.localeCompare(b.date) || (a.sequence ?? 0) - (b.sequence ?? 0),
      ),
      artifacts: await this.db.listWhere<AgentArtifact>(owner, "agent-artifacts", "taskId", id),
    };
  }
  async createTask(owner: string, raw: unknown, idempotencyKey?: string, held = false) {
    const input = createTaskSchema.parse(raw);
    if (input.goalId && !(await this.db.get(owner, "goals", input.goalId)))
      throw new AppError("Goal not found", 404);
    if (input.projectId) await this.requireProject(owner, input.projectId);
    const channelId = input.channelId ?? ORCHESTRATOR_CHANNEL_ID;
    if (channelId !== ORCHESTRATOR_CHANNEL_ID && !(await this.getChannel(owner, channelId)))
      throw new AppError("Channel not found", 404);
    const id = idempotencyKey ? hash(`task:${idempotencyKey}`) : randomUUID();
    const existing = await this.db.get<AgentTask>(owner, "tasks", id);
    if (existing) return existing;
    if (input.blockedBy.length) await this.checkBlockedBy(owner, id, input.blockedBy);
    if (
      (await this.db.list<AgentTask>(owner, "tasks")).filter(
        (t) => !terminal.has(t.status) && (t.createdBy ?? owner) === owner,
      ).length >= 100
    )
      throw new AppError("Finish or cancel some tasks before adding more", 409);
    // Only the workflows that run as code have steps to start with, because the code ticks them off.
    // What an agent does has none: its plan is the todo list the agent keeps as it works.
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
    const isManual = input.kind === "manual";
    if (!isManual && !input.prompt)
      throw new AppError("A prompt is required for agent-executed tasks", 422);
    if (input.startAt && input.dueAt && input.startAt > input.dueAt)
      throw new AppError("startAt must not be after dueAt", 422);
    const task: AgentTask = {
      id,
      title: input.title ?? input.prompt?.slice(0, 90) ?? "Untitled task",
      prompt: input.prompt ?? "",
      kind: input.kind,
      goalId: input.goalId,
      projectId: input.projectId ?? null,
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
      plan: titles.map((title, i) => ({ id: String(i), title, status: "pending" })),
      evidence: [],
      input: input.input,
      state: {
        connectionId: (await this.workspace.connection(owner))?.id ?? null,
        ...(held && input.kind === "monitor" ? { initializingMonitor: true } : {}),
      },
      createdAt: date(),
      updatedAt: date(),
      attempts: 0,
      leaseId: null,
      leaseUntil: null,
      artifactIds: [],
    };
    await this.ensure(owner);
    await this.db.insertIfAbsent(owner, "tasks", task);
    const channel = await this.getChannel(owner, channelId);
    if (channel)
      await this.putChannel(owner, {
        ...channel,
        status: "active",
        lastActiveAt: new Date().toISOString(),
      });
    return (await this.db.get<AgentTask>(owner, "tasks", id)) ?? task;
  }
  async control(owner: string, id: string, action: "pause" | "resume" | "cancel" | "retry") {
    const task = await this.getTask(owner, id);
    if (action === "cancel" && task.status === "succeeded")
      throw new AppError("This task is already complete", 409);
    if (action === "retry" && task.status !== "failed")
      throw new AppError("Only failed tasks can be retried", 409);
    if (action === "resume" && task.status !== "paused")
      throw new AppError("Only paused tasks can be resumed", 409);
    // Finished work waits for a person, not for the worker: there is nothing to pause.
    if (
      action === "pause" &&
      (terminal.has(task.status) || task.status === "paused" || task.status === "in_review")
    )
      return task;
    const status =
      action === "cancel"
        ? "cancelled"
        : action === "pause"
          ? "paused"
          : task.actionId
            ? "waiting_approval"
            : "queued";
    if (action === "retry" && task.actionId) {
      const a = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (a && a.status !== "succeeded")
        throw new AppError(
          "Check the reviewed action before retrying; its outcome may be uncertain. Start a new task when reconciled.",
          409,
        );
    }
    const updated = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: task.status, leaseId: task.leaseId ?? null },
      {
        status,
        leaseId: null,
        leaseUntil: null,
        error: null,
        updatedAt: date(),
        result:
          action === "cancel"
            ? "Stopped by you."
            : action === "pause"
              ? "Paused. Resume when you're ready."
              : "",
        ...(task.kind === "monitor" && action === "resume"
          ? { state: { ...task.state, failures: 0, notice: null, resumingMonitor: false } }
          : {}),
      },
    );
    if (!updated) throw new AppError("Task changed; refresh and try again", 409);
    this.worker.abort(id);
    if (task.kind === "monitor")
      await this.db.compareAndSwap(
        owner,
        "monitors",
        String(task.input.monitorId),
        {},
        {
          status: action === "cancel" ? "stopped" : action === "pause" ? "paused" : "active",
          nextCheckAt: date(),
          // Clearing the error fences out a failure reconcile that read the task before this.
          ...(action === "resume" || action === "retry" ? { error: null } : {}),
        },
      );
    if (action === "cancel" && task.actionId) {
      const proposal = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (proposal?.status === "awaiting_review")
        await this.actions.decide(owner, proposal.id, proposal.hash, "deny");
    }
    await this.db.put(owner, "run-events", {
      id: randomUUID(),
      taskId: id,
      kind: "status",
      date: date(),
      title: `Task ${status}`,
      detail: "Changed by you",
    });
    return updated;
  }
  /** Statuses a user or the agent may set directly on a worker-executed task. */
  private static readonly userSettableWorkerStatuses: ReadonlySet<TaskStatus> = new Set([
    "queued",
    "paused",
    "cancelled",
  ]);
  /** Manual (human) tasks move freely; they have no worker lifecycle. */
  private static readonly manualStatuses: ReadonlySet<TaskStatus> = new Set([
    "queued",
    "running",
    "paused",
    "succeeded",
    "failed",
    "cancelled",
  ]);
  /**
   * Hand a manual issue to the agent and queue it, so the worker claims it like any agent task. The
   * description stays as written. Each run's brief is built from it, the notes and files on the
   * task, and (unless the person declines) a snapshot of the channel discussion taken now.
   */
  private async assignToAgent(
    task: AgentTask,
    patch: Partial<AgentTask>,
    channelContext: boolean,
  ): Promise<void> {
    if (task.kind !== "manual")
      throw new AppError("Only manual issues can be assigned to the agent", 422);
    const context = channelContext ? await this.channelContextForTask(task) : null;
    const { discussion: _earlier, ...input } = task.input ?? {};
    patch.kind = "agent";
    patch.status = "queued";
    patch.assignee = "agent";
    patch.leaseId = null;
    patch.leaseUntil = null;
    patch.input = {
      ...input,
      ...(context ? { discussion: { channel: context.name, lines: context.lines } } : {}),
    };
  }

  /** Take a ticket back from the agent: cancel any in-flight run and restore the manual issue. */
  private unassignFromAgent(task: AgentTask, patch: Partial<AgentTask>): void {
    if (task.assignee !== "agent" || task.kind === "manual")
      throw new AppError("Task is not assigned to the agent", 422);
    const active = [
      "queued",
      "paused",
      "scheduled",
      "running",
      "waiting_approval",
      "waiting_input",
    ];
    // Issues handed over before descriptions were kept as written had the original text set aside.
    const { manualNotes, discussion: _discussion, ...restInput } = task.input ?? {};
    patch.kind = "manual";
    patch.assignee = null;
    patch.prompt = typeof manualNotes === "string" ? manualNotes : task.prompt;
    patch.input = restInput;
    patch.leaseId = null;
    patch.leaseUntil = null;
    // A ticket pulled back mid-run is stopped. Work waiting for review goes back to the to-do
    // column, still not accepted. An untouched ticket keeps its column.
    patch.status =
      task.status === "in_review"
        ? "queued"
        : active.includes(task.status)
          ? "cancelled"
          : task.status;
  }

  /** Recent channel discussion to ground an agent-assigned issue. Null when there is nothing useful. */
  private async channelContextForTask(
    task: AgentTask,
  ): Promise<{ name: string; lines: string } | null> {
    const channelId = task.channelId;
    if (!channelId || channelId === ORCHESTRATOR_CHANNEL_ID) return null;
    const [channel, transcript] = await Promise.all([
      this.db.get<Channel>("shared", "channels", channelId).catch(() => null),
      this.db
        .get<{ messages?: { role?: string; name?: string; content?: unknown }[] }>(
          "shared",
          "conversations",
          `channel:${channelId}`,
        )
        .catch(() => null),
    ]);
    const textOf = (content: unknown): string => {
      if (typeof content === "string") return content;
      if (Array.isArray(content))
        return content
          .filter(
            (p) => typeof p === "object" && p !== null && (p as { type?: string }).type === "text",
          )
          .map((p) => String((p as { text?: string }).text ?? ""))
          .join("");
      return "";
    };
    const lines = (transcript?.messages ?? [])
      .filter((m) => (m.role === "user" || m.role === "assistant") && textOf(m.content).trim())
      .slice(-15)
      .map((m) => {
        const who = m.role === "user" ? m.name?.trim() || "Someone" : "Hive";
        return `${who}: ${textOf(m.content).trim().slice(0, 500)}`;
      });
    if (!lines.length) return null;
    return { name: channel?.name ?? channelId, lines: lines.join("\n") };
  }

  /**
   * Update a task's fields. The agent uses this to manage the board, but only a person can mark a
   * task done: the agent does the work, and whether it is good enough is their call.
   */
  async updateTask(
    owner: string,
    id: string,
    raw: unknown,
    by: "person" | "agent" = "person",
  ): Promise<AgentTask> {
    const input = updateTaskSchema.parse(raw);
    if (by === "agent" && input.status === "succeeded")
      throw new AppError(
        "Only a person can mark a task done. Tell them it is ready and they will mark it done.",
        403,
      );
    const task = await this.getTask(owner, id);
    const patch: Partial<AgentTask> = {};
    if (input.assignee !== undefined && input.assignee !== (task.assignee ?? null)) {
      if (input.status !== undefined || input.prompt !== undefined)
        throw new AppError("Cannot change assignee together with status or prompt", 422);
      if (input.assignee === "agent")
        await this.assignToAgent(task, patch, input.channelContext ?? true);
      else this.unassignFromAgent(task, patch);
    }
    if (input.title !== undefined) patch.title = input.title;
    if (input.prompt !== undefined) {
      // A manual task's description may be cleared; an agent's instructions may not.
      if (!input.prompt && task.kind !== "manual")
        throw new AppError("A prompt is required for agent-executed tasks", 422);
      patch.prompt = input.prompt;
    }
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.goalId !== undefined) {
      if (input.goalId && !(await this.db.get(owner, "goals", input.goalId)))
        throw new AppError("Goal not found", 404);
      patch.goalId = input.goalId ?? undefined;
    }
    if (input.projectId !== undefined) {
      if (input.projectId) await this.requireProject(owner, input.projectId);
      patch.projectId = input.projectId;
    }
    const startAt = input.startAt !== undefined ? input.startAt : (task.startAt ?? null);
    const dueAt = input.dueAt !== undefined ? input.dueAt : (task.dueAt ?? null);
    if (startAt && dueAt && startAt > dueAt)
      throw new AppError("startAt must not be after dueAt", 422);
    if (input.startAt !== undefined) patch.startAt = input.startAt;
    if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
    if (input.blockedBy !== undefined) {
      await this.checkBlockedBy(owner, id, input.blockedBy);
      patch.blockedBy = input.blockedBy;
    }
    if (input.labels !== undefined) patch.labels = input.labels;
    if (input.status !== undefined && input.status !== task.status) {
      const allowed =
        task.kind === "manual"
          ? AgentService.manualStatuses
          : AgentService.userSettableWorkerStatuses;
      if (!allowed.has(input.status))
        throw new AppError(
          task.kind === "manual"
            ? `Manual tasks can move between ${[...AgentService.manualStatuses].join(", ")}`
            : "Worker-executed tasks can only be queued, paused, or cancelled directly. Running belongs to the worker, and agent work is marked done by a person once it is ready for review",
          422,
        );
      // Terminal tasks can be reopened; the worker picks up a requeued
      // task as a fresh run and prior results stay as history.
      patch.status = input.status;
      patch.leaseId = null;
      patch.leaseUntil = null;
      if (input.status === "cancelled") {
        patch.result = "Stopped by you.";
        patch.error = null;
      }
    }
    if (!Object.keys(patch).length) return task;
    const updated = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: task.status, leaseId: task.leaseId ?? null },
      { ...patch, updatedAt: date() },
    );
    if (!updated) throw new AppError("Task changed; refresh and try again", 409);
    if (patch.status && patch.status !== task.status) {
      this.worker.abort(id);
      await this.db.put(owner, "run-events", {
        id: randomUUID(),
        taskId: id,
        kind: "status",
        date: date(),
        title: `Task ${patch.status}`,
        detail: "Changed by you",
      });
    }
    return updated;
  }
  private async checkBlockedBy(owner: string, id: string, blockedBy: string[]) {
    const seen = new Set(blockedBy);
    if (seen.has(id)) throw new AppError("A task cannot depend on itself", 422);
    for (const depId of seen)
      if (!(await this.db.get<AgentTask>(owner, "tasks", depId)))
        throw new AppError(`Dependency not found: ${depId}`, 404);
    // Cycle check: the task itself must be unreachable from its dependencies.
    const stack = [...seen];
    const visited = new Set<string>();
    while (stack.length) {
      const current = stack.pop() as string;
      if (current === id) throw new AppError("Dependencies would create a cycle", 422);
      if (visited.has(current)) continue;
      visited.add(current);
      const dep = await this.db.get<AgentTask>(owner, "tasks", current);
      for (const next of dep?.blockedBy ?? []) stack.push(next);
    }
  }
  /** Delete a task and drop it from other tasks' dependencies. */
  async deleteTask(owner: string, id: string): Promise<{ deleted: string }> {
    const task = await this.getTask(owner, id);
    if (task.leaseId && (task.status === "running" || task.status === "waiting_approval"))
      throw new AppError("Stop the task before deleting it", 409);
    this.worker.abort(id);
    await this.db.remove(owner, "tasks", id);
    // Its files go too: the stored bytes and any copies left in the agent's workspace.
    await this.taskFiles
      .removeAll(id, this.workspaceOf(task, owner))
      .catch((error) => backgroundFailure("remove task files", error));
    for (const other of await this.db.list<AgentTask>(owner, "tasks"))
      if (other.blockedBy.includes(id))
        await this.db.put(owner, "tasks", {
          ...other,
          blockedBy: other.blockedBy.filter((dep) => dep !== id),
          updatedAt: date(),
        });
    return { deleted: id };
  }
  /**
   * Answer the question a task is waiting on. The answer joins the task's notes, so the agent keeps
   * it in view on every later run, and the task is queued in the same statement: a worker can never
   * pick it up without the answer.
   */
  async answer(
    owner: string,
    id: string,
    answer: string,
    fields?: Record<string, string | boolean>,
  ) {
    const task = await this.getTask(owner, id);
    if (task.status !== "waiting_input")
      throw new AppError("This task is not waiting for input", 409);
    const next = await this.db.appendItem<AgentTask>(
      owner,
      "tasks",
      id,
      "notes",
      this.newNote(owner, answer, "answer"),
      {
        where: { status: "waiting_input" },
        merge: {
          status: "queued",
          question: null,
          input: { ...task.input, ...(fields ? { fields } : {}) },
          updatedAt: date(),
        },
      },
    );
    if (!next) throw new AppError("Task changed; refresh and try again", 409);
    return next;
  }
  private newNote(owner: string, text: string, kind: TaskNote["kind"]): TaskNote {
    return { id: randomUUID(), text, kind, createdAt: date(), createdBy: owner, delivered: false };
  }
  private async personName(owner: string): Promise<string> {
    return (await requesterNames(this.db, [owner])).get(owner) ?? "Someone";
  }
  private async logInstruction(owner: string, taskId: string, title: string, detail: string) {
    await this.db.put(owner, "run-events", {
      id: randomUUID(),
      taskId,
      kind: "instruction",
      date: date(),
      title,
      detail,
    } satisfies RunEvent);
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
  /** Where a task can be sent back from: the agent has stopped, and is waiting on or finished with the team. */
  private static readonly sendBackFrom: ReadonlySet<TaskStatus> = new Set([
    "in_review",
    "waiting_input",
    "failed",
    "cancelled",
    "succeeded",
  ]);
  /**
   * Add a note to a task. Notes are the team's running instructions: every run reads all of them,
   * and one added while the agent works is sent to its running session. With `run` the task also
   * goes back to the agent (from review, a failure, a question, or done). The note and the new
   * status land in one statement, so a worker never starts without the note.
   */
  async addNote(owner: string, id: string, raw: unknown): Promise<AgentTask> {
    const input = addNoteSchema.parse(raw);
    const task = await this.getTask(owner, id);
    if (input.run) {
      if (task.kind === "manual")
        throw new AppError("Hand this task to the agent before sending it a note to run", 422);
      if (task.kind !== "agent" && task.kind !== "plan")
        throw new AppError("This kind of task does not take notes into a new run", 422);
    }
    const sendBack = Boolean(input.run) && AgentService.sendBackFrom.has(task.status);
    // Running again after a failure or a stop is retrying: the same care applies as for a retry.
    if (
      sendBack &&
      task.actionId &&
      task.status !== "in_review" &&
      task.status !== "waiting_input"
    ) {
      const action = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (action && action.status !== "succeeded")
        throw new AppError(
          "Check the reviewed action before running this again; its outcome may be uncertain.",
          409,
        );
    }
    const note = this.newNote(
      owner,
      input.text,
      sendBack && task.status === "waiting_input"
        ? "answer"
        : sendBack && task.status === "in_review"
          ? "feedback"
          : "note",
    );
    const max = taskBriefLimits.notes;
    let saved = sendBack
      ? await this.db.appendItem<AgentTask>(owner, "tasks", id, "notes", note, {
          max,
          where: { status: task.status, leaseId: task.leaseId ?? null },
          merge: {
            status: "queued",
            error: null,
            question: null,
            leaseId: null,
            leaseUntil: null,
            updatedAt: date(),
          },
        })
      : null;
    // Not sent back, or the task moved on since it was read: the note is kept either way.
    saved ??= await this.db.appendItem<AgentTask>(owner, "tasks", id, "notes", note, {
      max,
      merge: { updatedAt: date() },
    });
    if (!saved) {
      if (!(await this.db.get(owner, "tasks", id))) throw new AppError("Task not found", 404);
      throw new AppError(`A task can carry ${max} notes. Remove one first.`, 409);
    }
    const who = await this.personName(owner);
    await this.logInstruction(
      owner,
      id,
      `${who} ${note.kind === "feedback" ? "asked for changes" : note.kind === "answer" ? "answered" : "added a note"}`,
      input.text,
    );
    return (await this.present(owner, [saved]))[0];
  }
  /** Take back a note before the agent has read it. Only its author can. */
  async removeNote(owner: string, id: string, noteId: string): Promise<AgentTask> {
    const task = await this.getTask(owner, id);
    const note = task.notes?.find((entry) => entry.id === noteId);
    if (!note) throw new AppError("Note not found", 404);
    if (note.createdBy !== owner) throw new AppError("You can only remove your own notes", 403);
    if (note.delivered)
      throw new AppError(
        "The agent has already read this note. Add a new note to change course.",
        409,
      );
    const saved = await this.db.removeItem<AgentTask>(owner, "tasks", id, "notes", noteId, {
      updatedAt: date(),
    });
    if (!saved) throw new AppError("Task not found", 404);
    return (await this.present(owner, [saved]))[0];
  }
  private readonly attaching = new Map<string, Promise<unknown>>();
  /** One at a time per task, so the size limits hold when several files arrive together. */
  private async oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.attaching.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.attaching.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.attaching.get(key) === tail) this.attaching.delete(key);
    }
  }
  /** Attach a file to a task: a PDF, an image, or a text, Markdown, CSV or JSON file. */
  async addAttachment(
    owner: string,
    id: string,
    upload: { name: string; bytes: Uint8Array },
  ): Promise<AgentTask> {
    const checked = inspectAttachment(upload.name, upload.bytes);
    const saved = await this.oneAtATime(id, async () => {
      const task = await this.getTask(owner, id);
      const held = task.attachments ?? [];
      if (held.length >= taskBriefLimits.attachments)
        throw new AppError(
          `A task can carry ${taskBriefLimits.attachments} files. Remove one first.`,
          409,
        );
      if (
        held.reduce((total, file) => total + file.size, 0) + upload.bytes.length >
        taskBriefLimits.attachmentTotalBytes
      )
        throw new AppError(
          `The files on a task can total ${taskBriefLimits.attachmentTotalBytes / (1024 * 1024)} MB. Remove one first.`,
          413,
        );
      const attachment: TaskAttachment = {
        id: randomUUID(),
        name: checked.name,
        mimeType: checked.mimeType,
        size: upload.bytes.length,
        addedAt: date(),
        addedBy: owner,
      };
      // A PDF is also kept in Files, which checks that it opens and lets the agent's PDF tools read it.
      if (checked.mimeType === "application/pdf")
        attachment.fileId = (
          await this.files.import(owner, checked.name, upload.bytes, "Attached to a task")
        ).id;
      await this.taskFiles.save(id, attachment.id, upload.bytes);
      const next = await this.db.appendItem<AgentTask>(
        owner,
        "tasks",
        id,
        "attachments",
        attachment,
        { max: taskBriefLimits.attachments, merge: { updatedAt: date() } },
      );
      if (!next) {
        await this.taskFiles.remove(id, attachment.id);
        throw new AppError("Task not found", 404);
      }
      return { next, attachment };
    });
    await this.logInstruction(
      owner,
      id,
      `${await this.personName(owner)} attached a file`,
      saved.attachment.name,
    );
    return (await this.present(owner, [saved.next]))[0];
  }
  /** Take a file off a task. Only the person who attached it can. */
  async removeAttachment(owner: string, id: string, attachmentId: string): Promise<AgentTask> {
    const task = await this.getTask(owner, id);
    const file = task.attachments?.find((entry) => entry.id === attachmentId);
    if (!file) throw new AppError("File not found", 404);
    if (file.addedBy !== owner) throw new AppError("You can only remove files you attached", 403);
    const saved = await this.db.removeItem<AgentTask>(
      owner,
      "tasks",
      id,
      "attachments",
      attachmentId,
      { updatedAt: date() },
    );
    if (!saved) throw new AppError("Task not found", 404);
    await this.taskFiles.remove(id, attachmentId);
    return (await this.present(owner, [saved]))[0];
  }
  async attachmentContent(owner: string, id: string, attachmentId: string) {
    const task = await this.getTask(owner, id);
    const file = task.attachments?.find((entry) => entry.id === attachmentId);
    if (!file) throw new AppError("File not found", 404);
    return { file, bytes: await this.taskFiles.read(id, attachmentId) };
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
  /**
   * A person's decision that the agent's work is done. This is the only way agent work reaches
   * "succeeded": the agent hands work in for review and never closes a task itself.
   */
  async accept(owner: string, id: string): Promise<AgentTask> {
    const task = await this.getTask(owner, id);
    if (task.status !== "in_review")
      throw new AppError("Only work that is ready for review can be marked done", 409);
    const updated = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: "in_review" },
      { status: "succeeded", error: null, updatedAt: date() },
    );
    if (!updated) throw new AppError("Task changed; refresh and try again", 409);
    await this.db.put(owner, "run-events", {
      id: randomUUID(),
      taskId: id,
      kind: "status",
      date: date(),
      title: "Marked done",
      detail: `By ${await this.personName(owner)}`,
    } satisfies RunEvent);
    // The task is already done; a failure here is retried by maintenance.
    await this.publishOutcome(owner, updated).catch((error) =>
      backgroundFailure("publish accepted task", error),
    );
    return (await this.present(owner, [updated]))[0];
  }
  async createGoal(owner: string, raw: unknown, id?: string) {
    const input = goalInputSchema.parse(raw);
    const goal: Goal = {
      id: id ?? randomUUID(),
      title: input.title,
      description: input.description,
      category: input.category,
      status: "active",
      milestones: input.milestones.map((title) => ({ id: randomUUID(), title, done: false })),
      createdAt: date(),
      createdBy: owner,
    };
    await this.db.insertIfAbsent(owner, "goals", goal);
    return (await this.db.get<Goal>(owner, "goals", goal.id)) ?? goal;
  }
  async updateGoal(
    owner: string,
    id: string,
    patch: { status?: Goal["status"]; milestones?: Goal["milestones"] },
  ) {
    const goal = await this.db.get<Goal>(owner, "goals", id);
    if (!goal) throw new AppError("Goal not found", 404);
    const saved = await this.db.put(owner, "goals", { ...goal, ...patch });
    if (patch.status === "paused")
      for (const task of await this.db.list<AgentTask>(owner, "tasks"))
        if (task.goalId === id && !terminal.has(task.status) && task.status !== "paused")
          await this.control(owner, task.id, "pause");
    return saved;
  }
  async createProject(owner: string, raw: unknown): Promise<Project> {
    const input = createProjectSchema.parse(raw);
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      createdAt: date(),
      updatedAt: date(),
    };
    return this.db.put(owner, "projects", project);
  }
  async updateProject(owner: string, id: string, raw: unknown): Promise<Project> {
    const input = updateProjectSchema.parse(raw);
    const project = await this.db.get<Project>(owner, "projects", id);
    if (!project) throw new AppError("Project not found", 404);
    return this.db.put(owner, "projects", {
      ...project,
      name: input.name ?? project.name,
      description:
        input.description !== undefined ? (input.description ?? undefined) : project.description,
      updatedAt: date(),
    });
  }
  /** Delete a project; its tasks move to "No project". */
  async deleteProject(owner: string, id: string): Promise<{ deleted: string }> {
    const project = await this.db.get<Project>(owner, "projects", id);
    if (!project) throw new AppError("Project not found", 404);
    await this.db.remove(owner, "projects", id);
    for (const task of await this.db.list<AgentTask>(owner, "tasks"))
      if (task.projectId === id)
        await this.db.put(owner, "tasks", {
          ...task,
          projectId: null,
          updatedAt: date(),
        });
    return { deleted: id };
  }
  private async requireProject(owner: string, projectId: string) {
    if (!(await this.db.get<Project>(owner, "projects", projectId)))
      throw new AppError("Project not found", 404);
  }
  async createMonitor(owner: string, raw: unknown, idempotencyKey?: string) {
    const input = monitorInputSchema.parse(raw);
    const url = new URL(input.url);
    if (url.protocol === "sample:" && this.config.mode !== "sample")
      throw new AppError("Sample sources are unavailable in live workspaces", 422);
    if (!["https:", "http:", "sample:"].includes(url.protocol) || url.username || url.password)
      throw new AppError("Use a public HTTP(S) page", 422);
    if (url.protocol === "sample:" && input.url !== "sample://availability")
      throw new AppError("Unknown sample source", 422);
    const id = idempotencyKey ? hash(`monitor:${idempotencyKey}`) : randomUUID();
    const existing = await this.db.get<Monitor>(owner, "monitors", id);
    if (existing) {
      await this.activateMonitor(owner, existing);
      return existing;
    }
    const task = await this.createTask(
      owner,
      {
        kind: "monitor",
        title: input.title,
        prompt: `Watch ${input.url} for ${input.condition}${input.value ? `: ${input.value}` : ""}`,
        input: { monitorId: id },
      },
      `monitor:${id}`,
      true,
    );
    const monitor: Monitor = {
      id,
      taskId: task.id,
      ...input,
      status: "active",
      nextCheckAt: date(),
      checks: 0,
    };
    await this.db.insertIfAbsent(owner, "monitors", monitor);
    await this.activateMonitor(owner, monitor);
    return monitor;
  }
  private async activateMonitor(owner: string, monitor: Monitor) {
    if (monitor.status !== "active") return null;
    const task = await this.getTask(owner, monitor.taskId);
    if (task.status !== "paused") return null;
    if (task.state.resumingMonitor)
      return this.db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        { status: "paused", state: { resumingMonitor: true } },
        {
          status: "queued",
          nextRunAt: date(),
          leaseId: null,
          leaseUntil: null,
          error: null,
          state: { ...task.state, resumingMonitor: false, failures: 0, notice: null },
        },
      );
    if (!task.state.initializingMonitor) return null;
    return this.db.compareAndSwap(
      owner,
      "tasks",
      task.id,
      { status: "paused", attempts: 0, state: { initializingMonitor: true } },
      {
        status: "queued",
        state: { ...task.state, initializingMonitor: false },
      },
    );
  }
  async controlMonitor(owner: string, id: string, action: "pause" | "resume" | "stop" | "check") {
    const monitor = await this.db.get<Monitor>(owner, "monitors", id);
    if (!monitor) throw new AppError("Monitor not found", 404);
    if (monitor.status === "stopped" && action !== "stop")
      throw new AppError("Create a new watch to restart this stopped monitor", 409);
    if (action === "pause" || action === "stop") {
      const status = action === "pause" ? "paused" : "stopped";
      const saved = await this.db.put(owner, "monitors", {
        ...monitor,
        status,
        nextCheckAt: date(),
      });
      const task = await this.getTask(owner, monitor.taskId);
      await this.control(owner, task.id, action === "pause" ? "pause" : "cancel");
      return saved;
    }
    let monitorStatus = monitor.status;
    for (let attempt = 0; attempt < 2; attempt++) {
      const task = await this.getTask(owner, monitor.taskId);
      if (task.status === "cancelled") break;
      if (task.status === "paused") {
        // Mark the paused task before activating the monitor so no worker can claim it in between.
        const marked = await this.db.compareAndSwap(
          owner,
          "tasks",
          task.id,
          { status: "paused", leaseId: task.leaseId ?? null },
          { state: { ...task.state, resumingMonitor: true } },
        );
        if (!marked) break;
        const activated = await this.db.compareAndSwap<Monitor>(
          owner,
          "monitors",
          id,
          { status: monitor.status },
          { status: "active", nextCheckAt: date(), error: null },
        );
        const saved = activated ?? (await this.db.get<Monitor>(owner, "monitors", id));
        if (saved?.status === "active" && (await this.activateMonitor(owner, saved))) return saved;
        const unmarked = await this.db.compareAndSwap(
          owner,
          "tasks",
          task.id,
          { status: "paused", state: { resumingMonitor: true } },
          { state: { ...task.state, resumingMonitor: false } },
        );
        // Another request or maintenance may have finished this resume first.
        if (!unmarked && saved?.status === "active") {
          const latest = await this.getTask(owner, task.id);
          if (["queued", "running", "scheduled"].includes(latest.status)) return saved;
        }
        if (activated)
          await this.db.compareAndSwap(
            owner,
            "monitors",
            id,
            { status: "active" },
            { status: monitor.status, error: monitor.error ?? null },
          );
        break;
      }
      // Only activate the monitor we read, so a concurrent stop is never undone.
      const saved = await this.db.compareAndSwap<Monitor>(
        owner,
        "monitors",
        id,
        { status: monitorStatus },
        { status: "active", nextCheckAt: date() },
      );
      if (!saved) break;
      monitorStatus = "active";
      this.worker.abort(task.id);
      const queued = await this.db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        // updatedAt fences out a whole run finishing in between, which would move the baseline.
        { status: task.status, leaseId: task.leaseId ?? null, updatedAt: task.updatedAt },
        {
          status: "queued",
          nextRunAt: date(),
          leaseId: null,
          leaseUntil: null,
          error: null,
          state: { ...task.state, failures: 0, notice: null },
        },
      );
      if (queued) return saved;
    }
    throw new AppError("The watch changed while updating. Try again.", 409);
  }
  async refreshIdeas(owner: string) {
    const w = await this.workspace.snapshot(owner);
    const sentIds = new Set(
      w.mail.filter((mail) => /^Sent\b/i.test(mail.label)).map((mail) => mail.id),
    );
    const completedSources = new Set(
      (await this.db.list<AgentTask>(owner, "tasks"))
        .filter(
          (task) =>
            (task.status === "succeeded" || task.status === "in_review") &&
            typeof task.input.messageId === "string",
        )
        .map((task) => `${task.kind}:${task.input.messageId}`),
    );
    const obsolete = (kind: AgentTask["kind"], messageId: unknown) =>
      typeof messageId === "string" &&
      (sentIds.has(messageId) || completedSources.has(`${kind}:${messageId}`));
    // Retire earlier suggestions as well as preventing new duplicates. A concurrent
    // acceptance wins its own compare-and-swap and is never overwritten here.
    for (const idea of await this.db.list<Idea>(owner, "ideas"))
      if (idea.status === "new" && obsolete(idea.kind, idea.input.messageId))
        await this.db.compareAndSwap(
          owner,
          "ideas",
          idea.id,
          { status: "new" },
          { status: "dismissed" },
        );
    for (const mail of w.mail
      .filter(
        (m) =>
          !obsolete("document", m.id) &&
          m.attachments.length &&
          /form|permission|complete|fill|sign/i.test(`${m.subject} ${m.body}`),
      )
      .slice(0, 5)) {
      const id = hash(`document:${mail.id}:${mail.body}`);
      const idea: Idea = {
        id,
        title: `I can help with ${mail.subject}`,
        reason: `${mail.sender} sent a document that may need your attention. I can prepare it and a reply for your review.`,
        evidence: [this.mailEvidence(mail)],
        prompt: `Help complete the PDF from “${mail.subject}” and prepare a reply for review.`,
        kind: "document",
        input: { messageId: mail.id },
        status: "new",
        createdAt: date(),
      };
      await this.db.insertIfAbsent(owner, "ideas", idea);
    }
    for (const mail of w.mail
      .filter(
        (m) =>
          !obsolete("agent", m.id) &&
          /coffee|meet|available|schedule/i.test(`${m.subject} ${m.body}`),
      )
      .slice(0, 5)) {
      await this.db.insertIfAbsent(owner, "ideas", {
        id: hash(`coordination:${mail.id}`),
        title: `I can help coordinate ${mail.subject}`,
        reason: `${mail.sender} mentioned getting together. I can check your calendar and prepare a response for review.`,
        evidence: [this.mailEvidence(mail)],
        prompt: `Review the email “${mail.subject}”, check my calendar, and propose a next step. Ask me about missing preferences before preparing a reply.`,
        kind: "agent",
        input: { messageId: mail.id },
        status: "new",
        createdAt: date(),
      } satisfies Idea);
    }
    for (const goal of await this.db.list<Goal>(owner, "goals"))
      if (goal.status === "active" && !goal.milestones.length) {
        const id = hash(`goal:${goal.id}:${goal.description}`);
        await this.db.insertIfAbsent(owner, "ideas", {
          id,
          title: `Let's make a plan for ${goal.title}`,
          reason: "This goal has no milestones yet. A concrete plan will give it a next step.",
          evidence: [{ id: goal.id, kind: "user", title: goal.title, excerpt: goal.description }],
          prompt: `Create an actionable plan for ${goal.title}. ${goal.description}`,
          kind: "plan",
          input: { goalId: goal.id },
          status: "new",
          createdAt: date(),
        } satisfies Idea);
      }
    await this.ensure(owner);
    await this.db.compareAndSwap(owner, "agent-settings", "identity", {}, { lastIdeasAt: date() });
    return this.db.list<Idea>(owner, "ideas");
  }
  async decideIdea(owner: string, id: string, action: "accept" | "dismiss", prompt?: string) {
    let idea = await this.db.get<Idea>(owner, "ideas", id);
    if (!idea) throw new AppError("Idea not found", 404);
    if (idea.status === "dismissed" || (idea.status === "accepted" && action === "dismiss"))
      return idea;
    if (action === "dismiss")
      return this.db.compareAndSwap<Idea>(
        owner,
        "ideas",
        id,
        { status: "new" },
        { status: "dismissed" },
      );
    if (idea.status === "new") {
      const claimed = await this.db.compareAndSwap<Idea>(
        owner,
        "ideas",
        id,
        { status: "new" },
        {
          status: "accepted",
          taskId: hash(`task:idea:${id}`),
          prompt: prompt ?? idea.prompt,
        },
      );
      idea = claimed ?? (await this.db.get<Idea>(owner, "ideas", id));
      if (idea?.status !== "accepted") return idea;
    }
    const goal = await this.createGoal(
      owner,
      { title: idea.title, description: idea.reason },
      hash(`idea-goal:${id}`),
    );
    const task = await this.createTask(
      owner,
      {
        title: idea.title,
        prompt: idea.prompt,
        kind: idea.kind,
        input: idea.input,
        goalId: goal.id,
      },
      `idea:${id}`,
    );
    await this.db.compareAndSwap(
      owner,
      "ideas",
      id,
      { status: "new" },
      { status: "accepted", taskId: task.id },
    );
    return this.db.get<Idea>(owner, "ideas", id);
  }
  async notify(owner: string, title: string, body: string, taskId?: string, key?: string) {
    const value: AgentNotification = {
      id: key ? hash(key) : randomUUID(),
      taskId,
      title,
      body,
      createdAt: date(),
      read: false,
    };
    await this.db.insertIfAbsent(owner, "notifications", value);
  }
  mailEvidence(mail: Mail): Evidence {
    return { id: mail.id, kind: "mail", title: mail.subject, excerpt: mail.body.slice(0, 400) };
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
    if (task.kind === "monitor") {
      try {
        return await this.observe(owner, task, context);
      } catch (error) {
        if (error instanceof LostLeaseError || context.signal.aborted) throw error;
        await context.guard();
        const failures = Number(task.state.failures ?? 0) + 1;
        // Each streak of failures (after a success or a resume) gets its own alerts.
        const failureStreak = Number(task.state.failureStreak ?? 0) + (failures === 1 ? 1 : 0);
        const detail = error instanceof Error ? error.message : "Page check failed";
        const nextCheckAt = new Date(
          Date.now() + Math.min(60, 2 ** failures) * 60000,
        ).toISOString();
        await this.db.compareAndSwap(
          owner,
          "monitors",
          String(task.input.monitorId),
          { status: "active" },
          { error: detail, nextCheckAt },
        );
        await context.event(
          "error",
          failures >= 5 ? "Watch paused after repeated failures" : "Check failed; retry scheduled",
          detail,
        );
        return {
          status: failures >= 5 ? "paused" : "scheduled",
          error: detail,
          nextRunAt: nextCheckAt,
          state: {
            ...task.state,
            failures,
            resumingMonitor: false,
            failureStreak,
            notice: {
              title: "Watch needs attention",
              body: detail,
              key: `watch-error:${task.id}:${failureStreak}:${failures >= 5 ? "paused" : "retry"}`,
            },
          },
        };
      }
    }
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
  private async publishOutcome(owner: string, saved: AgentTask) {
    const task = await this.getTask(owner, saved.id);
    if (task.status === "succeeded") {
      await this.notify(
        owner,
        task.title,
        task.result ?? "Work completed",
        task.id,
        `task-done:${task.id}`,
      );
      if (task.goalId) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const goal = await this.db.get<Goal>(owner, "goals", task.goalId);
          if (!goal || goal.milestones.some((m) => m.id === task.id)) break;
          if (
            await this.db.compareAndSwap(
              owner,
              "goals",
              goal.id,
              { milestones: goal.milestones },
              {
                milestones: [...goal.milestones, { id: task.id, title: task.title, done: true }],
              },
            )
          )
            break;
        }
      }
    } else if (task.status === "in_review") {
      await this.notify(
        owner,
        "Ready for your review",
        task.title,
        task.id,
        `task-review:${task.id}:${task.attempts}`,
      );
    } else if (task.status === "failed") {
      await this.notify(
        owner,
        "Task needs attention",
        task.error ?? task.title,
        task.id,
        `task-error:${task.id}:${task.attempts}`,
      );
    } else if (task.status === "waiting_input") {
      await this.notify(
        owner,
        "Your details are needed",
        task.question ?? task.title,
        task.id,
        `input:${task.id}:${hash(task.question ?? "")}`,
      );
    } else if (task.status === "waiting_approval") {
      await this.notify(
        owner,
        "Ready for your review",
        task.title,
        task.id,
        `review:${task.actionId}`,
      );
    }
    const notice = z
      .object({ title: z.string(), body: z.string(), key: z.string() })
      .safeParse(task.state.notice);
    if ((task.status === "scheduled" || (task.status === "paused" && task.error)) && notice.success)
      await this.notify(owner, notice.data.title, notice.data.body, task.id, notice.data.key);
    // A watch pauses after repeated failures only once that task outcome has committed.
    if (task.kind === "monitor" && task.status === "paused" && task.error)
      await this.db.compareAndSwap(
        owner,
        "monitors",
        String(task.input.monitorId),
        { status: "active", error: task.error },
        { status: "paused" },
      );
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
  private async observe(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    const monitor = await this.db.get<Monitor>(owner, "monitors", String(task.input.monitorId));
    if (!monitor) throw new Error("Monitor not found");
    if (monitor.status !== "active")
      return { status: monitor.status === "paused" ? "paused" : "cancelled" };
    let observation: { url: string; title: string; text: string; sessionId?: string };
    if (monitor.url === "sample://availability") {
      if (this.config.mode !== "sample") throw new Error("Sample source unavailable");
      const page = await this.db.get<{ text: string }>(owner, "sample-pages", "availability");
      observation = {
        url: monitor.url,
        title: "Sample dinner availability",
        text: page?.text ?? "No tables available. Check again later.",
      };
    } else {
      await ctx.guard();
      observation = await this.browser.observe(
        owner,
        monitor.url,
        typeof task.state.sessionId === "string" ? task.state.sessionId : undefined,
      );
    }
    const text = observation.text.replace(/\s+/g, " ").trim();
    const currentHash = hash(text);
    const previousHash =
      typeof task.state.lastHash === "string" ? task.state.lastHash : monitor.lastHash;
    const matched =
      monitor.condition === "change"
        ? Boolean(previousHash && previousHash !== currentHash)
        : monitor.condition === "contains"
          ? text.toLowerCase().includes(monitor.value.toLowerCase())
          : this.matchesPrice(text, Number(monitor.value));
    const previouslyMatched = Boolean(task.state.matched);
    const shouldNotify = matched && (monitor.condition === "change" || !previouslyMatched);
    const nextCheckAt = new Date(Date.now() + monitor.intervalMinutes * 60000).toISOString();
    await ctx.guard();
    // Worker lease is checked before each publication; monitor control also invalidates that lease.
    const savedMonitor = await this.db.compareAndSwap(
      owner,
      "monitors",
      monitor.id,
      { status: "active" },
      {
        checks: monitor.checks + 1,
        lastCheckedAt: date(),
        lastHash: currentHash,
        lastValue: text.slice(0, 1000),
        nextCheckAt,
        error: null,
      },
    );
    if (!savedMonitor) throw new LostLeaseError();
    await ctx.event(
      "observation",
      previousHash ? "Checked for changes" : "Saved the first observation",
      text.slice(0, 1000),
    );
    if (shouldNotify) {
      await ctx.guard();
      await ctx.event("result", "A meaningful change was found", text.slice(0, 500));
    }
    return {
      status: "scheduled",
      nextRunAt: nextCheckAt,
      result: shouldNotify
        ? "Change found. A notification is ready."
        : "Watching. I'll check again on schedule.",
      state: {
        ...task.state,
        sessionId: observation.sessionId,
        lastHash: currentHash,
        resumingMonitor: false,
        matched,
        failures: 0,
        notice: shouldNotify
          ? {
              title: monitor.title,
              body: `Condition met at ${observation.url}: ${text.slice(0, 240)}`,
              key: `monitor:${monitor.id}:${currentHash}`,
            }
          : null,
      },
      error: null,
      evidence: [
        {
          id: monitor.id,
          kind: "web",
          title: observation.title,
          url: observation.url,
          excerpt: text.slice(0, 600),
        },
      ],
      plan: task.plan.map((s) => ({ ...s, status: "succeeded" })),
    };
  }
  private matchesPrice(text: string, threshold: number) {
    const matches = [...text.matchAll(/(?:\$|USD\s*)(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)];
    return matches.some((m) => Number(m[1].replace(/,/g, "")) < threshold);
  }
}
