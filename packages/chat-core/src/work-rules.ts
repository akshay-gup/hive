import {
  type AgentTask,
  addNoteSchema,
  attachmentTypes,
  createProjectSchema,
  createTaskSchema,
  deleteProjectSchema,
  GENERAL_PROJECT_ID,
  ORCHESTRATOR_CHANNEL_ID,
  type Project,
  type TaskAttachment,
  type TaskNote,
  type TaskStatus,
  taskBriefLimits,
  updateProjectSchema,
  updateTaskSchema,
} from "../../domain/src/agent.ts";
import {
  type Access,
  canSeeTask,
  canViewProject,
  canWorkInProject,
  isFixed,
  managesProject,
  normalizeEmail,
  projectFor,
} from "./access.ts";
import { AppError } from "./errors.ts";
import type { FileRow } from "./files.ts";
import type { Projects, Tasks } from "./work.ts";

/** The name a task's file is shown by: no folders, no control characters, a bounded length. */
function attachmentName(raw: string): string {
  const base = Array.from(raw.split(/[\\/]/).at(-1) ?? "")
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join("")
    .trim();
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot) : "";
  const stem = base.slice(0, base.length - extension.length).replace(/^\.+/, "");
  return `${stem.slice(0, 100).trim() || "file"}${extension}`;
}

/** A task is done with, until a person sends it back. */
const TERMINAL: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "cancelled"]);

/** Statuses a person or the agent may set directly on a task the agent works. */
const USER_SETTABLE: ReadonlySet<TaskStatus> = new Set(["queued", "paused", "cancelled"]);
/** Manual (human) tasks move freely; they have no worker lifecycle. */
const MANUAL: ReadonlySet<TaskStatus> = new Set([
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
]);
/** Where a task can be sent back from: the agent has stopped, and is waiting on or finished with the team. */
const SEND_BACK_FROM: ReadonlySet<TaskStatus> = new Set([
  "in_review",
  "waiting_input",
  "failed",
  "cancelled",
  "succeeded",
]);

/** What changed, for whoever wants to know: the app is told, and a machine holding the task is told to let go. */
export interface WorkChange {
  task: AgentTask;
  /** What it was before; null when it is new. */
  before: AgentTask | null;
}

export interface WorkDeps {
  access: Access;
  projects: Projects;
  tasks: Tasks;
  clock: () => number;
  /** A task was made, changed, or removed (then `removed` is set). */
  changed?: (change: WorkChange & { removed?: boolean }) => void;
  /** A project was made, changed or removed. */
  projectChanged?: (project: Project, removed?: boolean) => void;
  /** Whether this person may see a goal, so a task may be pointed at it. */
  goalVisible?: (owner: string, goalId: string) => Promise<boolean>;
  /** A project was deleted: what is kept in its scope (goals, routines) goes too. */
  projectGone?: (id: string) => Promise<void>;
  /** Whether a channel exists in this workspace, and the person may open it. */
  channel?: (
    id: string,
  ) => Promise<{ id: string; visibility?: string; kind?: string; status?: string } | null>;
  /** The files of tasks, kept with the room's other files (see apps/chat/src/filing.ts). */
  files?: {
    get(id: string): FileRow | null;
    remove(id: string): FileRow | null;
    removeOfChannel(channelId: string): number;
  };
  /** A signed address, below the workspace, to fetch a task's file from; null if it cannot be made. */
  fileLink?: (fileId: string) => string | null;
  /** Files were let go of: the bucket has things to delete. */
  filesGone?: () => void;
  /** Recent talk in a channel, for a task handed to the agent. */
  discussion?: (channelId: string) => Promise<{ name: string; lines: string } | null>;
  newId?: () => string;
}

/**
 * The workspace's projects and tasks, and who may do what with them. This is the rules of the board, held
 * where the people are: a task is only ever shown to, or changed by, someone its project lets in. Running
 * a task is the machine's business and goes through leases (see work.ts); what is here is what people and
 * the agent's tools do with the board.
 */
export class Work {
  constructor(private readonly deps: WorkDeps) {}

  private now() {
    return new Date(this.deps.clock()).toISOString();
  }
  private id() {
    return (this.deps.newId ?? (() => crypto.randomUUID()))();
  }

  /**
   * A guest keeps the board of a project they were named in and nothing more: what an agent does goes on
   * without anyone asking it, so a guest does not start, steer or answer it.
   */
  private async refuseGuest(owner: string): Promise<void> {
    throw new AppError("Guests can only keep the board of the projects they were added to", 403);
  }

  /** A task may only point at a goal its person may see; one they may not looks like one that is not there. */
  private async checkGoal(owner: string, goalId: string | null | undefined): Promise<void> {
    if (!goalId || !this.deps.goalVisible) return;
    if (!(await this.deps.goalVisible(owner, goalId)))
      throw new AppError("That goal is not there, or you cannot see it.", 404);
  }

  private async refuseGuestIfGuest(owner: string): Promise<void> {
    if ((await this.deps.access.scope(owner)).person?.role === "guest")
      await this.refuseGuest(owner);
  }

  // Projects

  /**
   * Every task is in a project, so there is always one for work that names none: General, open to the
   * whole team.
   */
  ensureGeneral(): void {
    if (this.deps.projects.get(GENERAL_PROJECT_ID)) return;
    const now = this.now();
    this.deps.projects.put({
      id: GENERAL_PROJECT_ID,
      name: "General",
      description: "Where work goes when it is not in another project.",
      access: "open",
      members: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  /** The projects this person may see, as they are shown them. */
  async projectsFor(owner: string): Promise<Project[]> {
    this.ensureGeneral();
    const person = (await this.deps.access.scope(owner)).person;
    return this.deps.projects
      .list()
      .filter((project) => canViewProject(person, project))
      .map((project) => projectFor(person, project));
  }

  /** A project the person may see. One they may not is not there: a private project is its members' to know of. */
  private async visibleProject(owner: string, id: string): Promise<Project> {
    this.ensureGeneral();
    const project = this.deps.projects.get(id);
    const person = (await this.deps.access.scope(owner)).person;
    if (!project || !canViewProject(person, project))
      throw new AppError("That project is not there, or you cannot see it.", 404);
    return project;
  }

  /** Throws unless the person may put tasks in the project, or change what is in it. */
  async assertProjectWork(owner: string, projectId: string): Promise<void> {
    const project = await this.visibleProject(owner, projectId);
    if (!canWorkInProject((await this.deps.access.scope(owner)).person, project))
      throw new AppError("You can look at this project but not change what is in it", 403);
  }

  /** The people a project can name: the workspace's, and a guest is not told who they are. */
  async projectPeople(owner: string) {
    if ((await this.deps.access.scope(owner)).person?.role === "guest")
      throw new AppError("A guest cannot see who is in the workspace", 403);
    return [...(await this.deps.access.known())].map(([email, who]) => ({ email, ...who }));
  }

  async createProject(owner: string, raw: unknown): Promise<Project> {
    const input = createProjectSchema.parse(raw);
    const person = (await this.deps.access.scope(owner)).person;
    if (person?.role === "guest") throw new AppError("A guest cannot start a project", 403);
    this.ensureGeneral();
    const now = this.now();
    const project = this.deps.projects.put({
      id: this.id(),
      name: input.name,
      description: input.description,
      createdAt: now,
      updatedAt: now,
      access: input.access ?? "open",
      // Who makes it runs it. Where there are no roles there is nobody to name.
      members: person?.email ? [{ email: person.email, role: "admin" }] : [],
      createdBy: owner,
    });
    this.deps.projectChanged?.(project);
    return projectFor(person, project);
  }

  async updateProject(owner: string, id: string, raw: unknown): Promise<Project> {
    const input = updateProjectSchema.parse(raw);
    const scope = await this.deps.access.scope(owner);
    const project = await this.visibleProject(owner, id);
    if (!managesProject(scope.person, project))
      throw new AppError("Only a project admin can change this project", 403);
    // Work that names no project goes here, so everyone has to be able to put it here.
    if (id === GENERAL_PROJECT_ID && input.access && input.access !== "open")
      throw new AppError("General stays open to everyone", 422);
    let members = project.members;
    if (input.members) {
      const seen = new Set<string>();
      members = input.members.filter((m) => {
        const email = normalizeEmail(m.email);
        if (seen.has(email)) return false;
        seen.add(email);
        return true;
      });
      // A project always has someone to run it, so it cannot be locked away from its own people.
      if (scope.person && !members.some((m) => m.role === "admin"))
        throw new AppError("A project needs at least one admin", 422);
    }
    const saved = this.deps.projects.put({
      ...project,
      name: input.name ?? project.name,
      description:
        input.description !== undefined ? (input.description ?? undefined) : project.description,
      access: input.access ?? project.access ?? "open",
      members: members ?? [],
    });
    this.deps.projectChanged?.(saved);
    return projectFor(scope.person, saved);
  }

  /**
   * Delete a project. Its tasks move to another project, General unless one is named, or are deleted
   * with it. Everything is checked before anything is changed.
   */
  async deleteProject(
    owner: string,
    id: string,
    raw: unknown = {},
  ): Promise<{ deleted: string; moved: number; removed: number }> {
    const input = deleteProjectSchema.parse(raw ?? {});
    if (id === GENERAL_PROJECT_ID) throw new AppError("General cannot be deleted", 422);
    const scope = await this.deps.access.scope(owner);
    const project = await this.visibleProject(owner, id);
    if (!managesProject(scope.person, project))
      throw new AppError("Only a project admin can delete this project", 403);
    const inside = this.deps.tasks.all().filter((task) => task.projectId === id);
    if (input.deleteTasks) {
      if (
        inside.some((task) => task.leaseId && ["running", "waiting_approval"].includes(task.status))
      )
        throw new AppError("Stop the tasks that are running before deleting the project", 409);
    } else {
      const target = input.moveTo ?? GENERAL_PROJECT_ID;
      if (target === id) throw new AppError("Move the tasks to another project", 422);
      await this.assertProjectWork(owner, target);
    }
    const target = input.moveTo ?? GENERAL_PROJECT_ID;
    // What is kept in the project's scope goes first, while it is still known who could see it.
    await this.deps.projectGone?.(id);
    this.deps.projects.remove(id);
    this.deps.projectChanged?.(project, true);
    if (input.deleteTasks) {
      for (const task of inside) this.removeTask(task);
      return { deleted: id, moved: 0, removed: inside.length };
    }
    for (const task of inside) this.change(task, { projectId: target });
    return { deleted: id, moved: inside.length, removed: 0 };
  }

  // Seeing tasks

  /**
   * Throws, as if it were not there, unless the person may see the task; and, to change it, unless the
   * project it is in lets them work on it.
   */
  async assertTask(owner: string, task: AgentTask, write: boolean): Promise<void> {
    this.ensureGeneral();
    const scope = await this.deps.access.scope(owner);
    const project = task.projectId ? this.deps.projects.get(task.projectId) : null;
    if (!canSeeTask(scope, project))
      throw new AppError("That task is not there, or you cannot see it.", 404);
    if (write && project && !canWorkInProject(scope.person, project))
      throw new AppError("You can look at this project but not change what is in it", 403);
  }

  /** The task, if the person may see it (and work on it, to change it). */
  async getTask(owner: string, id: string, write = false): Promise<AgentTask> {
    const task = this.deps.tasks.get(id);
    if (!task) throw new AppError("That task is not there, or you cannot see it.", 404);
    await this.assertTask(owner, task, write);
    return task;
  }

  /** The tasks this person may see, as they are shown them. */
  async tasksFor(owner: string): Promise<AgentTask[]> {
    this.ensureGeneral();
    const scope = await this.deps.access.scope(owner);
    const projects = new Map(this.deps.projects.list().map((p) => [p.id, p]));
    const visible = this.deps.tasks
      .all()
      .filter((task) => canSeeTask(scope, task.projectId ? projects.get(task.projectId) : null));
    return this.present(owner, visible);
  }

  /** An address, below the workspace, to fetch one of a task's files from. */
  fileLink(fileId: string): string | null {
    return this.deps.fileLink?.(fileId) ?? null;
  }

  /** The task with an address to fetch each of its files from, good for a while. */
  withLinks(task: AgentTask): AgentTask {
    if (!task.attachments?.length) return task;
    return {
      ...task,
      attachments: task.attachments.map((file) => {
        const url = this.deps.fileLink?.(file.id);
        return url ? { ...file, url } : file;
      }),
    };
  }

  /** Tasks as a client sees them: who asked and who wrote each note, by name. The names are never stored. */
  async present(owner: string, tasks: AgentTask[]): Promise<AgentTask[]> {
    const known = await this.deps.access.byId();
    const nameOf = (id?: string) => {
      const who = id ? known.get(id) : undefined;
      return who ? who.name || who.email : undefined;
    };
    return tasks.map(this.withLinks.bind(this)).map((task) => ({
      ...task,
      ...(task.createdBy ? { createdByName: nameOf(task.createdBy) } : {}),
      ...(task.attachments && {
        attachments: task.attachments.map((file) => ({
          ...file,
          addedByName: nameOf(file.addedBy),
          mine: file.addedBy === owner,
        })),
      }),
      ...(task.notes && {
        notes: task.notes.map((note) => ({
          ...note,
          createdByName: nameOf(note.createdBy),
          mine: note.createdBy === owner,
        })),
      }),
    }));
  }

  // Making and changing tasks

  private assertTaskRoom(owner: string) {
    if (
      this.deps.tasks
        .all()
        .filter((t) => !TERMINAL.has(t.status) && (t.createdBy ?? owner) === owner).length >= 100
    )
      throw new AppError("Finish or cancel some tasks before adding more", 409);
  }

  private change(
    task: AgentTask,
    patch: Partial<AgentTask> | ((current: AgentTask) => Partial<AgentTask>),
    expect = true,
  ): AgentTask {
    const saved = this.deps.tasks.change(
      task.id,
      (current) => {
        const update = typeof patch === "function" ? patch(current) : patch;
        // Reopening consumes a slot for the creator, even when someone else reopens it. Check inside
        // the same transaction as the write, so competing requests cannot take the last slot twice.
        if (TERMINAL.has(current.status) && update.status && !TERMINAL.has(update.status))
          this.assertTaskRoom(current.createdBy ?? "");
        return { ...update, updatedAt: this.now() };
      },
      expect ? { status: task.status, leaseId: task.leaseId ?? null } : undefined,
    );
    if (!saved) throw new AppError("Task changed; refresh and try again", 409);
    this.deps.changed?.({ task: saved, before: task });
    return saved;
  }

  private removeTask(task: AgentTask) {
    this.deps.tasks.remove(task.id);
    if (this.deps.files?.removeOfChannel(`task:${task.id}`)) this.deps.filesGone?.();
    this.deps.changed?.({ task, before: task, removed: true });
    // Nothing waits on a task that is gone.
    for (const other of this.deps.tasks.all())
      if (other.blockedBy.includes(task.id))
        this.change(other, { blockedBy: other.blockedBy.filter((dep) => dep !== task.id) }, false);
  }

  async createTask(
    owner: string,
    raw: unknown,
    options: { key?: string; held?: boolean; privateSource?: boolean } = {},
  ): Promise<AgentTask> {
    const prepared = await this.prepareTask(owner, raw, options);
    const task = prepared.save();
    prepared.announce();
    return task;
  }

  /** Check creation before a synchronous transaction. An idea may attach a goal made in that transaction.
   * Announce only after the transaction commits; an unsuccessful acceptance publishes no work. */
  async prepareTask(
    owner: string,
    raw: unknown,
    options: { key?: string; held?: boolean; privateSource?: boolean } = {},
  ): Promise<{ save(goalId?: string): AgentTask; announce(): void }> {
    const input = createTaskSchema.parse(raw);
    this.ensureGeneral();
    const scope = await this.deps.access.scope(owner);
    if (scope.person?.role === "guest" && (input.kind !== "manual" || !input.projectId))
      throw new AppError("Guests can only keep the board of the projects they were added to", 403);
    await this.checkGoal(owner, input.goalId);
    // A guest sees no goals; whether any other goal may be named is the goal's to say, where goals are kept.
    const projectId = input.projectId ?? GENERAL_PROJECT_ID;
    await this.assertProjectWork(owner, projectId);
    const channelId = input.channelId ?? ORCHESTRATOR_CHANNEL_ID;
    if (channelId !== ORCHESTRATOR_CHANNEL_ID && !scope.allows(channelId))
      throw new AppError("That channel is not there, or you cannot see it.", 404);
    const source =
      channelId !== ORCHESTRATOR_CHANNEL_ID ? await this.deps.channel?.(channelId) : null;
    if (source?.status === "archived") throw new AppError("This channel is archived", 409);
    if (source && !isFixed(source) && source.visibility === "private" && !options.privateSource)
      throw new AppError("Choose a project through this conversation's task picker first", 409);
    if (options.key) {
      const existing = this.deps.tasks.byKey(options.key);
      if (existing) return { save: () => existing, announce: () => {} };
    }
    const id = this.id();
    if (input.blockedBy.length) await this.checkBlockedBy(owner, id, input.blockedBy);
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
        : input.kind === "finance"
          ? ["Validate transactions", "Calculate the summary", "Save your tracker"]
          : [];
    if (input.kind !== "manual" && !input.prompt)
      throw new AppError("A prompt is required for agent-executed tasks", 422);
    if (input.startAt && input.dueAt && input.startAt > input.dueAt)
      throw new AppError("startAt must not be after dueAt", 422);
    let saved: AgentTask | undefined;
    let made = false;
    return {
      save: (goalId) => {
        if (saved) return saved;
        if (options.key) {
          const existing = this.deps.tasks.byKey(options.key);
          if (existing) return existing;
        }
        this.assertTaskRoom(owner);
        const now = this.now();
        saved = this.deps.tasks.create(
          {
            id,
            title: input.title ?? input.prompt?.slice(0, 90) ?? "Untitled task",
            prompt: input.prompt ?? "",
            kind: input.kind,
            goalId: goalId ?? input.goalId,
            projectId,
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
            status: options.held ? "paused" : "queued",
            plan: titles.map((title, i) => ({ id: String(i), title, status: "pending" as const })),
            evidence: [],
            input: {
              ...input.input,
              ...(source && !isFixed(source) && source.visibility === "private"
                ? { privateConversation: true }
                : {}),
            },
            state: {},
            createdAt: now,
            updatedAt: now,
            attempts: 0,
            artifactIds: [],
          } as AgentTask,
          options.key,
        );
        made = true;
        return saved;
      },
      announce: () => {
        if (made && saved) {
          made = false;
          this.deps.changed?.({ task: saved, before: null });
        }
      },
    };
  }

  /**
   * Hand a manual issue to the agent and queue it, so it is given out like any agent task. The description
   * stays as written. Each run's brief is built from it, the notes and files on the task, and (unless the
   * person declines) a snapshot of the channel discussion taken now.
   */
  private async assignToAgent(
    owner: string,
    task: AgentTask,
    patch: Partial<AgentTask>,
    channelContext: boolean,
  ) {
    if (task.kind !== "manual")
      throw new AppError("Only manual issues can be assigned to the agent", 422);
    const channelId = task.channelId;
    const context =
      channelContext &&
      !task.input?.privateConversation &&
      channelId &&
      channelId !== ORCHESTRATOR_CHANNEL_ID &&
      (await this.deps.access.scope(owner)).allows(channelId)
        ? ((await this.deps.discussion?.(channelId)) ?? null)
        : null;
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

  /** Take a ticket back from the agent: stop any run and restore the manual issue. */
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
    const task = await this.getTask(owner, id, true);
    const guest = (await this.deps.access.scope(owner)).person?.role === "guest";
    // Handing an item to the agent is starting work, not keeping the board.
    if (guest && (task.kind !== "manual" || input.assignee)) await this.refuseGuest(owner);
    const patch: Partial<AgentTask> = {};
    if (input.assignee !== undefined && input.assignee !== (task.assignee ?? null)) {
      if (input.status !== undefined || input.prompt !== undefined)
        throw new AppError("Cannot change assignee together with status or prompt", 422);
      if (input.assignee === "agent")
        await this.assignToAgent(owner, task, patch, input.channelContext ?? true);
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
      await this.checkGoal(owner, input.goalId);
      patch.goalId = input.goalId ?? undefined;
    }
    if (input.projectId !== undefined) {
      await this.assertProjectWork(owner, input.projectId);
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
      const allowed = task.kind === "manual" ? MANUAL : USER_SETTABLE;
      if (!allowed.has(input.status))
        throw new AppError(
          task.kind === "manual"
            ? `Manual tasks can move between ${[...MANUAL].join(", ")}`
            : "Worker-executed tasks can only be queued, paused, or cancelled directly. Running belongs to the worker, and agent work is marked done by a person once it is ready for review",
          422,
        );
      // Terminal tasks can be reopened; a requeued task is given out as a fresh run and prior results stay as history.
      patch.status = input.status;
      patch.leaseId = null;
      patch.leaseUntil = null;
      if (input.status === "cancelled") {
        patch.result = "Stopped by you.";
        patch.error = null as unknown as undefined;
      }
    }
    if (!Object.keys(patch).length) return task;
    return this.change(task, patch);
  }

  private async checkBlockedBy(owner: string, id: string, blockedBy: string[]) {
    const seen = new Set(blockedBy);
    if (seen.has(id)) throw new AppError("A task cannot depend on itself", 422);
    // A task the person may not see is not there to depend on: naming it must not tell them it exists.
    const scope = await this.deps.access.scope(owner);
    for (const depId of seen) {
      const dep = this.deps.tasks.get(depId);
      const project = dep?.projectId ? this.deps.projects.get(dep.projectId) : null;
      if (!dep || !canSeeTask(scope, project))
        throw new AppError(`Dependency not found: ${depId}`, 404);
    }
    // Cycle check: the task itself must be unreachable from its dependencies.
    const stack = [...seen];
    const visited = new Set<string>();
    while (stack.length) {
      const current = stack.pop() as string;
      if (current === id) throw new AppError("Dependencies would create a cycle", 422);
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of this.deps.tasks.get(current)?.blockedBy ?? []) stack.push(next);
    }
  }

  /** Delete a task and drop it from other tasks' dependencies. */
  async deleteTask(owner: string, id: string): Promise<{ deleted: string }> {
    const task = await this.getTask(owner, id, true);
    if (task.kind !== "manual") await this.refuseGuestIfGuest(owner);
    if (task.leaseId && (task.status === "running" || task.status === "waiting_approval"))
      throw new AppError("Stop the task before deleting it", 409);
    this.removeTask(task);
    return { deleted: id };
  }

  async control(
    owner: string,
    id: string,
    action: "pause" | "resume" | "cancel" | "retry",
  ): Promise<AgentTask> {
    const task = await this.getTask(owner, id, true);
    await this.refuseGuestIfGuest(owner);
    if (action === "cancel" && task.status === "succeeded")
      throw new AppError("This task is already complete", 409);
    if (action === "retry" && task.status !== "failed")
      throw new AppError("Only failed tasks can be retried", 409);
    if (action === "resume" && task.status !== "paused")
      throw new AppError("Only paused tasks can be resumed", 409);
    // Finished work waits for a person, not for the worker: there is nothing to pause.
    if (
      action === "pause" &&
      (TERMINAL.has(task.status) || task.status === "paused" || task.status === "in_review")
    )
      return task;
    const status: TaskStatus =
      action === "cancel"
        ? "cancelled"
        : action === "pause"
          ? "paused"
          : task.actionId
            ? "waiting_approval"
            : "queued";
    return this.change(task, {
      status,
      leaseId: null,
      leaseUntil: null,
      error: null as unknown as undefined,
      result:
        action === "cancel"
          ? "Stopped by you."
          : action === "pause"
            ? "Paused. Resume when you're ready."
            : "",
    });
  }

  /** A person marks finished work done. The agent can never do this: whether it is good enough is theirs to say. */
  async accept(owner: string, id: string): Promise<AgentTask> {
    const task = await this.getTask(owner, id, true);
    await this.refuseGuestIfGuest(owner);
    if (task.status !== "in_review")
      throw new AppError("Only work that is ready for review can be marked done", 409);
    const saved = this.change(task, { status: "succeeded", error: null as unknown as undefined });
    return (await this.present(owner, [saved]))[0] as AgentTask;
  }

  /** Move a task to another channel (the agent there takes it up); it stays with whoever it was waiting for. */
  async delegate(owner: string, id: string, target: string, reason?: string): Promise<AgentTask> {
    const task = await this.getTask(owner, id, true);
    await this.refuseGuestIfGuest(owner);
    if (task.status === "running" && task.leaseId)
      throw new AppError("Task is running; checkpoint it to waiting before delegating", 409);
    if (target !== ORCHESTRATOR_CHANNEL_ID) {
      const channel = await this.deps.channel?.(target);
      if (
        !channel ||
        channel.status === "archived" ||
        !(await this.deps.access.scope(owner)).allows(target)
      )
        throw new AppError("Target channel not found", 404);
    }
    const saved = this.change(task, {
      originChannelId: task.originChannelId ?? task.channelId ?? ORCHESTRATOR_CHANNEL_ID,
      channelId: target,
      delegatedTo: target,
      delegationReason: reason?.slice(0, 500),
      // Paused work stays paused, and work waiting for review stays that way: moving it to another
      // channel must not send it back to the agent.
      status: task.status === "paused" || task.status === "in_review" ? task.status : "queued",
      leaseId: null,
      leaseUntil: null,
    });
    return (await this.present(owner, [saved]))[0] as AgentTask;
  }

  // Notes

  private newNote(owner: string, text: string, kind: TaskNote["kind"]): TaskNote {
    return { id: this.id(), text, kind, createdAt: this.now(), createdBy: owner, delivered: false };
  }

  /**
   * Answer the question a task is waiting on. The answer joins the task's notes, so the agent keeps
   * it in view on every later run, and the task is queued in the same step.
   */
  async answer(
    owner: string,
    id: string,
    answer: string,
    fields?: Record<string, string | boolean>,
  ) {
    const task = await this.getTask(owner, id, true);
    await this.refuseGuestIfGuest(owner);
    if (task.status !== "waiting_input")
      throw new AppError("This task is not waiting for input", 409);
    const note = this.newNote(owner, answer, "answer");
    const saved = this.change(task, (current) => ({
      notes: [...(current.notes ?? []), note],
      status: "queued",
      question: null as unknown as undefined,
      input: { ...current.input, ...(fields ? { fields } : {}) },
    }));
    return (await this.present(owner, [saved]))[0] as AgentTask;
  }

  /**
   * Add a note to a task. Notes are the team's running instructions: every run reads all of them. With
   * `run` the task also goes back to the agent (from review, a failure, a question, or done).
   */
  async addNote(owner: string, id: string, raw: unknown): Promise<AgentTask> {
    const input = addNoteSchema.parse(raw);
    await this.refuseGuestIfGuest(owner);
    const task = await this.getTask(owner, id, true);
    if (input.run) {
      if (task.kind === "manual")
        throw new AppError("Hand this task to the agent before sending it a note to run", 422);
      if (task.kind !== "agent" && task.kind !== "plan")
        throw new AppError("This kind of task does not take notes into a new run", 422);
    }
    const sendBack = Boolean(input.run) && SEND_BACK_FROM.has(task.status);
    // Running again after a failure or a stop is retrying: the same care applies as for a retry. Reviewed
    // actions are the machine's, and are checked there before it takes the task up again.
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
    const withNote = (current: AgentTask) => {
      if ((current.notes?.length ?? 0) >= max)
        throw new AppError(`A task can carry ${max} notes. Remove one first.`, 409);
      return [...(current.notes ?? []), note];
    };
    // The note and the new status land in one step, so a task is never given out without the note.
    const saved = sendBack
      ? this.change(task, (current) => ({
          notes: withNote(current),
          status: "queued",
          error: null as unknown as undefined,
          question: null as unknown as undefined,
          leaseId: null,
          leaseUntil: null,
        }))
      : this.change(task, (current) => ({ notes: withNote(current) }), false);
    return (await this.present(owner, [saved]))[0] as AgentTask;
  }

  /** A goal was paused: its tasks that are still going, and that the person may work on, are paused. */
  async pauseGoal(owner: string, goalId: string): Promise<{ paused: number }> {
    let paused = 0;
    for (const task of this.deps.tasks.all()) {
      if (task.goalId !== goalId || TERMINAL.has(task.status) || task.status === "paused") continue;
      try {
        await this.control(owner, task.id, "pause");
        paused++;
      } catch {
        // Not theirs to pause: left as it is.
      }
    }
    return { paused };
  }

  /** Which of these ids are tasks the person may see. */
  async visibleIds(owner: string, ids: string[]): Promise<string[]> {
    const seen: string[] = [];
    for (const id of ids.slice(0, 500)) {
      const task = this.deps.tasks.get(id);
      if (!task) continue;
      try {
        await this.assertTask(owner, task, false);
        seen.push(id);
      } catch {
        // Not theirs to see: not said.
      }
    }
    return seen;
  }

  /**
   * The review of what a task prepared was decided (or ran out): the task carries on, and its run finds how it
   * was decided. Only for the task and review it is waiting on.
   */
  async reviewDecided(owner: string, id: string, actionId: string): Promise<AgentTask> {
    const task = await this.getTask(owner, id, true);
    if (task.status !== "waiting_approval" || task.actionId !== actionId) return task;
    return this.change(task, { status: "queued", leaseId: null, leaseUntil: null });
  }

  // Files

  /** Whether a file may be attached to the task, and what it is called and typed as. */
  async beginAttachment(
    owner: string,
    id: string,
    raw: { name?: unknown; bytes?: unknown },
  ): Promise<{ name: string; mime: string; bytes: number }> {
    const task = await this.getTask(owner, id, true);
    await this.refuseGuestIfGuest(owner);
    const name = attachmentName(String(raw.name ?? ""));
    const dot = name.lastIndexOf(".");
    const mime = attachmentTypes[dot < 0 ? "" : name.slice(dot).toLowerCase()];
    if (!mime)
      throw new AppError(
        `Attach a PDF, an image, or a text, Markdown, CSV or JSON file (${Object.keys(attachmentTypes).join(", ")})`,
        422,
      );
    const bytes = Number(raw.bytes);
    if (!Number.isInteger(bytes) || bytes <= 0) throw new AppError("That file is empty", 422);
    if (bytes > taskBriefLimits.attachmentBytes)
      throw new AppError(
        `Files must be ${taskBriefLimits.attachmentBytes / (1024 * 1024)} MB or smaller`,
        413,
      );
    this.checkRoom(task, bytes);
    return { name, mime, bytes };
  }

  private checkRoom(task: AgentTask, more: number) {
    const held = task.attachments ?? [];
    if (held.length >= taskBriefLimits.attachments)
      throw new AppError(
        `A task can carry ${taskBriefLimits.attachments} files. Remove one first.`,
        409,
      );
    if (
      held.reduce((total, file) => total + file.size, 0) + more >
      taskBriefLimits.attachmentTotalBytes
    )
      throw new AppError(
        `The files on a task can total ${taskBriefLimits.attachmentTotalBytes / (1024 * 1024)} MB. Remove one first.`,
        413,
      );
  }

  /** The file has been sent: put it on the task. */
  async addAttachment(owner: string, id: string, fileId: string): Promise<AgentTask> {
    const task = await this.getTask(owner, id, true);
    await this.refuseGuestIfGuest(owner);
    const file = this.deps.files?.get(fileId);
    if (
      !file ||
      file.state !== "ready" ||
      file.channelId !== `task:${id}` ||
      file.uploaderId !== owner
    )
      throw new AppError("That file cannot be attached", 422);
    if (task.attachments?.some((a) => a.id === fileId)) return task;
    this.checkRoom(task, file.bytes);
    const dot = file.name.lastIndexOf(".");
    const attachment: TaskAttachment = {
      id: file.id,
      name: file.name,
      mimeType: attachmentTypes[dot < 0 ? "" : file.name.slice(dot).toLowerCase()] ?? file.mime,
      size: file.bytes,
      addedAt: this.now(),
      addedBy: owner,
    };
    const saved = this.change(
      task,
      (current) => ({ attachments: [...(current.attachments ?? []), attachment] }),
      false,
    );
    return (await this.present(owner, [saved]))[0] as AgentTask;
  }

  /** Take a file off a task. Only the person who attached it can. */
  async removeAttachment(owner: string, id: string, fileId: string): Promise<AgentTask> {
    const task = await this.getTask(owner, id, true);
    await this.refuseGuestIfGuest(owner);
    const attachment = task.attachments?.find((a) => a.id === fileId);
    if (!attachment) throw new AppError("File not found", 404);
    if (attachment.addedBy !== owner)
      throw new AppError("Only the person who attached a file can remove it", 403);
    const saved = this.change(
      task,
      (current) => ({ attachments: (current.attachments ?? []).filter((a) => a.id !== fileId) }),
      false,
    );
    this.deps.files?.remove(fileId);
    this.deps.filesGone?.();
    return (await this.present(owner, [saved]))[0] as AgentTask;
  }

  /** Take back a note before the agent has read it. Only its author can. */
  async removeNote(owner: string, id: string, noteId: string): Promise<AgentTask> {
    const task = await this.getTask(owner, id, true);
    await this.refuseGuestIfGuest(owner);
    const note = task.notes?.find((entry) => entry.id === noteId);
    if (!note) throw new AppError("Note not found", 404);
    if (note.createdBy !== owner) throw new AppError("You can only remove your own notes", 403);
    if (note.delivered)
      throw new AppError(
        "The agent has already read this note. Add a new note to change course.",
        409,
      );
    const saved = this.change(
      task,
      (current) => ({ notes: (current.notes ?? []).filter((entry) => entry.id !== noteId) }),
      false,
    );
    return (await this.present(owner, [saved]))[0] as AgentTask;
  }
}
