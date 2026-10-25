import type { ChatMessage, ChatReaction } from "../../../packages/domain/src/chat";

/** A message as the screen holds it: what the service said, or one that is still being sent. */
export interface FeedMessage extends ChatMessage {
  /** It has not come back from the service yet. */
  pending?: boolean;
  /** Sending it did not work; it stays so it can be sent again. */
  failed?: boolean;
}

export interface Feed {
  messages: FeedMessage[];
  /** There are older ones than these to ask for. */
  more: boolean;
}

export const emptyFeed: Feed = { messages: [], more: false };

/** What a feed shows: a channel's own messages, or the replies in one thread. */
export type Scope = { kind: "channel"; channelId: string } | { kind: "thread"; root: string };

const inScope = (scope: Scope, message: Pick<ChatMessage, "channelId" | "threadRoot">) =>
  scope.kind === "channel"
    ? message.channelId === scope.channelId && message.threadRoot === null
    : message.threadRoot === scope.root;

/** Messages in the order they were written: the ones from the service by their place, then the ones still being sent. */
function ordered(messages: FeedMessage[]): FeedMessage[] {
  return [...messages].sort((a, b) => {
    if (!!a.pending !== !!b.pending) return a.pending ? 1 : -1;
    return a.pending ? a.createdAt.localeCompare(b.createdAt) : a.seq - b.seq;
  });
}

/** Put a message from the service in: it replaces the one it already was, or the one that was sent for it, or is added. */
export function put(feed: Feed, message: ChatMessage): Feed {
  const at = feed.messages.findIndex(
    (m) =>
      m.id === message.id || (m.pending && message.clientId && m.clientId === message.clientId),
  );
  if (at === -1) return { ...feed, messages: ordered([...feed.messages, message]) };
  const next = [...feed.messages];
  next[at] = message;
  return { ...feed, messages: ordered(next) };
}

function change(feed: Feed, id: string, edit: (m: FeedMessage) => FeedMessage | null): Feed {
  const at = feed.messages.findIndex((m) => m.id === id);
  if (at === -1) return feed;
  const next = [...feed.messages];
  const replaced = edit(next[at] as FeedMessage);
  if (replaced) next[at] = replaced;
  else next.splice(at, 1);
  return { ...feed, messages: next };
}

/** What an event from the service does to a feed. An event that is not about it changes nothing. */
export function applyEvent(feed: Feed, scope: Scope, type: string, data: unknown): Feed {
  switch (type) {
    case "message.new":
    case "message.edited": {
      const message = data as ChatMessage;
      return inScope(scope, message) ? put(feed, message) : feed;
    }
    case "thread.updated": {
      // The first message of a thread changed (a reply was added or taken away): its count and faces.
      const root = data as ChatMessage;
      return scope.kind === "channel" && root.channelId === scope.channelId
        ? put(feed, root)
        : feed;
    }
    case "message.deleted": {
      const { id } = data as { id: string; channelId: string; threadRoot: string | null };
      return change(feed, id, (m) =>
        // One that has a thread under it stays as a place for it; any other goes.
        m.replyCount > 0 ? { ...m, body: "", deleted: true, files: [], reactions: [] } : null,
      );
    }
    case "reaction.set": {
      const { messageId, reactions } = data as { messageId: string; reactions: ChatReaction[] };
      return change(feed, messageId, (m) => ({ ...m, reactions }));
    }
    default:
      return feed;
  }
}

/** Whether an agent's message says its run is over. */
const finished = (message: ChatMessage) => {
  const status = (message.extra as { status?: unknown } | undefined)?.status;
  return status === "done" || status === "failed" || status === "stopped";
};

/**
 * An agent's message as it is being written: shown in its place, and not once it has been finished (a
 * stale picture of it must never undo the end). It carries no place of its own to read up to.
 */
export function applyStream(feed: Feed, scope: Scope, message: ChatMessage): Feed {
  if (!inScope(scope, message)) return feed;
  const held = feed.messages.find((m) => m.id === message.id);
  if (held && finished(held)) return feed;
  return put(feed, message);
}

/** A message the person has just sent, shown at once. */
export function sending(feed: Feed, message: FeedMessage): Feed {
  return { ...feed, messages: ordered([...feed.messages, { ...message, pending: true }]) };
}

/** Sending it did not work. */
export function failed(feed: Feed, clientId: string): Feed {
  return {
    ...feed,
    messages: feed.messages.map((m) =>
      m.clientId === clientId && m.pending ? { ...m, failed: true } : m,
    ),
  };
}

/** Sending it again, or giving up on it. */
export function retrying(feed: Feed, clientId: string): Feed {
  return {
    ...feed,
    messages: feed.messages.map((m) => (m.clientId === clientId ? { ...m, failed: false } : m)),
  };
}
export function dropped(feed: Feed, clientId: string): Feed {
  return { ...feed, messages: feed.messages.filter((m) => m.clientId !== clientId || !m.pending) };
}

/** An older page, put before what is held. */
export function older(feed: Feed, page: ChatMessage[], more: boolean): Feed {
  const have = new Set(feed.messages.map((m) => m.id));
  return { messages: ordered([...page.filter((m) => !have.has(m.id)), ...feed.messages]), more };
}

/**
 * The newest page, made the whole of the feed, keeping what is still being sent. Used when the screen
 * opens and when it has missed more than it can catch up on.
 */
export function replaced(feed: Feed, page: ChatMessage[], more: boolean): Feed {
  const stillSending = feed.messages.filter((m) => m.pending);
  const arrived = new Set(page.map((m) => m.clientId).filter(Boolean));
  return {
    messages: ordered([...page, ...stillSending.filter((m) => !arrived.has(m.clientId))]),
    more,
  };
}

/** The place the newest message from the service is at, for saying how far has been read. */
export function newestSeq(feed: Feed): number {
  let seq = 0;
  for (const message of feed.messages) if (!message.pending && message.seq > seq) seq = message.seq;
  return seq;
}

/** Whether a message follows another by the same person closely enough to be shown under it. */
export function continues(previous: FeedMessage | undefined, message: FeedMessage): boolean {
  if (!previous || previous.deleted || message.deleted) return false;
  if (previous.author.id !== message.author.id) return false;
  if (previous.createdAt.slice(0, 10) !== message.createdAt.slice(0, 10)) return false;
  return Date.parse(message.createdAt) - Date.parse(previous.createdAt) < 5 * 60_000;
}
