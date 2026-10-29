import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type Access,
  canOpen,
  canViewProject,
  type Person,
} from "../../../packages/chat-core/src/access.ts";
import type { Entries, EntryScope } from "../../../packages/chat-core/src/entries.ts";
import { AppError } from "../../../packages/chat-core/src/errors.ts";
import type { Goals } from "../../../packages/chat-core/src/goals.ts";
import type { Run } from "../../../packages/chat-core/src/runs.ts";
import { SHARED_OWNER } from "../../../packages/chat-core/src/shared.ts";
import { first, type Sql } from "../../../packages/chat-core/src/sql.ts";
import type { RecordStore } from "../../../packages/chat-core/src/store.ts";
import type { Projects, Tasks } from "../../../packages/chat-core/src/work.ts";
import type { Work } from "../../../packages/chat-core/src/work-rules.ts";
import type { AgentTask, Channel } from "../../../packages/domain/src/agent.ts";
import type { Routines } from "./routines.ts";

const lookupSchema = z.object({
  kind: z.enum(["all", "tasks", "projects", "goals", "routines"]).default("all"),
  query: z.string().trim().max(500).default(""),
  id: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});
type Kind = "task" | "project" | "goal" | "routine" | "channel";
type Ref = [Kind, string];
type Row = { kind: Exclude<Kind, "channel">; value: Record<string, unknown>; refs: Ref[] };
type Cache = {
  id: string;
  key: string;
  generation: string;
  resources: Record<string, string>;
  at: number;
};
type RunCache = {
  id: string;
  session: string;
  generation: string;
  actor: string;
  channelId: string;
  at: number;
};
const CACHE = "channel-board-context";
const CHANGED = "Project or channel access changed while checking the board. Please ask again.";
export const BOARD_ACCESS_CHANGED = CHANGED;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Channel lookups use the intersection of every reader's permissions, never just the asker's. */
export class ChannelBoard {
  constructor(
    private readonly deps: {
      sql: Sql;
      store: RecordStore;
      access: Access;
      entries: Entries;
      projects: Projects;
      tasks: Tasks;
      work: Work;
      goals: Goals;
      routines: Routines;
      clock: () => number;
      visibilitySnapshot: () => string;
    },
  ) {}

  private get<T>(id: string): T | null {
    const row = first<{ data: string }>(
      this.deps.sql,
      "SELECT data FROM records WHERE owner = 'system' AND kind = ? AND id = ?",
      CACHE,
      id,
    );
    return row ? (JSON.parse(row.data) as T) : null;
  }
  private put(record: Cache | RunCache) {
    this.deps.sql.run(
      "INSERT INTO records (owner, kind, id, data, updated_at) VALUES ('system', ?, ?, ?, ?) ON CONFLICT (owner, kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      CACHE,
      record.id,
      JSON.stringify(record),
      new Date(this.deps.clock()).toISOString(),
    );
  }
  private scopeKey(scope: EntryScope): unknown {
    if (scope.type === "project") {
      const project = scope.id ? this.deps.projects.get(scope.id) : null;
      return project
        ? ["project", project.id, project.access ?? "open", project.members ?? []]
        : ["missing-project", scope.id];
    }
    if (scope.type === "channel") {
      const row = first<{ data: string }>(
        this.deps.sql,
        "SELECT data FROM records WHERE owner = ? AND kind = 'channels' AND id = ?",
        SHARED_OWNER,
        scope.id ?? "",
      );
      const channel = row ? (JSON.parse(row.data) as Channel) : null;
      return channel
        ? ["channel", channel.id, channel.visibility, channel.status, channel.members]
        : ["missing-channel", scope.id];
    }
    return [scope.type, scope.id];
  }
  private resourceKey([kind, id]: Ref): string {
    if (kind === "project" || kind === "channel")
      return JSON.stringify(this.scopeKey({ type: kind, id }));
    if (kind === "task") {
      const task = this.deps.tasks.get(id);
      return task
        ? JSON.stringify([
            task.projectId ?? null,
            task.projectId ? this.scopeKey({ type: "project", id: task.projectId }) : "team",
          ])
        : "deleted";
    }
    const entry = this.deps.entries.get(id);
    return entry?.kind === kind ? JSON.stringify(this.scopeKey(entry.scope)) : "deleted";
  }
  private resourcesCurrent(cache: Cache): boolean {
    return Object.entries(cache.resources).every(
      ([ref, key]) => this.resourceKey(JSON.parse(ref) as Ref) === key,
    );
  }

  private async context(actor: string, channelId: string) {
    this.deps.work.ensureGeneral();
    const snapshot = this.deps.visibilitySnapshot();
    const [people, channels] = await Promise.all([
      this.deps.access.byId(),
      this.deps.store.list<Channel>(SHARED_OWNER, "channels"),
    ]);
    const channel = channels.find((item) => item.id === channelId);
    const person = people.get(actor);
    if (
      !channel ||
      !person ||
      channel.kind === "dm" ||
      channel.status === "archived" ||
      !canOpen({ ...person, id: actor }, channel)
    )
      throw new AppError("That channel is not there, or you cannot see it", 404);
    const readers: Person[] = [...people]
      .map(([id, who]) => ({ ...who, id }))
      .filter((who) => canOpen(who, channel));
    const projects = this.deps.projects.list();
    const sharedProjects = new Set(
      projects
        .filter((project) => readers.every((who) => canViewProject(who, project)))
        .map((p) => p.id),
    );
    const sharedChannels = new Set(
      channels.filter((target) => readers.every((who) => canOpen(who, target))).map((c) => c.id),
    );
    const allTeam = readers.every((who) => who.role !== "guest");
    const sharedScope = (scope?: EntryScope) =>
      !!scope &&
      (scope.type === "team"
        ? allTeam
        : scope.type === "person"
          ? readers.every((who) => who.id === scope.id)
          : scope.type === "project"
            ? sharedProjects.has(scope.id ?? "")
            : sharedChannels.has(scope.id ?? ""));
    const sharedTask = (task: AgentTask) =>
      task.projectId ? sharedProjects.has(task.projectId) : allTeam;
    const key = hash(
      JSON.stringify([
        channel.id,
        channel.visibility,
        channel.status,
        readers
          .map((who) => [who.id, who.email, who.role])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ]),
    );
    if (snapshot !== this.deps.visibilitySnapshot()) throw new AppError(CHANGED, 409);
    return {
      snapshot,
      key,
      people,
      channels,
      projects,
      sharedProjects,
      sharedChannels,
      sharedScope,
      sharedTask,
    };
  }

  /** A different access context gets a fresh model session, so old tool results cannot carry over. */
  async begin(run: Run): Promise<string> {
    const ctx = await this.context(run.askedBy, run.channelId);
    return this.deps.sql.transaction(() => {
      if (ctx.snapshot !== this.deps.visibilitySnapshot()) throw new AppError(CHANGED, 409);
      const id = `thread:${hash(`${run.channelId}:${run.rootId}`)}`;
      const old = this.get<Cache>(id);
      const same =
        old &&
        old.key === ctx.key &&
        Object.keys(old.resources).length < 2500 &&
        this.resourcesCurrent(old);
      const session: Cache = same
        ? { ...old, at: this.deps.clock() }
        : {
            id,
            key: ctx.key,
            generation: crypto.randomUUID(),
            resources: {},
            at: this.deps.clock(),
          };
      this.put(session);
      this.put({
        id: `run:${run.id}`,
        session: id,
        generation: session.generation,
        actor: run.askedBy,
        channelId: run.channelId,
        at: this.deps.clock(),
      });
      return session.generation;
    });
  }

  current(run: Run): boolean {
    const held = this.get<RunCache>(`run:${run.id}`);
    if (!held) return true;
    const session = this.get<Cache>(held.session);
    if (!session || session.generation !== held.generation) return false;
    if (!Object.keys(session.resources).length) return true;
    const channelRow = first<{ data: string }>(
      this.deps.sql,
      "SELECT data FROM records WHERE owner = ? AND kind = 'channels' AND id = ?",
      SHARED_OWNER,
      run.channelId,
    );
    if (!channelRow) return false;
    const channel = JSON.parse(channelRow.data) as Channel;
    const people = this.deps.sql
      .all<{ id: string; data: string }>(
        "SELECT id, data FROM records WHERE owner = 'system' AND kind = 'users'",
      )
      .map((row) => ({ ...JSON.parse(row.data), id: row.id }) as Person);
    const actor = people.find((person) => person.id === run.askedBy);
    if (
      !actor ||
      channel.kind === "dm" ||
      channel.status === "archived" ||
      !canOpen(actor, channel)
    )
      return false;
    const readers = people.filter((person) => canOpen(person, channel));
    const key = hash(
      JSON.stringify([
        channel.id,
        channel.visibility,
        channel.status,
        readers
          .map((who) => [who.id, who.email, who.role])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ]),
    );
    return session.key === key && this.resourcesCurrent(session);
  }

  private remember(run: Run, key: string, refs: Ref[]) {
    const held = this.get<RunCache>(`run:${run.id}`);
    const session = held && this.get<Cache>(held.session);
    if (
      !held ||
      !session ||
      session.generation !== held.generation ||
      session.key !== key ||
      !this.resourcesCurrent(session)
    )
      throw new AppError(CHANGED, 409);
    const resources = { ...session.resources };
    for (const ref of refs) resources[JSON.stringify(ref)] = this.resourceKey(ref);
    if (Object.keys(resources).length > 5000)
      throw new AppError("Too much board data for one reply. Narrow the lookup", 409);
    this.put({ ...session, resources, at: this.deps.clock() });
  }

  /** A legitimate edit/delete updates the cache's scope reference; other clients' changes still invalidate it. */
  changed(run: Run, kind: Kind, id: string): void {
    const held = this.get<RunCache>(`run:${run.id}`),
      session = held && this.get<Cache>(held.session);
    if (!session || session.generation !== held?.generation) return;
    const ref: Ref = [kind, id];
    if (JSON.stringify(ref) in session.resources)
      this.put({
        ...session,
        resources: { ...session.resources, [JSON.stringify(ref)]: this.resourceKey(ref) },
        at: this.deps.clock(),
      });
  }

  async read(run: Run, raw: unknown = {}) {
    const parsed = lookupSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("Invalid board lookup", 422);
    const input = parsed.data;
    if (!(await this.current(run))) throw new AppError(CHANGED, 409);
    if (!this.get<RunCache>(`run:${run.id}`)) await this.begin(run);
    const ctx = await this.context(run.askedBy, run.channelId);
    const [goals, routines] = await Promise.all([
      this.deps.goals.list(run.askedBy),
      this.deps.routines.list(run.askedBy),
    ]);
    const tasks = this.deps.tasks.all();
    const sharedTasks = new Set(tasks.filter(ctx.sharedTask).map((task) => task.id));
    const sharedGoals = new Set(
      goals.filter((goal) => ctx.sharedScope(goal.scope)).map((goal) => goal.id),
    );
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const rows: Row[] = [];
    const textLimit = input.id ? 8000 : 1000;
    const clip = (value: string | undefined, length = textLimit) =>
      value?.slice(0, length).replace(/[\uD800-\uDBFF]$/u, "");
    const refsForScope = (scope?: EntryScope): Ref[] =>
      scope?.id && (scope.type === "project" || scope.type === "channel")
        ? [[scope.type, scope.id]]
        : [];
    const taskRefs = (task: AgentTask | undefined): Ref[] =>
      task
        ? [["task", task.id], ...(task.projectId ? [["project", task.projectId] as Ref] : [])]
        : [];
    for (const project of ctx.projects)
      if (ctx.sharedProjects.has(project.id))
        rows.push({
          kind: "project",
          refs: [["project", project.id]],
          value: {
            id: project.id,
            name: project.name,
            description: project.description,
            access: project.access ?? "open",
          },
        });
    for (const task of tasks)
      if (sharedTasks.has(task.id)) {
        const blockers = (task.blockedBy ?? []).filter((id) => sharedTasks.has(id)).slice(0, 50);
        const goalId = task.goalId && sharedGoals.has(task.goalId) ? task.goalId : undefined;
        rows.push({
          kind: "task",
          refs: [
            ...taskRefs(task),
            ...blockers.flatMap((id) => taskRefs(taskById.get(id))),
            ...(goalId ? [["goal", goalId] as Ref] : []),
          ],
          value: {
            id: task.id,
            title: task.title,
            description: clip(task.prompt),
            kind: task.kind,
            status: task.status,
            projectId: task.projectId,
            goalId,
            blockedBy: blockers,
            priority: task.priority,
            labels: task.labels,
            startAt: task.startAt,
            dueAt: task.dueAt,
            updatedAt: task.updatedAt,
            result: clip(task.result),
            question: clip(task.question),
            createdBy: task.createdBy
              ? ctx.people.get(task.createdBy)?.name || task.createdBy
              : undefined,
            notes: task.notes
              ?.slice(input.id ? -10 : -3)
              .map((note) => ({ text: clip(note.text, 1000), createdAt: note.createdAt })),
            truncated:
              (task.prompt?.length ?? 0) > textLimit ||
              (task.result?.length ?? 0) > textLimit ||
              (task.notes?.length ?? 0) > (input.id ? 10 : 3),
          },
        });
      }
    for (const goal of goals)
      if (ctx.sharedScope(goal.scope)) {
        const milestones = goal.milestones.filter(
          (item) => !taskById.has(item.id) || sharedTasks.has(item.id),
        );
        const shown = milestones.slice(0, input.id ? 100 : 10);
        rows.push({
          kind: "goal",
          refs: [
            ["goal", goal.id],
            ...refsForScope(goal.scope),
            ...shown.flatMap((item) => taskRefs(taskById.get(item.id))),
          ],
          value: {
            id: goal.id,
            title: goal.title,
            description: clip(goal.description),
            category: goal.category,
            status: goal.status,
            scope: goal.scope,
            milestones: shown,
            truncated: goal.description.length > textLimit || milestones.length > shown.length,
          },
        });
      }
    for (const routine of routines)
      if (ctx.sharedScope(routine.scope))
        rows.push({
          kind: "routine",
          refs: [["routine", routine.id], ...refsForScope(routine.scope)],
          value: {
            id: routine.id,
            title: routine.title,
            note: clip(routine.note, input.id ? 4000 : 1000),
            memo: clip(routine.memo, input.id ? 4000 : 1000),
            schedule: routine.schedule,
            scheduleText: routine.scheduleText,
            status: routine.status,
            nextRunAt: routine.nextRunAt,
            lastRunAt: routine.lastRunAt,
            lastResult: clip(routine.lastResult, 300),
            scope: routine.scope,
            truncated:
              routine.note.length > (input.id ? 4000 : 1000) ||
              routine.memo.length > (input.id ? 4000 : 1000),
          },
        });
    const singular = input.kind === "all" ? null : input.kind.slice(0, -1);
    const query = input.query.toLowerCase();
    const matching = rows
      .filter(
        (row) =>
          (!singular || row.kind === singular) &&
          (!input.id || row.value.id === input.id) &&
          (!query || JSON.stringify(row.value).toLowerCase().includes(query)),
      )
      .sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) || String(a.value.id).localeCompare(String(b.value.id)),
      );
    const selected: Row[] = [];
    let bytes = 4096;
    for (const row of matching.slice(input.offset, input.offset + input.limit)) {
      const size = new TextEncoder().encode(JSON.stringify(row.value)).byteLength;
      if (bytes + size > 160_000) {
        if (!selected.length)
          throw new AppError("Those details are too large. Ask for a summary without an id", 422);
        break;
      }
      bytes += size;
      selected.push(row);
    }
    if (ctx.snapshot !== this.deps.visibilitySnapshot()) throw new AppError(CHANGED, 409);
    this.remember(
      run,
      ctx.key,
      selected.flatMap((row) => row.refs),
    );
    const next = input.offset + selected.length;
    const values = (kind: Row["kind"]) =>
      selected.filter((row) => row.kind === kind).map((row) => row.value);
    return {
      tasks: values("task"),
      projects: values("project"),
      goals: values("goal"),
      routines: values("routine"),
      hasMore: next < matching.length,
      ...(next < matching.length ? { nextOffset: next } : {}),
    };
  }

  async require(run: Run, kind: "tasks" | "goals" | "routines" | "projects", id: string) {
    const result = await this.read(run, { kind, id, limit: 1 });
    const found = result[kind][0];
    if (!found)
      throw new AppError("That item is not there, or everyone in this channel cannot see it", 404);
    return found;
  }
  async visibleIds(run: Run, ids: string[]): Promise<string[]> {
    if (!(await this.current(run))) throw new AppError(CHANGED, 409);
    if (!this.get<RunCache>(`run:${run.id}`)) await this.begin(run);
    const ctx = await this.context(run.askedBy, run.channelId);
    const wanted = new Set(ids);
    const shown = this.deps.tasks
      .all()
      .filter((task) => wanted.has(task.id) && ctx.sharedTask(task));
    const allowed = new Set(shown.map((task) => task.id));
    if (ctx.snapshot !== this.deps.visibilitySnapshot()) throw new AppError(CHANGED, 409);
    this.remember(
      run,
      ctx.key,
      shown.flatMap((task): Ref[] => [
        ["task", task.id],
        ...(task.projectId ? [["project", task.projectId] as Ref] : []),
      ]),
    );
    return ids.filter((id) => allowed.has(id));
  }
  prune(): void {
    this.deps.sql.run(
      "DELETE FROM records WHERE owner = 'system' AND kind = ? AND updated_at < ?",
      CACHE,
      new Date(this.deps.clock() - 7 * 24 * 3600_000).toISOString(),
    );
  }
}
