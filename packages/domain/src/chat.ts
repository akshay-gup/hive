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
  /** The message it is about; with the kind, what makes it one notice. */
  id: string;
  kind: "mention" | "reply";
  channelId: string;
  channelName: string;
  by: string;
  byName: string;
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
  /** What the app missed is too old to send: fetch the lists afresh. */
  | { t: "resync"; cursor: number };

/** What the app says over its connection. */
export type ChatClientFrame = { t: "hello"; cursor: number } | { t: "typing"; channelId: string };
