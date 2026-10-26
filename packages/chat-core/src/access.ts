import {
  type Channel,
  type ChannelView,
  GENERAL_PROJECT_ID,
  ORCHESTRATOR_CHANNEL_ID,
  type Project,
  type ProjectRole,
} from "../../domain/src/agent.ts";
import type { WorkspaceRole } from "../../integrations/src/workspace-token.ts";
import { AppError } from "./errors.ts";
import { SHARED_OWNER } from "./shared.ts";
import type { RecordStore } from "./store.ts";

/** Who someone is in this workspace, as far as what they may open goes. */
export interface Person {
  id: string;
  email: string;
  name: string;
  role?: WorkspaceRole;
}

/** The address a channel's member list and a person's sign-in both go by. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Whether this address is named in the channel: it is in the member list. */
export const named = (channel: Channel, email: string) =>
  !!email && (channel.members ?? []).includes(email);

/** Whether the channel is a direct message: two people's, found by their names. */
export const isDm = (channel: Channel) => channel.kind === "dm";

/** Whether the channel is one anyone in the workspace but a guest may find. */
export const isPublic = (channel: Channel) => (channel.visibility ?? "public") === "public";

const runs = (person: Person) => person.role === "owner" || person.role === "admin";

/**
 * Whether this person may open the channel. A guest, and anyone at a private channel, only if they
 * are named in it; a public channel is open to the whole team. A channel is looked at by what it
 * says of the person: the channels of a workspace that keeps no roles are open to everyone.
 */
export function canOpen(person: Person | null, channel: Channel | null | undefined): boolean {
  if (!channel) return false;
  if (!person) return true;
  if (channel.id === ORCHESTRATOR_CHANNEL_ID) return person.role !== "guest";
  if (person.role === "guest") return channel.status !== "archived" && named(channel, person.email);
  return isPublic(channel) || named(channel, person.email);
}

/**
 * Whether this person is in the channel, as it is in their sidebar rather than only something they
 * could open: named in it, or, in a public channel everyone is in, one of the team.
 */
export function isIn(person: Person | null, channel: Channel): boolean {
  if (!person) return true;
  if (named(channel, person.email)) return true;
  return person.role !== "guest" && isPublic(channel) && channel.everyone !== false;
}

/** Whether this person manages the channel: its managers, and the owner and admins wherever they can open it. */
export function managesChannel(person: Person | null, channel: Channel): boolean {
  if (!person) return true;
  if (!canOpen(person, channel)) return false;
  return runs(person) || (channel.managers ?? []).includes(person.email);
}

/** What a project says of who is in it and how open it is: all the rules below need. */
type ProjectRules = Pick<Project, "access" | "members"> & { id?: string };

/** The part this person has in the project, if they were named in it. */
export function projectRole(person: Person | null, project: ProjectRules): ProjectRole | null {
  if (!person?.email) return null;
  return (project.members ?? []).find((m) => m.email === person.email)?.role ?? null;
}

/**
 * Whether the project is to be shown to this person. Those who run the workspace see all of them; a
 * guest and anyone at a private project only if they are named in it; every other project is open to
 * the team. A workspace that keeps no roles shows everyone everything.
 */
export function canViewProject(person: Person | null, project: ProjectRules): boolean {
  // General is where work goes that names no project, a guest's too: what is in it is shown by its channel.
  if (!person || runs(person) || project.id === GENERAL_PROJECT_ID) return true;
  if (person.role === "guest" || (project.access ?? "open") === "private")
    return projectRole(person, project) !== null;
  return true;
}

/**
 * Whether this person may make and change the project's tasks: in an open project anyone on the team
 * may, and in the others its admins and members; a viewer only looks.
 */
export function canWorkInProject(person: Person | null, project: ProjectRules): boolean {
  if (!person || runs(person) || project.id === GENERAL_PROJECT_ID) return true;
  const role = projectRole(person, project);
  if (role === "admin" || role === "member") return true;
  return person.role !== "guest" && (project.access ?? "open") === "open";
}

/** Whether this person runs the project: its admins, and those who run the workspace. */
export function managesProject(person: Person | null, project: ProjectRules): boolean {
  if (!person || runs(person)) return true;
  return projectRole(person, project) === "admin";
}

/** The project as this person is shown it: with what they may do with it. */
export function projectFor(person: Person | null, project: Project): Project {
  return {
    ...project,
    you: {
      role: projectRole(person, project),
      canWork: canWorkInProject(person, project),
      canManage: managesProject(person, project),
    },
  };
}

/**
 * Whether a task is to be shown to the person: it belongs to a channel they may open, or was asked for
 * in one, and, if it is in a project, the project is theirs to see.
 */
export function canSeeTask(
  scope: Scope,
  task: { channelId?: string | null; originChannelId?: string | null },
  project?: ProjectRules | null,
): boolean {
  if (project && !canViewProject(scope.person, project)) return false;
  return scope.allows(task.channelId) || scope.allows(task.originChannelId);
}

/** What a request may reach: whether the channel with this id is one the person may open. */
export interface Scope {
  person: Person | null;
  /** A missing id is the orchestrator's. A channel this workspace does not have is not a guest's. */
  allows(channelId?: string | null): boolean;
}

/**
 * What each person may open. Everyone in a workspace has the run of it, except in the channels
 * that are not theirs to see: a guest has only the channels they were added to, and a private
 * channel is its members'. People are named in a channel by email address, so the control plane's
 * invitation is enough to bring a guest in, and nothing is open to them until someone adds them.
 *
 * Only a managed workspace knows roles (they come from the control plane when someone signs in);
 * anywhere else everyone is trusted, as before.
 */
export class Access {
  constructor(
    private readonly db: RecordStore,
    private readonly roles: boolean,
  ) {}

  /** The person behind a session, or null for one this workspace has not recorded. */
  async person(owner: string): Promise<Person | null> {
    if (!this.roles) return null;
    const user = await this.db.get<{ id: string; email?: string; name?: string; role?: string }>(
      "system",
      "users",
      owner,
    );
    if (!user) return null;
    const role = (["owner", "admin", "member", "guest"] as const).find((r) => r === user.role);
    return { id: owner, email: normalizeEmail(user.email ?? ""), name: user.name ?? "", role };
  }

  async isGuest(owner: string): Promise<boolean> {
    return (await this.person(owner))?.role === "guest";
  }

  /** Whether this person runs the workspace: the owner and the admins, and anyone where there are no roles. */
  async manages(owner: string): Promise<boolean> {
    if (!this.roles) return true;
    const role = (await this.person(owner))?.role;
    return role === "owner" || role === "admin";
  }

  /** Everyone who has signed in to this workspace, by email address. */
  async known(): Promise<Map<string, { name: string; role: WorkspaceRole }>> {
    const users = await this.db.list<{ email?: string; name?: string; role?: string }>(
      "system",
      "users",
    );
    const people = new Map<string, { name: string; role: WorkspaceRole }>();
    for (const user of users) {
      const role = (["owner", "admin", "member", "guest"] as const).find((r) => r === user.role);
      if (user.email && role)
        people.set(normalizeEmail(user.email), { name: user.name ?? "", role });
    }
    return people;
  }

  /** Everyone who has signed in here, by the id they are known by. */
  async byId(): Promise<Map<string, { email: string; name: string; role: WorkspaceRole }>> {
    const users = await this.db.list<{ id: string; email?: string; name?: string; role?: string }>(
      "system",
      "users",
    );
    const people = new Map<string, { email: string; name: string; role: WorkspaceRole }>();
    for (const user of users) {
      const role = (["owner", "admin", "member", "guest"] as const).find((r) => r === user.role);
      if (user.email && role)
        people.set(user.id, { email: normalizeEmail(user.email), name: user.name ?? "", role });
    }
    return people;
  }

  /** The address each person's id is known by, for turning who wrote a message into who to show. */
  async addresses(): Promise<Map<string, string>> {
    const users = await this.db.list<{ id: string; email?: string }>("system", "users");
    return new Map(
      users.filter((user) => user.email).map((user) => [user.id, normalizeEmail(user.email ?? "")]),
    );
  }

  /** Everyone who has signed in here and may open this channel, with the id they are known by. */
  async openers(
    channel: Channel,
  ): Promise<{ owner: string; email: string; name: string; role: WorkspaceRole }[]> {
    if (!this.roles) return [];
    const users = await this.db.list<{ id: string; email?: string; name?: string; role?: string }>(
      "system",
      "users",
    );
    const people: { owner: string; email: string; name: string; role: WorkspaceRole }[] = [];
    for (const user of users) {
      const role = (["owner", "admin", "member", "guest"] as const).find((r) => r === user.role);
      if (!user.email || !role) continue;
      const person = {
        id: user.id,
        owner: user.id,
        email: normalizeEmail(user.email),
        name: user.name ?? "",
        role,
      };
      if (canOpen(person, channel)) people.push(person);
    }
    return people;
  }

  /** Which channels a request from this person may reach. */
  async scope(owner: string): Promise<Scope> {
    const person = await this.person(owner);
    if (!person) return { person, allows: () => true };
    const channels = new Map(
      (await this.db.list<Channel>(SHARED_OWNER, "channels")).map((c) => [c.id, c]),
    );
    return {
      person,
      allows: (id) => {
        const channelId = id ?? ORCHESTRATOR_CHANNEL_ID;
        if (channelId === ORCHESTRATOR_CHANNEL_ID) return person.role !== "guest";
        const channel = channels.get(channelId);
        // Not a channel of this workspace: nothing there to keep from anyone but a guest.
        return channel ? canOpen(person, channel) : person.role !== "guest";
      },
    };
  }

  /**
   * Throws, as if there were no such channel, unless this person may open it: a channel they were
   * not added to is not something to tell them about.
   */
  async assertChannel(owner: string, channelId: string): Promise<void> {
    if (!(await this.scope(owner)).allows(channelId)) throw new AppError("Channel not found", 404);
  }

  /** The channels of the list a person may see. */
  async visibleChannels(owner: string, channels: Channel[]): Promise<Channel[]> {
    const person = await this.person(owner);
    if (!person) return channels;
    return channels.filter((channel) => canOpen(person, channel));
  }

  /** A channel as this person is shown it. */
  view(
    person: Person | null,
    channel: Channel,
    read?: Record<string, string>,
    muted?: ReadonlySet<string>,
    known?: ReadonlyMap<string, { name: string }>,
  ): ChannelView {
    if (!person) return channel;
    const joined = isIn(person, channel);
    const quiet = muted?.has(channel.id) ?? false;
    // A direct message goes by the other person's name, which is not the same for the two of them.
    const other = isDm(channel)
      ? ((channel.members ?? []).find((email) => email !== person.email) ?? person.email)
      : undefined;
    const label = other ? known?.get(other)?.name || other : "";
    return {
      ...channel,
      ...(other
        ? {
            name: other === person.email ? `${label} (you)` : label,
            dm: { email: other, name: label },
          }
        : {}),
      joined,
      muted: quiet,
      unread:
        !quiet &&
        joined &&
        !!channel.lastMessageAt &&
        channel.lastMessageBy !== person.email &&
        channel.lastMessageAt > (read?.[channel.id] ?? ""),
      manager: managesChannel(person, channel),
      count: (channel.members ?? []).length,
    };
  }
}
