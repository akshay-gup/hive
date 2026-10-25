import {
  type Channel,
  type ChannelDirectoryEntry,
  type ChannelPeopleView,
  channelPeopleSchema,
  channelSettingsSchema,
  ORCHESTRATOR_CHANNEL_ID,
} from "../../domain/src/agent.ts";
import type { WorkspaceRole } from "../../integrations/src/workspace-token.ts";
import {
  type Access,
  canOpen,
  isDm,
  isIn,
  isPublic,
  managesChannel,
  named,
  type Person,
} from "./access.ts";
import { AppError } from "./errors.ts";
import { SHARED_OWNER } from "./shared.ts";
import type { RecordStore } from "./store.ts";

const runs = (person: Person) => person.role === "owner" || person.role === "admin";
const ARCHIVED = "This channel is archived";
const DM = "A direct message is between the people in it";
/** An archived channel is not changed; anything else a person may not do is forbidden to them. */
const refused = (reason: string) => new AppError(reason, reason === ARCHIVED ? 409 : 403);

/**
 * Who is in a channel, who manages it, and who may change either. A public channel is open to the team, who join it or are added; a private one is found only
 * by the people in it, who can add others; a guest is added by an owner or admin, and is held to
 * the channels that name them. A channel's managers, and the owner and admins, can take people out
 * of a public channel and choose its managers; anyone in a private channel can take people out of
 * it.
 */
export class ChannelPeople {
  constructor(
    private readonly db: RecordStore,
    private readonly access: Access,
  ) {}

  private async actor(owner: string): Promise<Person> {
    const person = await this.access.person(owner);
    if (!person) throw new AppError("This workspace does not keep a list of people", 409);
    return person;
  }

  /** The channel, if this person may open it: to anyone else there is no such channel. */
  private async open(person: Person, channelId: string): Promise<Channel> {
    const channel =
      channelId === ORCHESTRATOR_CHANNEL_ID
        ? null
        : await this.db.get<Channel>(SHARED_OWNER, "channels", channelId);
    if (!channel || !canOpen(person, channel)) throw new AppError("Channel not found", 404);
    return channel;
  }

  /** Why this person may not put this address in the channel, if they may not. */
  private addDenied(
    person: Person,
    channel: Channel,
    email: string,
    role: WorkspaceRole | null,
  ): string | null {
    if (isDm(channel)) return DM;
    if (channel.status === "archived") return ARCHIVED;
    if (person.role === "guest")
      return email === person.email
        ? "A guest is added to a channel by an owner or admin"
        : "A guest can't add people to a channel";
    if (email === person.email)
      return isPublic(channel) ? null : "This channel is private. Someone in it can add you";
    if (runs(person)) return null;
    if (!isIn(person, channel)) return "Join the channel to add people to it";
    if (role === null)
      return "Only an owner or admin can add someone who has not opened this workspace yet";
    if (role === "guest" && isPublic(channel))
      return "Only an owner or admin can add a guest to a public channel";
    return null;
  }

  /** Why this person may not leave the channel, if they may not. */
  private leaveDenied(person: Person, channel: Channel): string | null {
    if (isDm(channel)) return DM;
    if (channel.status === "archived") return ARCHIVED;
    if (person.role !== "guest" && isPublic(channel) && channel.everyone !== false)
      return "Everyone in the workspace is in this channel";
    if (!named(channel, person.email)) return "You are not in this channel";
    if (person.role === "guest" && isPublic(channel)) return "A guest can't leave a public channel";
    if (!isPublic(channel) && (channel.members ?? []).length <= 1)
      return "You are the last person in this channel. Archive it instead";
    return null;
  }

  /** Why this person may not take this address out of the channel, if they may not. */
  private removeDenied(person: Person, channel: Channel, email: string): string | null {
    if (isDm(channel)) return DM;
    if (email === person.email) return this.leaveDenied(person, channel);
    if (channel.status === "archived") return ARCHIVED;
    if (person.role === "guest") return "A guest can't remove people from a channel";
    if (managesChannel(person, channel)) return null;
    if (!isPublic(channel) && isIn(person, channel)) return null;
    return "Only a channel manager, an admin or the owner can remove people from a public channel";
  }

  async describe(person: Person, channel: Channel): Promise<ChannelPeopleView> {
    const known = await this.access.known();
    const managers = new Set(channel.managers ?? []);
    const people = (channel.members ?? [])
      .map((email) => ({
        email,
        name: known.get(email)?.name ?? "",
        role: known.get(email)?.role ?? null,
        manager: managers.has(email),
      }))
      .sort(
        (a, b) =>
          Number(b.manager) - Number(a.manager) ||
          (a.name || a.email).localeCompare(b.name || b.email),
      );
    const everyone = isPublic(channel) && channel.everyone !== false;
    const candidates = [...known]
      .filter(
        ([email, who]) =>
          email !== person.email &&
          !named(channel, email) &&
          !(everyone && who.role !== "guest") &&
          this.addDenied(person, channel, email, who.role) === null,
      )
      .map(([email, who]) => ({ email, name: who.name, role: who.role }))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    const manager = managesChannel(person, channel);
    const inIt = isIn(person, channel);
    if (isDm(channel))
      return {
        id: channel.id,
        name: channel.name,
        visibility: "private",
        archived: false,
        everyone: false,
        topic: "",
        people,
        candidates: [],
        you: {
          in: inIt,
          manager: false,
          join: false,
          leave: false,
          add: false,
          remove: false,
          archive: false,
          makePrivate: false,
          makePublic: false,
          setEveryone: false,
          topic: false,
        },
      };
    return {
      id: channel.id,
      name: channel.name,
      visibility: channel.visibility ?? "public",
      archived: channel.status === "archived",
      everyone,
      topic: channel.topic ?? "",
      people,
      candidates,
      you: {
        in: inIt,
        manager,
        join:
          person.role !== "guest" && isPublic(channel) && !inIt && channel.status !== "archived",
        leave: this.leaveDenied(person, channel) === null,
        add: channel.status !== "archived" && person.role !== "guest" && (runs(person) || inIt),
        remove: channel.status !== "archived" && (manager || (!isPublic(channel) && inIt)),
        archive:
          channel.status !== "archived" &&
          person.role !== "guest" &&
          (manager || (!isPublic(channel) && inIt)),
        makePrivate: manager && isPublic(channel),
        makePublic: runs(person) && !isPublic(channel),
        setEveryone: runs(person) && isPublic(channel),
        topic: channel.status !== "archived" && person.role !== "guest" && (runs(person) || inIt),
      },
    };
  }

  /**
   * Change the channel as the decision says, from the channel as it is when that is written: two
   * people changing it at the same moment each get their change, not just the later one.
   */
  private async update(
    person: Person,
    channelId: string,
    decide: (channel: Channel) => Partial<Channel>,
  ): Promise<Channel> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const channel = await this.open(person, channelId);
      const patch = decide(channel);
      const now = new Date().toISOString();
      const saved = await this.db.compareAndSwap<Channel>(
        SHARED_OWNER,
        "channels",
        channelId,
        { updatedAt: channel.updatedAt },
        {
          ...patch,
          // Always a different stamp, so a change made from the old one cannot also go through.
          updatedAt:
            now > channel.updatedAt
              ? now
              : new Date(Date.parse(channel.updatedAt) + 1).toISOString(),
        },
      );
      if (saved) return saved;
    }
    throw new AppError("The channel was changed at the same moment. Try again", 409);
  }

  async get(owner: string, channelId: string): Promise<ChannelPeopleView> {
    const person = await this.actor(owner);
    return this.describe(person, await this.open(person, channelId));
  }

  /**
   * Put people in the channel and take people out, by email address. Joining is putting yourself
   * in, and leaving is taking yourself out. The answer is null for someone who can no longer open
   * the channel.
   */
  async change(owner: string, channelId: string, raw: unknown): Promise<ChannelPeopleView | null> {
    const input = channelPeopleSchema.parse(raw);
    const person = await this.actor(owner);
    const known = await this.access.known();
    const saved = await this.update(person, channelId, (channel) => {
      const members = new Set(channel.members ?? []);
      for (const email of new Set(input.add ?? [])) {
        if (members.has(email)) continue;
        const denied = this.addDenied(person, channel, email, known.get(email)?.role ?? null);
        if (denied) throw refused(denied);
        members.add(email);
      }
      for (const email of new Set(input.remove ?? [])) {
        if (!members.has(email)) {
          // Nothing to take out; but someone trying to leave a channel they are not named in is told why.
          const denied = email === person.email ? this.leaveDenied(person, channel) : null;
          if (denied) throw new AppError(denied, 409);
          continue;
        }
        const denied = this.removeDenied(person, channel, email);
        if (denied) throw refused(denied);
        members.delete(email);
      }
      if (!isPublic(channel) && members.size === 0)
        throw new AppError("A private channel needs someone in it. Archive it instead", 409);
      const managers = (channel.managers ?? []).filter((email) => members.has(email));
      return { members: [...members].sort(), managers };
    });
    return canOpen(person, saved) ? this.describe(person, saved) : null;
  }

  /**
   * Every channel in the workspace for an owner or admin, the private ones too, so that none is lost
   * when the people in it have gone, and a team can see what exists. It lists what the channels are
   * and who is in them, not what is said there; to read that, an admin joins a channel, which
   * names them in it for everyone there to see.
   */
  async directory(owner: string): Promise<ChannelDirectoryEntry[]> {
    const person = await this.actor(owner);
    if (!runs(person)) throw refused("Only an owner or admin can see every channel");
    const known = await this.access.known();
    const channels = await this.db.list<Channel>(SHARED_OWNER, "channels");
    return (
      channels
        // Direct messages are between the two people; no list shows them to anyone else.
        .filter((channel) => channel.id !== ORCHESTRATOR_CHANNEL_ID && !isDm(channel))
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          visibility: channel.visibility ?? "public",
          archived: channel.status === "archived",
          everyone: isPublic(channel) && channel.everyone !== false,
          count: (channel.members ?? []).length,
          managers: (channel.managers ?? []).map((email) => known.get(email)?.name || email),
          joined: isIn(person, channel),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  }

  private async entry(owner: string, channelId: string): Promise<ChannelDirectoryEntry> {
    const found = (await this.directory(owner)).find((entry) => entry.id === channelId);
    if (!found) throw new AppError("Channel not found", 404);
    return found;
  }

  /** An owner or admin puts themself in a channel they cannot open, which is how they get to read it. */
  async enter(owner: string, channelId: string): Promise<ChannelDirectoryEntry> {
    const person = await this.actor(owner);
    if (!runs(person)) throw refused("Only an owner or admin can join any channel");
    for (let attempt = 0; attempt < 5; attempt++) {
      const channel = await this.db.get<Channel>(SHARED_OWNER, "channels", channelId);
      if (!channel || channelId === ORCHESTRATOR_CHANNEL_ID || isDm(channel))
        throw new AppError("Channel not found", 404);
      if (channel.status === "archived") throw new AppError(ARCHIVED, 409);
      if (isIn(person, channel)) return this.entry(owner, channelId);
      const now = new Date().toISOString();
      const saved = await this.db.compareAndSwap<Channel>(
        SHARED_OWNER,
        "channels",
        channelId,
        { updatedAt: channel.updatedAt },
        {
          members: [...new Set([...(channel.members ?? []), person.email])].sort(),
          updatedAt:
            now > channel.updatedAt
              ? now
              : new Date(Date.parse(channel.updatedAt) + 1).toISOString(),
        },
      );
      if (saved) return this.entry(owner, channelId);
    }
    throw new AppError("The channel was changed at the same moment. Try again", 409);
  }

  /** Choose who manages the channel, among the people in it. */
  async managers(owner: string, channelId: string, raw: unknown): Promise<ChannelPeopleView> {
    const input = channelPeopleSchema.parse(raw);
    const person = await this.actor(owner);
    const known = await this.access.known();
    const saved = await this.update(person, channelId, (channel) => {
      if (isDm(channel)) throw new AppError(DM, 409);
      if (channel.status === "archived") throw new AppError(ARCHIVED, 409);
      if (!managesChannel(person, channel))
        throw new AppError(
          "Only a channel manager, an admin or the owner can choose who manages a channel",
          403,
        );
      const members = new Set(channel.members ?? []);
      const managers = new Set(channel.managers ?? []);
      for (const email of new Set(input.add ?? [])) {
        if (!members.has(email)) throw new AppError("Add them to the channel first", 409);
        if (known.get(email)?.role === "guest")
          throw new AppError("A guest can't manage a channel", 409);
        managers.add(email);
      }
      for (const email of new Set(input.remove ?? [])) managers.delete(email);
      return { managers: [...managers].sort() };
    });
    return this.describe(person, saved);
  }

  /**
   * Make the channel private or public, or choose whether everyone in the workspace is in it. The
   * people who were in a channel as the team stay in it when it stops being everyone's: they are
   * named from then on.
   */
  async settings(owner: string, channelId: string, raw: unknown): Promise<ChannelPeopleView> {
    const input = channelSettingsSchema.parse(raw);
    const person = await this.actor(owner);
    const known = await this.access.known();
    const saved = await this.update(person, channelId, (channel) => {
      if (isDm(channel)) throw new AppError(DM, 409);
      if (channel.status === "archived") throw new AppError(ARCHIVED, 409);
      if (
        input.topic !== undefined &&
        (person.role === "guest" || !(runs(person) || isIn(person, channel)))
      )
        throw new AppError("Only someone in the channel can change its topic", 403);
      let visibility = channel.visibility ?? "public";
      if (input.visibility && input.visibility !== visibility) {
        if (input.visibility === "private" && !managesChannel(person, channel))
          throw new AppError(
            "Only a channel manager, an admin or the owner can make a channel private",
            403,
          );
        if (input.visibility === "public" && !runs(person))
          throw new AppError("Only an owner or admin can make a private channel public", 403);
        visibility = input.visibility;
      }
      const was = isPublic(channel) && channel.everyone !== false;
      const wants = visibility === "private" ? false : (input.everyone ?? was);
      if (wants !== was && !runs(person))
        throw new AppError(
          was
            ? "Everyone in the workspace is in this channel, so only an owner or admin can change that"
            : "Only an owner or admin can put everyone in the workspace in a channel",
          403,
        );
      if (input.everyone && visibility === "private")
        throw new AppError("A private channel can't have everyone in it", 409);
      const everyone = wants;
      const members = new Set(channel.members ?? []);
      if (was && !everyone)
        for (const [email, who] of known) if (who.role !== "guest") members.add(email);
      return {
        visibility,
        everyone,
        members: [...members].sort(),
        ...(input.topic !== undefined ? { topic: input.topic } : {}),
      };
    });
    return this.describe(person, saved);
  }
}
