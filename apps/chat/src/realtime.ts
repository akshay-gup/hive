import { canOpen, isIn } from "../../../packages/chat-core/src/access.ts";
import type { ChatEvent } from "../../../packages/chat-core/src/events.ts";
import { SHARED_OWNER } from "../../../packages/chat-core/src/shared.ts";
import type { Channel } from "../../../packages/domain/src/agent.ts";
import type { ChatClientFrame, ChatFrame, ChatMessage } from "../../../packages/domain/src/chat.ts";
import type { ChatCore } from "./core.ts";

/** Someone connected: who, until when their token holds, and a way to talk to them. */
export interface Peer {
  /** The person's id. */
  id: string;
  /** When their token runs out, in milliseconds; the connection ends then and they connect again with a fresh one. */
  exp: number;
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** How soon after a person was last shown to be typing that another is passed on. */
const TYPING_GAP_MS = 1_500;
/** The connection closes with this when the person's token has run out. */
export const CLOSE_EXPIRED = 4401;

/**
 * What goes to the people who are connected: each event to those who may see it, and what a person
 * missed while they were away, sent when they come back. It decides who may see what from the same
 * rules the requests are held to, at the moment of sending, so someone who has lost a channel stops
 * hearing from it at once.
 */
export class Realtime {
  private chain: Promise<void> = Promise.resolve();
  private readonly typing = new Map<string, number>();

  constructor(
    private readonly core: ChatCore,
    private readonly peers: () => Peer[],
    private readonly now: () => number = Date.now,
  ) {}

  /** Queue an event to be sent; they go in the order they were made. The promise ends when this one has been sent. */
  publish(event: ChatEvent): Promise<void> {
    this.chain = this.chain
      .then(() => this.deliver(event))
      .catch((error) => {
        console.error(`[Hive chat] could not deliver an event: ${String(error)}`);
      });
    return this.chain;
  }

  /**
   * Show a message as it is now to those who may see it, in its place among the events (so one shown later
   * is never undone by one shown before). It is not written down and has no number: a person who connects
   * afterwards is sent the message as it was last kept.
   */
  stream(channelId: string, message: ChatMessage): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        const peers = this.peers();
        if (peers.length === 0) return;
        const channel = await this.core.store.get<Channel>(SHARED_OWNER, "channels", channelId);
        if (!channel) return;
        const text = JSON.stringify({ t: "stream", channelId, message } satisfies ChatFrame);
        for (const peer of peers) {
          if (!this.live(peer)) continue;
          if (canOpen(await this.core.access.person(peer.id), channel)) peer.send(text);
        }
      })
      .catch((error) => {
        console.error(`[Hive chat] could not show a message: ${String(error)}`);
      });
    return this.chain;
  }

  private frame(event: ChatEvent): string {
    const frame: ChatFrame = {
      t: "event",
      id: event.id,
      type: event.type,
      channelId: event.channelId,
      data: event.data,
    };
    return JSON.stringify(frame);
  }

  /** Whether this person may be told of the event, as they are now. */
  private async mayHear(
    event: ChatEvent,
    peer: Peer,
    channel: Channel | null | undefined,
  ): Promise<boolean> {
    if (event.userId) return event.userId === peer.id;
    if (!event.channelId) return true;
    if (!channel) return false;
    const person = await this.core.access.person(peer.id);
    return canOpen(person, channel);
  }

  private live(peer: Peer): boolean {
    if (this.now() < peer.exp) return true;
    peer.close(CLOSE_EXPIRED, "Your sign-in ran out");
    return false;
  }

  private async deliver(event: ChatEvent): Promise<void> {
    const peers = this.peers();
    if (peers.length === 0) return;
    const channel = event.channelId
      ? await this.core.store.get<Channel>(SHARED_OWNER, "channels", event.channelId)
      : null;
    const text = this.frame(event);
    for (const peer of peers) {
      if (!this.live(peer)) continue;
      if (await this.mayHear(event, peer, channel)) peer.send(text);
    }
  }

  /** Someone has connected, having seen events up to `cursor`: send what they missed, or say it is too much to send. */
  async hello(peer: Peer, cursor: number): Promise<void> {
    const latest = this.core.events.latest();
    if (!this.core.events.covers(cursor)) {
      const frame: ChatFrame = { t: "resync", cursor: latest };
      peer.send(JSON.stringify(frame));
      return;
    }
    const channels = new Map<string, Channel | null>();
    for (const event of this.core.events.since(cursor)) {
      let channel: Channel | null | undefined;
      if (event.channelId) {
        if (!channels.has(event.channelId))
          channels.set(
            event.channelId,
            await this.core.store.get<Channel>(SHARED_OWNER, "channels", event.channelId),
          );
        channel = channels.get(event.channelId);
      }
      if (await this.mayHear(event, peer, channel)) peer.send(this.frame(event));
    }
    const ready: ChatFrame = { t: "ready", cursor: latest };
    peer.send(JSON.stringify(ready));
  }

  /** What a connected person sent. A frame that is not understood is ignored. */
  async receive(peer: Peer, text: string): Promise<void> {
    if (!this.live(peer)) return;
    let frame: ChatClientFrame;
    try {
      frame = JSON.parse(text) as ChatClientFrame;
    } catch {
      return;
    }
    if (frame.t === "hello" && Number.isFinite(frame.cursor)) return this.hello(peer, frame.cursor);
    if (frame.t === "typing" && typeof frame.channelId === "string")
      return this.typingIn(peer, frame.channelId);
  }

  /** Someone is typing: the others in the channel are shown it for a moment. It is never written down. */
  private async typingIn(peer: Peer, channelId: string): Promise<void> {
    const at = this.now();
    const key = `${peer.id}:${channelId}`;
    if (at - (this.typing.get(key) ?? 0) < TYPING_GAP_MS) return;
    const channel = await this.core.store.get<Channel>(SHARED_OWNER, "channels", channelId);
    const person = await this.core.access.person(peer.id);
    if (!channel || !person || channel.status === "archived" || !isIn(person, channel)) return;
    if (this.typing.size > 5_000) this.typing.clear();
    this.typing.set(key, at);
    const text = JSON.stringify({
      t: "typing",
      channelId,
      userId: peer.id,
      name: person.name || person.email,
    } satisfies ChatFrame);
    for (const other of this.peers()) {
      if (other.id === peer.id || !this.live(other)) continue;
      if (canOpen(await this.core.access.person(other.id), channel)) other.send(text);
    }
  }
}
