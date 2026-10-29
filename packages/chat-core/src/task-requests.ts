import { createHash } from "node:crypto";
import { z } from "zod";
import { type Channel, type CreateTaskInput, createTaskSchema } from "../../domain/src/agent.ts";
import type { SourceTaskAudience, SourceTaskView } from "../../domain/src/task-source.ts";
import { type Access, canOpen, canViewProject, canWorkInProject, isFixed } from "./access.ts";
import type { Entries, Entry } from "./entries.ts";
import { AppError } from "./errors.ts";
import type { Messages } from "./messages.ts";
import type { Sql } from "./sql.ts";
import type { Projects } from "./work.ts";
import type { Work } from "./work-rules.ts";

const REQUEST = "task_request";
const CONSENT = "task_sharing";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const GONE = "That task request is not there, or you cannot see it";
const DAY = 24 * 60 * 60_000;
const clip = (text: string, max: number) => text.slice(0, max).replace(/[\uD800-\uDBFF]$/u, "");
export interface TaskRequestData {
  task: CreateTaskInput;
  channelId: string;
  threadId: string;
  messageId: string;
  key: string;
  runId?: string;
  taskId?: string;
}

/** The room stages private-conversation tasks until the asker chooses a project. Only an
 * authenticated person's action can approve wider sharing; the machine cannot grant consent. */
export class TaskRequests {
  constructor(
    private readonly deps: {
      sql: Sql;
      entries: Entries;
      access: Access;
      projects: Projects;
      messages: Messages;
      work: Work;
      channel: (id: string) => Promise<Channel | null>;
      /** Synchronous snapshot of the current channel, directory and selected project. */
      sharingSnapshot: (channelId: string, projectId: string) => string;
      clock: () => number;
      changed: (entry: Entry) => Promise<void>;
      soon: () => void;
    },
  ) {}

  async propose(
    owner: string,
    raw: unknown,
    source: { messageId: string; runId?: string; key?: string },
  ): Promise<Entry> {
    const message = this.deps.messages.get(source.messageId);
    if (!message || message.deletedAt) throw new AppError("Message not found", 404);
    const channel = await this.openChannel(owner, message.channelId);
    const task = createTaskSchema.parse(raw);
    if (task.kind !== "manual")
      throw new AppError("Conversation tasks start as human tasks on the board", 422);
    await this.prune();
    const key = source.key ?? crypto.randomUUID();
    const id = `task-request:${hash(`${owner}:${channel.id}:${source.runId ?? "message"}:${key}`)}`;
    const existing = this.deps.entries.get(id);
    if (existing) return existing;
    if (
      this.deps.entries
        .list(REQUEST)
        .filter((entry) => entry.createdBy === owner && entry.status === "pending").length >= 100
    )
      throw new AppError("Finish or cancel some pending task requests first", 409);
    const entry = this.deps.entries.put({
      id,
      kind: REQUEST,
      createdBy: owner,
      scope: { type: "person", id: owner },
      status: "pending",
      dueAt: new Date(this.deps.clock() + DAY).toISOString(),
      data: {
        task,
        channelId: channel.id,
        threadId: message.threadRoot ?? message.id,
        messageId: message.id,
        key: `source-task:${id}`,
        ...(source.runId ? { runId: source.runId } : {}),
      } satisfies TaskRequestData,
    });
    this.deps.soon();
    return entry;
  }

  async fromMessage(owner: string, raw: unknown): Promise<SourceTaskView> {
    const input = z
      .object({
        messageId: z.string().min(1).max(100),
        clientId: z.string().min(1).max(100).optional(),
      })
      .parse(raw);
    const message = this.deps.messages.get(input.messageId);
    if (!message || message.deletedAt) throw new AppError("Message not found", 404);
    const text = message.body.trim();
    const title = clip(text.split("\n")[0] ?? "", 160) || "New task";
    const prompt = clip(text, 12000);
    const entry = await this.propose(
      owner,
      { kind: "manual", title, ...(prompt ? { prompt } : {}) },
      { messageId: input.messageId, key: input.clientId },
    );
    return this.view(owner, entry.id);
  }

  async view(owner: string, id: string): Promise<SourceTaskView> {
    const entry = await this.open(owner, id);
    const data = entry.data as unknown as TaskRequestData;
    const person = await this.deps.access.person(owner);
    const projects = (await this.deps.work.projectsFor(owner)).filter((p) =>
      canWorkInProject(person, p),
    );
    const recent = this.deps.entries
      .list(CONSENT)
      .filter(
        (entry) =>
          entry.createdBy === owner &&
          entry.data.channelId === data.channelId &&
          entry.data.threadId === data.threadId,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .find((entry) => projects.some((p) => p.id === entry.data.projectId));
    return {
      id,
      title: data.task.title ?? "New task",
      prompt: data.task.prompt ?? "",
      kind: data.task.kind,
      status: entry.status as SourceTaskView["status"],
      ...(data.taskId ? { taskId: data.taskId } : {}),
      ...(recent ? { suggestedProjectId: String(recent.data.projectId) } : {}),
      projects: projects.map((p) => ({ id: p.id, name: p.name, access: p.access ?? "open" })),
    };
  }

  async audience(owner: string, id: string, projectId: string): Promise<SourceTaskAudience> {
    const entry = await this.open(owner, id);
    return (await this.preview(owner, entry.data as unknown as TaskRequestData, projectId))
      .audience;
  }

  /** Used only for a named project the same asker already chose in this thread. */
  async alreadyChosen(owner: string, entry: Entry): Promise<boolean> {
    const data = entry.data as unknown as TaskRequestData;
    if (!data.task.projectId) return false;
    try {
      return (await this.preview(owner, data, data.task.projectId)).audience.confirmed;
    } catch {
      return false;
    }
  }

  async confirm(owner: string, id: string, raw: unknown): Promise<SourceTaskView> {
    const input = z
      .object({
        projectId: z.string().min(1).max(100),
        fingerprint: z.string().max(100),
        share: z.boolean().default(false),
        title: z.string().trim().min(1).max(160).optional(),
        prompt: z.string().trim().max(12000).optional(),
      })
      .parse(raw);
    const entry = await this.open(owner, id);
    if (entry.status !== "pending") return this.view(owner, id);
    const data = entry.data as unknown as TaskRequestData;
    const prompt = input.prompt ?? data.task.prompt;
    const draft = await this.deps.work.prepareTask(
      owner,
      {
        ...data.task,
        title: input.title ?? data.task.title,
        prompt: prompt || undefined,
        projectId: input.projectId,
        channelId: data.channelId,
        threadId: data.threadId,
      },
      { key: data.key, privateSource: true },
    );
    // Fetch after task validation: changed memberships invalidate the preview and require another click.
    const { audience, snapshot } = await this.preview(owner, data, input.projectId);
    if (input.fingerprint !== audience.fingerprint)
      throw new AppError("Project access changed. Review who can see this task again", 409);
    if (audience.outside.length && !audience.confirmed && !input.share)
      throw new AppError(
        "Confirm sharing this task with the people outside the conversation first",
        409,
      );
    let saved: Entry | undefined;
    this.deps.sql.transaction(() => {
      const current = this.deps.entries.get(id);
      if (current?.status !== "pending") return;
      if (snapshot !== this.deps.sharingSnapshot(data.channelId, input.projectId))
        throw new AppError("Project access changed. Review who can see this task again", 409);
      const message = this.deps.messages.get(data.messageId);
      if (!message || message.deletedAt) throw new AppError(GONE, 404);
      if (Date.parse(current.dueAt ?? "") <= this.deps.clock())
        throw new AppError("This task request expired. Ask for a new one", 409);
      const task = draft.save();
      this.deps.entries.put({
        id: this.consentId(owner, data, input.projectId),
        kind: CONSENT,
        createdBy: owner,
        scope: { type: "person", id: owner },
        data: {
          channelId: data.channelId,
          threadId: data.threadId,
          projectId: input.projectId,
          fingerprint: audience.fingerprint,
        },
      });
      saved = this.deps.entries.put({
        ...current,
        status: "created",
        dueAt: undefined,
        data: {
          ...data,
          taskId: task.id,
          task: { ...data.task, title: task.title, prompt: task.prompt },
        },
      });
    });
    draft.announce();
    if (saved) await this.deps.changed(saved);
    return this.view(owner, id);
  }

  async cancel(owner: string, id: string): Promise<SourceTaskView> {
    const entry = await this.open(owner, id);
    await this.close(entry);
    return this.view(owner, id);
  }

  async cancelRun(runId: string): Promise<void> {
    for (const entry of this.deps.entries.list(REQUEST))
      if (entry.status === "pending" && entry.data.runId === runId) await this.close(entry);
  }

  async prune(): Promise<void> {
    for (const entry of this.deps.entries.list(REQUEST)) {
      if (entry.status === "pending" && Date.parse(entry.dueAt ?? "") <= this.deps.clock())
        await this.close(entry);
      if (this.deps.clock() - Date.parse(entry.updatedAt) > 7 * DAY)
        this.deps.entries.remove(entry.id);
    }
  }

  private async close(entry: Entry) {
    const current = this.deps.entries.get(entry.id);
    if (current?.status === "pending")
      await this.deps.changed(
        this.deps.entries.put({ ...current, status: "cancelled", dueAt: undefined }),
      );
  }

  removeChannel(channelId: string): void {
    for (const kind of [REQUEST, CONSENT])
      for (const entry of this.deps.entries.list(kind))
        if (entry.data.channelId === channelId) this.deps.entries.remove(entry.id);
  }

  private async open(owner: string, id: string): Promise<Entry> {
    const entry = this.deps.entries.get(id);
    if (!entry || entry.kind !== REQUEST || entry.scope.id !== owner) throw new AppError(GONE, 404);
    const data = entry.data as unknown as TaskRequestData;
    await this.openChannel(owner, data.channelId);
    const message = this.deps.messages.get(data.messageId);
    if (!message || message.deletedAt || message.channelId !== data.channelId)
      throw new AppError(GONE, 404);
    if (entry.status === "pending" && Date.parse(entry.dueAt ?? "") <= this.deps.clock()) {
      await this.close(entry);
      return this.deps.entries.get(id) as Entry;
    }
    return entry;
  }

  private async openChannel(owner: string, id: string): Promise<Channel> {
    await this.deps.access.assertChannel(owner, id);
    const channel = await this.deps.channel(id);
    if (!channel) throw new AppError("Conversation not found", 404);
    if (isFixed(channel) || channel.visibility !== "private")
      throw new AppError("This task picker is only available in private channels", 409);
    if (channel.status === "archived") throw new AppError("This conversation is archived", 409);
    return channel;
  }

  private consentId(owner: string, data: TaskRequestData, projectId: string) {
    return `task-sharing:${hash(`${owner}:${data.channelId}:${data.threadId}:${projectId}`)}`;
  }

  private async preview(
    owner: string,
    data: TaskRequestData,
    projectId: string,
  ): Promise<{ audience: SourceTaskAudience; snapshot: string }> {
    this.deps.work.ensureGeneral();
    const snapshot = this.deps.sharingSnapshot(data.channelId, projectId);
    const channel = await this.openChannel(owner, data.channelId);
    const person = await this.deps.access.person(owner);
    const project = this.deps.projects.get(projectId);
    if (!project || !canViewProject(person, project)) throw new AppError("Project not found", 404);
    if (!canWorkInProject(person, project))
      throw new AppError("You cannot create tasks in this project", 403);
    const outside: SourceTaskAudience["outside"] = [];
    const projectPeople: string[] = [],
      channelPeople: string[] = [];
    for (const [id, who] of await this.deps.access.byId()) {
      const person = { ...who, id };
      const inChannel = canOpen(person, channel),
        inProject = canViewProject(person, project);
      if (inChannel) channelPeople.push(id);
      if (inProject) projectPeople.push(id);
      if (inProject && !inChannel)
        outside.push({ id, name: who.name || who.email, email: who.email });
    }
    const fingerprint = hash(
      JSON.stringify({
        projectId,
        projectPeople: projectPeople.sort(),
        channelPeople: channelPeople.sort(),
      }),
    );
    const consent = this.deps.entries.get(this.consentId(owner, data, projectId));
    if (snapshot !== this.deps.sharingSnapshot(data.channelId, projectId))
      throw new AppError("Project access changed. Review who can see this task again", 409);
    return {
      snapshot,
      audience: {
        projectId,
        projectName: project.name,
        fingerprint,
        confirmed: consent?.data.fingerprint === fingerprint,
        outside: outside.sort((a, b) => a.name.localeCompare(b.name)),
      },
    };
  }
}
