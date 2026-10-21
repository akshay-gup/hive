import { type Channel, ORCHESTRATOR_CHANNEL_ID } from "../../../packages/domain/src/agent.ts";
import type { WorkspaceRole } from "../../../packages/integrations/src/workspace-token.ts";
import type { Store } from "./db.ts";
import { SHARED_OWNER } from "./engine/threads.ts";
import { AppError } from "./errors.ts";

/** Who someone is in this workspace, as far as what they may open goes. */
export interface Person {
  id: string;
  email: string;
  name: string;
  role?: WorkspaceRole;
}

/** The address a channel's member list and a person's sign-in both go by. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * What each person may open. Everyone in a workspace has the run of it, except a guest: a guest
 * has only the channels they were added to, by email address, so the control plane's invitation
 * is enough to bring them in and nothing is open to them until someone adds them to a channel.
 *
 * Only a managed workspace knows roles (they come from the control plane when someone signs in);
 * anywhere else everyone is trusted, as before.
 */
export class Access {
  constructor(
    private readonly db: Store,
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

  /** Who may change who can open a channel: the owner and admins, and anyone where there are no roles. */
  async manages(owner: string): Promise<boolean> {
    if (!this.roles) return true;
    const role = (await this.person(owner))?.role;
    return role === "owner" || role === "admin";
  }

  /** The guests who have signed in to this workspace, for choosing who to add to a channel. */
  async knownGuests(): Promise<{ email: string; name: string }[]> {
    if (!this.roles) return [];
    const users = await this.db.list<{ email?: string; name?: string; role?: string }>(
      "system",
      "users",
    );
    return users
      .filter((user) => user.role === "guest" && user.email)
      .map((user) => ({ email: normalizeEmail(user.email ?? ""), name: user.name ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
  }

  /** Whether a guest with this email address was added to this channel. */
  private added(channel: Channel | null | undefined, email: string): channel is Channel {
    return (
      !!channel &&
      channel.id !== ORCHESTRATOR_CHANNEL_ID &&
      channel.status !== "archived" &&
      !!email &&
      (channel.members ?? []).includes(email)
    );
  }

  /** The channels of the list a person may see: all of them, except for a guest. */
  async visibleChannels(owner: string, channels: Channel[]): Promise<Channel[]> {
    const person = await this.person(owner);
    if (person?.role !== "guest") return channels;
    return channels.filter((channel) => this.added(channel, person.email));
  }

  /** The ids of the channels a guest may open. */
  async guestChannelIds(owner: string): Promise<Set<string>> {
    const person = await this.person(owner);
    const channels = await this.db.list<Channel>(SHARED_OWNER, "channels");
    return new Set(
      channels.filter((channel) => this.added(channel, person?.email ?? "")).map((c) => c.id),
    );
  }

  /**
   * Throws, as if there were no such channel, unless this person may open it: a channel a guest was
   * not added to is not something to tell them about.
   */
  async assertChannel(owner: string, channelId: string): Promise<void> {
    const person = await this.person(owner);
    if (person?.role !== "guest") return;
    const channel = await this.db.get<Channel>(SHARED_OWNER, "channels", channelId);
    if (!this.added(channel, person.email)) throw new AppError("Channel not found", 404);
  }
}
