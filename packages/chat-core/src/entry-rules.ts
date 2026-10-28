import { type Channel, ORCHESTRATOR_CHANNEL_ID } from "../../domain/src/agent.ts";
import {
  type Access,
  canOpen,
  canViewProject,
  canWorkInProject,
  managesChannel,
  managesProject,
  type Person,
} from "./access.ts";
import type { Entries, Entry, EntryInput, EntryScope } from "./entries.ts";
import { AppError } from "./errors.ts";
import type { Projects } from "./work.ts";

export type EntryRight = "see" | "write" | "manage";

export interface EntryRulesDeps {
  access: Access;
  entries: Entries;
  projects: Projects;
  /** A channel of this workspace, or null if there is none with the id. */
  channelOf: (id: string) => Promise<Channel | null>;
  /** An entry was made, changed or removed (then `removed` is set): the app is told, to those who may see it. */
  changed?: (entry: Entry, removed?: boolean, audience?: string[]) => void;
  newId?: () => string;
}

const GONE = "That item is not there, or you cannot see it.";

const runs = (person: Person | null) =>
  !person || person.role === "owner" || person.role === "admin";

/**
 * Who may see, change and run an entry, from its scope, worked out each time it is read:
 * - a person's entry is that person's and nobody else's, **not even an admin's**;
 * - a project's follows the project: seen by whoever may see the project, changed by whoever may work in
 *   it, managed by its admins;
 * - a channel's follows the channel: seen and changed by those who may open it, managed by its managers;
 * - the team's is for everyone but a guest, and managed by whoever made it and those who run the workspace.
 * Nothing is copied onto the entry, so a project made private hides what is in it at once.
 */
export class EntryRules {
  constructor(private readonly deps: EntryRulesDeps) {}

  private id() {
    return (this.deps.newId ?? (() => crypto.randomUUID()))();
  }

  /** Whether `owner` (a person's id) has this right over an entry in this scope. */
  async can(
    owner: string,
    entry: { scope: EntryScope; createdBy: string },
    right: EntryRight,
  ): Promise<boolean> {
    const person = await this.deps.access.person(owner);
    const { scope } = entry;
    switch (scope.type) {
      case "person":
        return scope.id === owner;
      case "team":
        if (person?.role === "guest") return false;
        return right !== "manage" || entry.createdBy === owner || runs(person);
      case "project": {
        const project = scope.id ? this.deps.projects.get(scope.id) : null;
        if (!project) return false;
        return right === "see"
          ? canViewProject(person, project)
          : right === "write"
            ? canWorkInProject(person, project)
            : managesProject(person, project);
      }
      case "channel": {
        if (!scope.id || scope.id === ORCHESTRATOR_CHANNEL_ID) return false;
        const channel = await this.deps.channelOf(scope.id);
        if (!channel) return false;
        return right === "manage" ? managesChannel(person, channel) : canOpen(person, channel);
      }
    }
  }

  /** The entries of a kind this person may see. */
  async visible(owner: string, kind: string): Promise<Entry[]> {
    const seen: Entry[] = [];
    for (const entry of this.deps.entries.list(kind))
      if (await this.can(owner, entry, "see")) seen.push(entry);
    return seen;
  }

  /** The people who may see an entry, for telling them it changed. */
  async audience(entry: Entry): Promise<string[]> {
    if (entry.scope.type === "person") return entry.scope.id ? [entry.scope.id] : [];
    const people: string[] = [];
    for (const id of (await this.deps.access.byId()).keys())
      if (await this.can(id, entry, "see")) people.push(id);
    return people;
  }

  /** One the person may see, or "not there": a hidden entry looks the same as one that does not exist. */
  async open(owner: string, id: string, right: EntryRight = "see"): Promise<Entry> {
    const entry = this.deps.entries.get(id);
    if (!entry || !(await this.can(owner, entry, "see"))) throw new AppError(GONE, 404);
    if (right !== "see" && !(await this.can(owner, entry, right)))
      throw new AppError("You cannot change that item", 403);
    return entry;
  }

  /** Make an entry for this person, in a scope they may write to. */
  async create(
    owner: string,
    input: Omit<EntryInput, "id" | "createdBy"> & { id?: string },
  ): Promise<Entry> {
    const scope = await this.checkedScope(owner, input.scope);
    const probe = { scope, createdBy: owner };
    if (!(await this.can(owner, probe, "write")))
      throw new AppError("You cannot add that here", 403);
    const entry = this.deps.entries.put({
      ...input,
      id: input.id ?? this.id(),
      scope,
      createdBy: owner,
    });
    this.deps.changed?.(entry);
    return entry;
  }

  /** Change an entry. Moving it to another scope needs the say over both. */
  async update(
    owner: string,
    id: string,
    patch: Partial<Pick<Entry, "status" | "dueAt" | "data" | "scope">>,
  ): Promise<Entry> {
    const entry = await this.open(owner, id, "write");
    let scope = entry.scope;
    if (patch.scope) {
      scope = await this.checkedScope(owner, patch.scope);
      if (scope.type !== entry.scope.type || scope.id !== entry.scope.id) {
        if (!(await this.can(owner, entry, "manage")))
          throw new AppError("You cannot move that item", 403);
        if (!(await this.can(owner, { scope, createdBy: entry.createdBy }, "manage")))
          throw new AppError("You cannot move that item there", 403);
      }
    }
    const next = this.deps.entries.put({
      id: entry.id,
      kind: entry.kind,
      createdBy: entry.createdBy,
      scope,
      status: "status" in patch ? patch.status : entry.status,
      dueAt: "dueAt" in patch ? patch.dueAt : entry.dueAt,
      data: patch.data ?? entry.data,
    });
    this.deps.changed?.(next);
    return next;
  }

  /** Remove an entry: its maker, or whoever manages its scope. */
  async remove(owner: string, id: string): Promise<{ ok: true }> {
    const entry = await this.open(owner, id);
    if (entry.createdBy !== owner && !(await this.can(owner, entry, "manage")))
      throw new AppError("You cannot remove that item", 403);
    this.deps.entries.remove(id);
    this.deps.changed?.(entry, true);
    return { ok: true };
  }

  /** What goes with a project or a channel that is deleted, counted by kind, for the warning. */
  countIn(scope: EntryScope): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.deps.entries.allInScope(scope))
      counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    return counts;
  }

  /**
   * A project or a channel is about to be deleted: so is everything in its scope. Call this before the
   * project or channel goes, so that those who could see what is deleted are known and can be told.
   */
  async removeScope(scope: EntryScope): Promise<number> {
    const gone = this.deps.entries.allInScope(scope);
    const told = new Map<string, string[]>();
    for (const entry of gone) told.set(entry.id, await this.audience(entry));
    this.deps.entries.removeScope(scope);
    for (const entry of gone) this.deps.changed?.(entry, true, told.get(entry.id));
    return gone.length;
  }

  /** The room's own writes: a notice for someone, a goal's milestone. Nobody is asked, so only code that has already decided calls this. */
  keep(input: EntryInput): Entry {
    const entry = this.deps.entries.put(input);
    this.deps.changed?.(entry);
    return entry;
  }

  private async checkedScope(owner: string, scope: EntryScope): Promise<EntryScope> {
    switch (scope.type) {
      case "person":
        // Only for oneself; the id is not taken from the caller.
        return { type: "person", id: owner };
      case "team":
        return { type: "team" };
      case "project":
        if (!scope.id || !this.deps.projects.get(scope.id))
          throw new AppError("That project is not there, or you cannot see it.", 404);
        return { type: "project", id: scope.id };
      case "channel":
        if (!scope.id || !(await this.deps.channelOf(scope.id)))
          throw new AppError("That channel is not there, or you cannot see it.", 404);
        return { type: "channel", id: scope.id };
    }
  }
}
