import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatMessagePage, ChatPerson } from "../../../packages/domain/src/chat";
import { useChat } from "./chat-context";
import {
  applyEvent,
  dropped,
  emptyFeed,
  type Feed,
  type FeedMessage,
  failed,
  newestSeq,
  older,
  put,
  replaced,
  retrying,
  type Scope,
  sending,
} from "./chat-feed";
import { useHosted } from "./hosted/context";
import { useWorkspace } from "./workspace";

const enc = encodeURIComponent;
const newClientId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export interface Feeder {
  feed: Feed;
  loading: boolean;
  error: string;
  /** Ask for older messages. */
  loadOlder: () => Promise<void>;
  /** Send something; it shows at once and settles when the service answers. */
  send: (body: string, options?: { fileIds?: string[] }) => Promise<void>;
  /** Send again what did not go. */
  resend: (clientId: string) => Promise<void>;
  /** Give up on what did not go. */
  discard: (clientId: string) => void;
  edit: (id: string, body: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  react: (id: string, emoji: string, on: boolean) => Promise<void>;
}

/**
 * What is said in a channel (or in one thread of it), kept current: the newest messages when it opens,
 * what the service announces as it happens, older ones on request, and what this person sends shown
 * the moment it is sent. While the channel is the one on screen, the person is counted as having read
 * as far as the newest message.
 */
export function useChannelFeed(
  channelId: string,
  options: { root?: string; active?: boolean } = {},
): Feeder {
  const { api } = useWorkspace();
  const chat = useChat();
  const hosted = useHosted();
  const scope: Scope = options.root
    ? { kind: "thread", root: options.root }
    : { kind: "channel", channelId };
  const scopeKey = options.root ? `t:${options.root}` : `c:${channelId}`;
  const [feed, setFeed] = useState<Feed>(emptyFeed);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const sent = useRef(new Map<string, { body: string; fileIds?: string[] }>());
  const me: ChatPerson = {
    id: hosted?.user.id ?? "me",
    name: hosted?.user.name || hosted?.user.email || "You",
    email: hosted?.user.email ?? "",
    kind: "person",
  };

  const load = useCallback(async () => {
    try {
      if (options.root) {
        const body = await api.request<{ root: ChatMessage; replies: ChatMessage[] }>(
          `/chat/v1/messages/${enc(options.root)}/replies?limit=200`,
        );
        setFeed((f) => replaced(f, body.replies, false));
      } else {
        const page = await api.request<ChatMessagePage>(
          `/chat/v1/channels/${enc(channelId)}/messages?limit=50`,
        );
        setFeed((f) => replaced(f, page.messages, page.more));
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, channelId, options.root]);

  // A different channel or thread starts afresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scope's key is what changes
  useEffect(() => {
    setFeed(emptyFeed);
    setLoading(true);
    void load();
  }, [scopeKey, load]);

  // What the service announces.
  useEffect(
    () =>
      chat.subscribe((frame) => {
        if (frame.t === "resync") void load();
        else if (frame.t === "event")
          setFeed((f) => applyEvent(f, scopeRef.current, frame.type, frame.data));
      }),
    [chat.subscribe, load],
  );
  // Back on the network after a break: what came meanwhile is sent on by the service, but a first
  // connection that missed the load is covered by loading again.
  const wasConnected = useRef(chat.connected);
  useEffect(() => {
    if (chat.connected && !wasConnected.current) void load();
    wasConnected.current = chat.connected;
  }, [chat.connected, load]);

  // The person is looking at this channel: it is read as far as the newest message.
  const readTo = useRef(0);
  const seq = newestSeq(feed);
  useEffect(() => {
    if (options.root || !options.active || seq <= readTo.current) return;
    readTo.current = seq;
    void api.request(`/api/agent/channels/${enc(channelId)}/read`, { seq }).catch(() => undefined);
  }, [api, channelId, options.root, options.active, seq]);

  const loadOlder = useCallback(async () => {
    if (options.root) return;
    const first = feed.messages.find((m) => !m.pending);
    if (!first) return;
    const page = await api.request<ChatMessagePage>(
      `/chat/v1/channels/${enc(channelId)}/messages?limit=50&before=${first.seq}`,
    );
    setFeed((f) => older(f, page.messages, page.more));
  }, [api, channelId, options.root, feed.messages]);

  const post = useCallback(
    async (clientId: string) => {
      const what = sent.current.get(clientId);
      if (!what) return;
      try {
        const made = await api.request<ChatMessage>(
          `/chat/v1/channels/${enc(channelId)}/messages`,
          {
            body: what.body,
            clientId,
            ...(options.root ? { threadRoot: options.root } : {}),
            ...(what.fileIds?.length ? { fileIds: what.fileIds } : {}),
          },
        );
        sent.current.delete(clientId);
        setFeed((f) => put(f, made));
      } catch (e) {
        setFeed((f) => failed(f, clientId));
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [api, channelId, options.root],
  );

  const send = useCallback(
    async (body: string, extra: { fileIds?: string[] } = {}) => {
      const text = body.trim();
      if (!text && !extra.fileIds?.length) return;
      const clientId = newClientId();
      sent.current.set(clientId, { body: text, fileIds: extra.fileIds });
      const local: FeedMessage = {
        id: `pending-${clientId}`,
        channelId,
        seq: 0,
        author: me,
        body: text,
        threadRoot: options.root ?? null,
        replyCount: 0,
        lastReplyAt: null,
        replyPeople: [],
        clientId,
        createdAt: new Date().toISOString(),
        editedAt: null,
        deleted: false,
        reactions: [],
        files: [],
      };
      setError("");
      setFeed((f) => sending(f, local));
      await post(clientId);
    },
    // `me` is the same person for as long as this is open.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
    [channelId, options.root, post],
  );

  const resend = useCallback(
    async (clientId: string) => {
      setFeed((f) => retrying(f, clientId));
      await post(clientId);
    },
    [post],
  );
  const discard = useCallback((clientId: string) => {
    sent.current.delete(clientId);
    setFeed((f) => dropped(f, clientId));
  }, []);

  const edit = useCallback(
    async (id: string, body: string) => {
      const made = await api.request<ChatMessage>(
        `/chat/v1/messages/${enc(id)}`,
        { body },
        "PATCH",
      );
      setFeed((f) => put(f, made));
    },
    [api],
  );
  const remove = useCallback(
    async (id: string) => {
      await api.request(`/chat/v1/messages/${enc(id)}`, undefined, "DELETE");
      setFeed((f) =>
        applyEvent(f, scopeRef.current, "message.deleted", {
          id,
          channelId,
          threadRoot: options.root ?? null,
        }),
      );
    },
    [api, channelId, options.root],
  );
  const react = useCallback(
    async (id: string, emoji: string, on: boolean) => {
      const made = await api.request<ChatMessage>(
        `/chat/v1/messages/${enc(id)}/reactions/${enc(emoji)}`,
        undefined,
        on ? "PUT" : "DELETE",
      );
      setFeed((f) => put(f, made));
    },
    [api],
  );

  return { feed, loading, error, loadOlder, send, resend, discard, edit, remove, react };
}
