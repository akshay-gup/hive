import {
  type AgentTask,
  type Goal,
  goalInputSchema,
  goalPatchSchema,
} from "../../domain/src/agent.ts";
import type { Entries, Entry, EntryScope } from "./entries.ts";
import type { EntryRules } from "./entry-rules.ts";
import { AppError } from "./errors.ts";

export const GOAL = "goal";

interface GoalData {
  title: string;
  description: string;
  category: string;
  milestones: Goal["milestones"];
}

export interface GoalsDeps {
  rules: EntryRules;
  entries: Entries;
  /** Whether a channel is private, to say whose a goal made there is. */
  /** Whose a channel is: a person's own conversation, a private channel, or one the team has. */
  channelHome: (id: string) => Promise<"personal" | "private" | "public">;
  /** A goal was paused: pause its tasks that this person may work on. */
  pauseTasks: (owner: string, goalId: string) => Promise<unknown>;
  newId?: () => string;
}

const GONE = "That goal is not there, or you cannot see it.";

/**
 * The goals of a workspace, as entries with a scope: a person's own, a project's, a channel's, or the team's.
 * A goal is seen by whoever its scope lets in, and counts a task as done only if the person who started the
 * task could see the goal.
 */
export class Goals {
  constructor(private readonly deps: GoalsDeps) {}

  private view(entry: Entry): Goal {
    const data = entry.data as unknown as GoalData;
    return {
      id: entry.id,
      title: data.title,
      description: data.description,
      category: data.category,
      status: (entry.status as Goal["status"]) ?? "active",
      milestones: data.milestones,
      createdAt: entry.createdAt,
      createdBy: entry.createdBy,
      scope: entry.scope,
    };
  }

  private async homeScope(channelId: string): Promise<EntryScope> {
    const home = await this.deps.channelHome(channelId);
    return home === "personal"
      ? { type: "person" }
      : home === "private"
        ? { type: "channel", id: channelId }
        : { type: "team" };
  }

  /** The goals this person may see, newest first. */
  async list(owner: string): Promise<Goal[]> {
    return (await this.deps.rules.visible(owner, GOAL))
      .map((entry) => this.view(entry))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Make a goal. Where it is made says whose it is, unless the caller says: the team's from a public channel,
   * the channel's from a private one, the person's from their own chat (no channel).
   */
  async create(
    owner: string,
    raw: unknown,
    home: { channelId?: string; id?: string } = {},
  ): Promise<Goal> {
    const input = goalInputSchema.parse(raw);
    if (home.id) {
      const there = this.deps.entries.get(home.id);
      if (there && (await this.deps.rules.can(owner, there, "see"))) return this.view(there);
    }
    const scope: EntryScope =
      input.scope ?? (home.channelId ? await this.homeScope(home.channelId) : { type: "person" });
    const entry = await this.deps.rules.create(owner, {
      id: home.id,
      kind: GOAL,
      scope,
      status: "active",
      data: {
        title: input.title,
        description: input.description,
        category: input.category,
        milestones: input.milestones.map((title) => ({
          id: (this.deps.newId ?? (() => crypto.randomUUID()))(),
          title,
          done: false,
        })),
      } satisfies GoalData as never,
    });
    return this.view(entry);
  }

  async update(owner: string, id: string, raw: unknown): Promise<Goal> {
    const patch = goalPatchSchema.parse(raw);
    const entry = await this.open(owner, id, "write");
    const data = entry.data as unknown as GoalData;
    const next = await this.deps.rules.update(owner, id, {
      status: patch.status ?? entry.status,
      data: {
        title: patch.title ?? data.title,
        description: patch.description ?? data.description,
        category: patch.category ?? data.category,
        milestones: patch.milestones ?? data.milestones,
      } satisfies GoalData as never,
    });
    if (patch.status === "paused" && entry.status !== "paused")
      await this.deps.pauseTasks(owner, id);
    return this.view(next);
  }

  async remove(owner: string, id: string): Promise<{ ok: true }> {
    await this.open(owner, id);
    return this.deps.rules.remove(owner, id);
  }

  /** Whether this person may point a task at the goal: it is one they may see. */
  async canLink(owner: string, id: string): Promise<boolean> {
    const entry = this.deps.entries.get(id);
    return !!entry && entry.kind === GOAL && (await this.deps.rules.can(owner, entry, "see"));
  }

  /** A task that points at a goal is done: it is counted as a milestone, if the person who started it could see the goal. */
  async countTask(task: AgentTask): Promise<void> {
    if (!task.goalId || task.status !== "succeeded" || !task.createdBy) return;
    const entry = this.deps.entries.get(task.goalId);
    if (!entry || entry.kind !== GOAL || !(await this.deps.rules.can(task.createdBy, entry, "see")))
      return;
    const data = entry.data as unknown as GoalData;
    if (data.milestones.some((m) => m.id === task.id)) return;
    this.deps.rules.keep({
      ...entry,
      data: {
        ...data,
        milestones: [...data.milestones, { id: task.id, title: task.title, done: true }],
      } as never,
    });
  }

  private async open(owner: string, id: string, right: "see" | "write" = "see"): Promise<Entry> {
    const entry = this.deps.entries.get(id);
    if (!entry || entry.kind !== GOAL) throw new AppError(GONE, 404);
    return this.deps.rules.open(owner, id, right);
  }
}
