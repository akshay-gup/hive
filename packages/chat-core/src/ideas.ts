import {
  GENERAL_PROJECT_ID,
  type Idea,
  type IdeaBatch,
  ideaBatchSchema,
  ideaDecisionSchema,
  ideaInputSchema,
} from "../../domain/src/agent.ts";
import { type Access, canViewProject } from "./access.ts";
import type { Entries, Entry } from "./entries.ts";
import type { EntryRules } from "./entry-rules.ts";
import { AppError } from "./errors.ts";
import type { Sql } from "./sql.ts";
import type { Tasks } from "./work.ts";
import type { Work } from "./work-rules.ts";

const KIND = "idea";
type Data = Pick<Idea, "title" | "reason" | "evidence" | "prompt" | "kind" | "input" | "taskId"> & {
  sourceId?: string;
};

/** Suggestions are room entries. The machine supplies shared-mail suggestions; the room owns their
 * audience, decisions and the goal/task created by an acceptance. Nothing reads the machine to show them. */
export class Ideas {
  private receiving: Promise<void> = Promise.resolve();
  constructor(
    private readonly deps: {
      sql: Sql;
      access: Access;
      entries: Entries;
      rules: EntryRules;
      work: Work;
      tasks: Tasks;
      channelExists: (id: string) => Promise<boolean>;
      changed: (entry: Entry) => void;
    },
  ) {}

  private view(entry: Entry): Idea {
    const data = entry.data as unknown as Data;
    const { sourceId: _sourceId, ...shown } = data;
    return {
      ...shown,
      id: entry.id,
      status: entry.status as Idea["status"],
      createdAt: entry.createdAt,
      createdBy: entry.createdBy,
      scope: entry.scope,
      ...(entry.scope.type === "channel" ? { channelId: entry.scope.id } : {}),
    };
  }

  async list(owner: string): Promise<Idea[]> {
    if ((await this.deps.access.person(owner))?.role === "guest") return [];
    const ideas = (await this.deps.rules.visible(owner, KIND)).map((entry) => this.view(entry));
    const ids = ideas.flatMap((idea) => (idea.taskId ? [idea.taskId] : []));
    const visible = new Set(await this.deps.work.visibleIds(owner, ids));
    return ideas
      .map(({ taskId, ...idea }) => ({
        ...idea,
        ...(taskId && visible.has(taskId) ? { taskId } : {}),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(owner: string, raw: unknown): Promise<Idea> {
    await this.member(owner);
    const { scope = { type: "person" }, ...data } = ideaInputSchema.parse(raw);
    return this.view(
      await this.deps.rules.create(owner, { kind: KIND, scope, status: "new", data }),
    );
  }

  /** Old records retain their channel; new mail suggestions belong to the non-guest team.
   * Replayed batches never reset a decision. Completion is checked against the room's tasks. */
  receive(raw: IdeaBatch): Promise<void> {
    const batch = ideaBatchSchema.parse(raw);
    const next = this.receiving.then(() => this.applyBatch(batch));
    this.receiving = next.catch(() => undefined);
    return next;
  }

  private async applyBatch(batch: IdeaBatch): Promise<void> {
    const channels = new Set<string>();
    for (const idea of batch.ideas)
      if (idea.channelId && (await this.deps.channelExists(idea.channelId)))
        channels.add(idea.channelId);
    const completed = new Set(
      this.deps.tasks
        .all()
        .filter((t) => ["succeeded", "in_review"].includes(t.status))
        .map((t) => `${t.kind}:${t.input.messageId}`),
    );
    const sent = new Set(batch.sentMessageIds);
    const obsolete = (data: Data) =>
      typeof data.input.messageId === "string" &&
      (sent.has(data.input.messageId) || completed.has(`${data.kind}:${data.input.messageId}`));
    const changed: Entry[] = [];
    this.deps.sql.transaction(() => {
      for (const idea of batch.ideas) {
        if (idea.channelId && !channels.has(idea.channelId)) continue;
        const { id, channelId, status, taskId, createdAt, ...fields } = idea;
        const data: Data = {
          ...fields,
          sourceId: id,
          ...(taskId && this.deps.tasks.get(taskId) ? { taskId } : {}),
        };
        const kept = this.deps.entries.putIfAbsent({
          id: `idea:${id}`,
          kind: KIND,
          createdBy: "agent",
          scope: channelId ? { type: "channel", id: channelId } : { type: "team" },
          createdAt,
          status: status === "new" && obsolete(data) ? "dismissed" : status,
          data,
        });
        if (kept.made) changed.push(kept.entry);
      }
      for (const entry of this.deps.entries.list(KIND))
        if (
          entry.status === "new" &&
          (entry.scope.type === "team" || entry.scope.type === "channel") &&
          (entry.data as unknown as Data).sourceId &&
          obsolete(entry.data as unknown as Data)
        )
          changed.push(this.deps.entries.put({ ...entry, status: "dismissed" }));
    });
    for (const entry of changed) this.deps.changed(entry);
  }

  async decide(owner: string, id: string, raw: unknown): Promise<Idea> {
    await this.member(owner);
    const input = ideaDecisionSchema.parse(raw);
    const entry = await this.deps.rules.open(owner, id, "write");
    if (entry.kind !== KIND) throw new AppError("Idea not found", 404);
    if (entry.status !== "new") return this.shown(owner, id);
    if (input.action === "dismiss") {
      // Re-read after permission checks: an acceptance may have committed while they were running.
      const saved = this.deps.entries.get(id);
      if (saved?.status === "new")
        this.deps.changed(this.deps.entries.put({ ...saved, status: "dismissed" }));
      return this.shown(owner, id);
    }
    const data = entry.data as unknown as Data;
    const projectId = entry.scope.type === "project" ? entry.scope.id : input.projectId;
    if ((entry.scope.type === "person" || entry.scope.type === "channel") && !projectId)
      throw new AppError("Choose a project before starting this private idea", 409);
    const projects = await this.deps.work.projectsFor(owner);
    const project = projects.find((p) => p.id === (projectId ?? GENERAL_PROJECT_ID));
    if (!project) throw new AppError("Project not found", 404);
    for (const [personId, person] of await this.deps.access.byId())
      if (
        canViewProject({ ...person, id: personId }, project) &&
        !(await this.deps.rules.can(personId, entry, "see"))
      )
        throw new AppError("That project is visible to people who cannot see this idea", 409);
    const draft = await this.deps.work.prepareTask(
      owner,
      {
        title: data.title,
        prompt: input.prompt ?? data.prompt,
        kind: data.kind,
        input: data.input,
        projectId: project.id,
        ...(entry.scope.type === "channel" ? { channelId: entry.scope.id } : {}),
      },
      { key: `idea:${data.sourceId ?? id}` },
    );
    let goal: Entry | undefined;
    let accepted: Entry | undefined;
    this.deps.sql.transaction(() => {
      const current = this.deps.entries.get(id);
      if (current?.status !== "new") return;
      const goalId = `idea-goal:${id}`;
      const task = draft.save(goalId);
      if (task.goalId === goalId)
        goal = this.deps.entries.put({
          id: goalId,
          kind: "goal",
          scope: entry.scope,
          createdBy: owner,
          status: "active",
          data: { title: data.title, description: data.reason, category: "", milestones: [] },
        });
      accepted = this.deps.entries.put({
        ...current,
        status: "accepted",
        data: { ...data, prompt: task.prompt, taskId: task.id },
      });
    });
    draft.announce();
    if (goal) this.deps.changed(goal);
    if (accepted) this.deps.changed(accepted);
    return this.shown(owner, id);
  }

  private async shown(owner: string, id: string): Promise<Idea> {
    const idea = (await this.list(owner)).find((idea) => idea.id === id);
    if (!idea) throw new AppError("Idea not found", 404);
    return idea;
  }

  private async member(owner: string) {
    if ((await this.deps.access.person(owner))?.role === "guest")
      throw new AppError("Guests cannot manage ideas", 403);
  }
}
