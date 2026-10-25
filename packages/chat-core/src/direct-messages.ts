import { createHash } from "node:crypto";
import type { Channel, DirectMessagePerson } from "../../domain/src/agent.ts";
import type { Access } from "./access.ts";
import { AppError } from "./errors.ts";
import { SHARED_OWNER } from "./shared.ts";
import type { RecordStore } from "./store.ts";

/** The channel two people share, whichever of them opens it first: its name is the same for the pair. */
export function directMessageId(a: string, b: string): string {
  const pair = [a, b].sort().join("\n");
  return `dm-${createHash("sha256").update(pair).digest("hex").slice(0, 20)}`;
}

/**
 * Direct messages: a private channel between two people (or one, to themself) that is made when the
 * first of them opens it and found by the other person's name. Everything a channel has, it has: threads,
 * files, the agent when it is mentioned. What it does not have is what makes a channel a place for many
 * people: nobody is added, nobody leaves, and it is not made public or archived (see `ChannelPeople`).
 * Not even the owner and admins can open it; it is not in the list of every channel.
 */
export class DirectMessages {
  constructor(
    private readonly db: RecordStore,
    private readonly access: Access,
    /** Told when a private channel is made, for whatever keeps the agent out of it. */
    private readonly madePrivate: (channel: Channel) => Promise<void>,
  ) {}

  private async actor(owner: string) {
    const person = await this.access.person(owner);
    if (!person?.email)
      throw new AppError("Direct messages need a workspace that knows its people", 409);
    if (person.role === "guest") throw new AppError("A guest can't send direct messages", 403);
    return person;
  }

  /** Who this person can message: the team, themself among them. Guests are in channels, not in direct messages. */
  async people(owner: string): Promise<DirectMessagePerson[]> {
    const person = await this.actor(owner);
    return [...(await this.access.known())]
      .filter(([, who]) => who.role !== "guest")
      .map(([email, who]) => ({ email, name: who.name, you: email === person.email }))
      .sort(
        (a, b) =>
          Number(b.you) - Number(a.you) || (a.name || a.email).localeCompare(b.name || b.email),
      );
  }

  /** The direct message with this person, made if it is the first time. */
  async open(owner: string, address: unknown): Promise<Channel> {
    const person = await this.actor(owner);
    const email = typeof address === "string" ? address.trim().toLowerCase() : "";
    const them = email ? (await this.access.known()).get(email) : undefined;
    if (!them) throw new AppError("There is no one by that address in this workspace", 404);
    if (them.role === "guest") throw new AppError("A guest can't be sent direct messages", 403);

    const id = directMessageId(person.email, email);
    const existing = await this.db.get<Channel>(SHARED_OWNER, "channels", id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const channel: Channel = {
      id,
      name: "Direct message",
      kind: "dm",
      status: "active",
      createdBy: owner,
      createdAt: now,
      updatedAt: now,
      workerPid: null,
      lastActiveAt: now,
      visibility: "private",
      everyone: false,
      members: [...new Set([person.email, email])].sort(),
      managers: [],
    };
    await this.db.put(SHARED_OWNER, "channels", channel);
    await this.madePrivate(channel);
    return channel;
  }
}
