import {
  type Channel,
  type ChannelView,
  createChannelSchema,
  type NotificationPrefs,
  notificationPrefsSchema,
} from "../../domain/src/agent.ts";
import { type Mentionable, withHandles } from "../../domain/src/mentions.ts";
import { type Access, isDm, isIn, isPublic, managesChannel, type Person } from "./access.ts";
import { AppError } from "./errors.ts";
import type { Messages } from "./messages.ts";
import type { Reads } from "./reads.ts";
import { SHARED_OWNER } from "./shared.ts";
import type { RecordStore } from "./store.ts";

/**
 * The workspace's channels as a person is shown them, and the making and putting away of channels. The
 * rules about who is in one live in `ChannelPeople`; this is the rest of what a channel list is.
 * Unlike the workspace server's, there is no private chat with the agent among them: these are the
 * people's.
 */
export class ChatChannels {
  constructor(
    private readonly db: RecordStore,
    private readonly access: Access,
    private readonly messages: Messages,
    private readonly reads: Reads,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * A workspace that knows its people starts with a #general everyone is in, so a new team has
   * somewhere to talk at once. Only a workspace with no channels at all gets one: an archived one
   * counts, so it does not come back after someone put it away.
   */
  private async ensureGeneral(owner: string, channels: Channel[]): Promise<Channel[]> {
    if (channels.length > 0) return channels;
    const person = await this.access.person(owner);
    if (!person?.email || person.role === "guest") return channels;
    const at = this.now();
    const general: Channel = {
      id: "general",
      name: "general",
      status: "active",
      createdBy: owner,
      createdAt: at,
      updatedAt: at,
      workerPid: null,
      lastActiveAt: at,
      visibility: "public",
      everyone: true,
      members: [],
      managers: [],
      topic: "Where the team talks about anything",
    };
    // Two people opening a new workspace at once make the same channel; only one of them writes it.
    await this.db.insertIfAbsent(SHARED_OWNER, "channels", general);
    return [(await this.db.get<Channel>(SHARED_OWNER, "channels", general.id)) ?? general];
  }

  /** The channels this person may open, as they are shown them. */
  async list(owner: string): Promise<ChannelView[]> {
    const person = await this.access.person(owner);
    const all = await this.ensureGeneral(
      owner,
      await this.db.list<Channel>(SHARED_OWNER, "channels"),
    );
    const visible = await this.access.visibleChannels(owner, all);
    const prefs = await this.notificationPrefs(owner);
    const muted = new Set(prefs.muted);
    const known = await this.access.known();
    const addresses = await this.access.addresses();
    return visible.map((channel) => this.view(owner, person, channel, muted, known, addresses));
  }

  async get(owner: string, channelId: string): Promise<ChannelView> {
    await this.access.assertChannel(owner, channelId);
    const channel = await this.db.get<Channel>(SHARED_OWNER, "channels", channelId);
    if (!channel) throw new AppError("That channel is not there, or you cannot see it.", 404);
    const prefs = await this.notificationPrefs(owner);
    return this.view(
      owner,
      await this.access.person(owner),
      channel,
      new Set(prefs.muted),
      await this.access.known(),
      await this.access.addresses(),
    );
  }

  private view(
    owner: string,
    person: Person | null,
    channel: Channel,
    muted: ReadonlySet<string>,
    known: ReadonlyMap<string, { name: string }>,
    addresses: ReadonlyMap<string, string>,
  ): ChannelView {
    const shown = this.access.view(person, channel, undefined, muted, known);
    const last = this.messages.lastActivity(channel.id);
    const seen = this.reads.at(owner, channel.id);
    return {
      ...shown,
      // What the channel last had comes from its messages, not from the channel's own record.
      lastMessageAt: last?.at ?? channel.lastMessageAt,
      lastMessageBy: last ? addresses.get(last.by) : undefined,
      unread:
        !shown.muted && shown.joined === true && this.reads.hasUnread(owner, channel.id, seen),
    };
  }

  async create(owner: string, raw: unknown): Promise<Channel> {
    const input = createChannelSchema.parse(raw);
    const person = await this.access.person(owner);
    if (!person?.email) throw new AppError("Chat needs a workspace that knows its people", 409);
    if (person.role === "guest") throw new AppError("A guest can't create a channel", 403);
    // A new workspace's first channel is #general, whichever way the first person comes to it.
    await this.ensureGeneral(owner, await this.db.list<Channel>(SHARED_OWNER, "channels"));
    const slug =
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || crypto.randomUUID().slice(0, 8);
    const id = input.id ?? slug;
    if (id.startsWith("dm-")) throw new AppError("Channel id is reserved", 409);
    const at = this.now();
    const channel: Channel = {
      id,
      name: input.name,
      status: "active",
      createdBy: owner,
      createdAt: at,
      updatedAt: at,
      workerPid: null,
      lastActiveAt: at,
      // A channel starts as just the person who made it, who manages it.
      visibility: input.visibility ?? "public",
      everyone: false,
      members: [person.email],
      managers: [person.email],
    };
    if (!(await this.db.insertIfAbsent(SHARED_OWNER, "channels", channel)))
      throw new AppError("Channel already exists", 409);
    return channel;
  }

  /**
   * Put a channel away. A channel's managers, the owner and the admins can archive one, and anyone in
   * a private channel (its last person cannot leave it); the owner and admins can archive any, a
   * private one they are not in too.
   */
  async archive(owner: string, id: string): Promise<Channel> {
    const scope = await this.access.scope(owner);
    const person = scope.person;
    if (person?.role === "guest") throw new AppError("A guest can't archive a channel", 403);
    const runs = person?.role === "owner" || person?.role === "admin";
    if (!runs && !scope.allows(id)) throw new AppError("That channel is not there, or you cannot see it.", 404);
    const channel = await this.db.get<Channel>(SHARED_OWNER, "channels", id);
    if (!channel) throw new AppError("That channel is not there, or you cannot see it.", 404);
    if (isDm(channel))
      throw scope.allows(id)
        ? new AppError("A direct message can't be archived", 409)
        : new AppError("That channel is not there, or you cannot see it.", 404);
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
      { status: "archived", updatedAt: this.now() },
    );
    if (!updated) throw new AppError("That channel is not there, or you cannot see it.", 404);
    return updated;
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

  /** The people who may be mentioned in a channel: those who can open it, but the asker. */
  async mentionable(owner: string, channelId: string): Promise<Mentionable[]> {
    await this.access.assertChannel(owner, channelId);
    const channel = await this.db.get<Channel>(SHARED_OWNER, "channels", channelId);
    if (!channel) return [];
    const person = await this.access.person(owner);
    const everyone = withHandles(await this.access.openers(channel));
    // Only what is typed and shown: the ids people are known by here stay here.
    return everyone
      .filter((who) => who.email !== person?.email)
      .map(({ email, name, handle, role }) => ({ email, name, handle, role }))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  }

  /** The person has read a channel up to a place (or all of it, with none given). */
  async markRead(owner: string, channelId: string, seq?: number): Promise<number> {
    await this.access.assertChannel(owner, channelId);
    const to = Math.min(seq ?? Number.MAX_SAFE_INTEGER, this.messages.lastSeq(channelId));
    return this.reads.mark(owner, channelId, to);
  }
}
