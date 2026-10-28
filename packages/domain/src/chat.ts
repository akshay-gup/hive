import { z } from "zod";

/**
 * What the chat service says to the app about the people's conversation: messages, reactions, the
 * notices a person is told, and the events that keep a screen current. The chat service and the app
 * both read this, so a change is made once.
 */

export interface ChatPerson {
  id: string;
  name: string;
  email: string;
  /** `person`, or `agent` for what the agent says (not built yet). */
  kind: "person" | "agent" | "system";
}

export interface ChatReaction {
  emoji: string;
  count: number;
  /** The ids of the people who reacted, to show who and to tell which are yours. */
  users: string[];
}

export interface ChatFile {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  /** Whether it has a smaller picture to show in the conversation. */
  thumb: boolean;
  width?: number;
  height?: number;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  /** Its place in the channel: where to page from, and what a read mark points at. */
  seq: number;
  author: ChatPerson;
  /** Empty once deleted. */
  body: string;
  threadRoot: string | null;
  replyCount: number;
  lastReplyAt: string | null;
  /** Who has replied in the thread, for showing them. */
  replyPeople: ChatPerson[];
  /** What the sender called it, so the screen it was sent from knows which message has come back. */
  clientId?: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  reactions: ChatReaction[];
  files: ChatFile[];
  /** What something other than a person adds to a message; the app ignores what it does not know. */
  extra?: unknown;
}

export interface ChatMessagePage {
  messages: ChatMessage[];
  /** There are older messages than these. */
  more: boolean;
}

/** One thing a person is told: a mention, a reply in a thread they are in. */
export interface ChatNotice {
  /** The message it is about, or for a notice of the agent's work its own id; with the kind, what makes it one notice. */
  id: string;
  /** A mention or a reply is about a message; "work" is the agent telling of a task (done, ready for review, needs you). */
  kind: "mention" | "reply" | "work";
  /** The channel it is about: not for a notice of work. */
  channelId?: string;
  channelName?: string;
  by?: string;
  byName?: string;
  /** The task a notice of work is about. */
  taskId?: string;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
}

export const postMessageSchema = z.object({
  body: z.string().max(40_000),
  clientId: z.string().min(1).max(100).optional(),
  threadRoot: z.string().min(1).max(100).nullable().optional(),
  fileIds: z.array(z.string().min(1).max(100)).max(10).optional(),
});
export type PostMessageInput = z.infer<typeof postMessageSchema>;

export const editMessageSchema = z.object({ body: z.string().min(1).max(40_000) });

/** What the app hears over its connection. */
export type ChatFrame =
  | { t: "ready"; cursor: number }
  | { t: "event"; id: number; type: string; channelId: string | null; data: unknown }
  | { t: "typing"; channelId: string; userId: string; name: string }
  /**
   * A message as it is now while the agent writes it, to be shown and not kept: it does not move the number
   * of what was last seen, and the message's own events come when it is finished.
   */
  | { t: "stream"; channelId: string; message: ChatMessage }
  /** What the app missed is too old to send: fetch the lists afresh. */
  | { t: "resync"; cursor: number };

/** What the app says over its connection. */
export type ChatClientFrame = { t: "hello"; cursor: number } | { t: "typing"; channelId: string };
