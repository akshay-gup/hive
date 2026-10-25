import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import type { ChatFrame } from "../../../packages/domain/src/chat";
import { channelsChanged } from "./channel-events";
import { ChatSocket } from "./chat-socket";
import { useWorkspace } from "./workspace";

type Listener = (frame: ChatFrame) => void;

interface ChatValue {
  /** Whether this workspace has a chat service at all. */
  enabled: boolean;
  /** Whether the live connection is up. */
  connected: boolean;
  /** Hear every frame from the service. Returns what stops listening. */
  subscribe: (listener: Listener) => () => void;
  /** Say that this person is typing in a channel. */
  typing: (channelId: string) => void;
  /** Who is typing in a channel now, other than this person. */
  typingIn: (channelId: string) => string[];
}

const ChatContext = createContext<ChatValue>({
  enabled: false,
  connected: false,
  subscribe: () => () => undefined,
  typing: () => undefined,
  typingIn: () => [],
});

/** How long someone is shown to be typing after the last word of it. */
const TYPING_MS = 4_000;
/** What changes which channel is unread, which is worth a fresh look at the list (a moment after the last of a burst). */
const UNREAD_EVENTS = new Set(["message.new", "message.deleted", "read.updated"]);
/** The events that change which channels there are, or who is in them. */
const CHANNEL_EVENTS = new Set([
  "channel.new",
  "channel.updated",
  "channel.removed",
  "member.changed",
]);

/**
 * The live connection to the chat service, kept for as long as the workspace is open. Whatever wants to
 * know what happened (a channel's messages, the list of channels, the notices) listens here.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const { api } = useWorkspace();
  const enabled = !!api.chat;
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());
  const socket = useRef<ChatSocket | null>(null);
  const [tick, setTick] = useState(0);
  const bumped = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typists = useRef(new Map<string, Map<string, { name: string; until: number }>>());

  useEffect(() => {
    if (!api.chat) return;
    const chat = new ChatSocket(
      {
        url: () => api.chat?.wsUrl ?? "",
        token: () => api.chat?.token ?? "",
        // A token that is about to run out is made again before it is used to connect.
        refresh: async () => {
          const connection = api.chat;
          if (connection?.renew && (connection.expiresAt ?? 0) - Date.now() < 30_000)
            await connection.renew();
        },
      },
      (frame) => {
        if (frame.t === "typing") {
          const inChannel = typists.current.get(frame.channelId) ?? new Map();
          inChannel.set(frame.userId, { name: frame.name, until: Date.now() + TYPING_MS });
          typists.current.set(frame.channelId, inChannel);
          setTick((n) => n + 1);
          setTimeout(() => setTick((n) => n + 1), TYPING_MS + 50);
        } else if (frame.t === "resync" || (frame.t === "event" && CHANNEL_EVENTS.has(frame.type)))
          channelsChanged();
        else if (frame.t === "event" && UNREAD_EVENTS.has(frame.type)) {
          clearTimeout(bumped.current);
          bumped.current = setTimeout(channelsChanged, 400);
        }
        for (const listener of listeners.current) listener(frame);
      },
      setConnected,
    );
    socket.current = chat;
    chat.start();
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") chat.nudge();
    });
    return () => {
      clearTimeout(bumped.current);
      app.remove();
      chat.stop();
      socket.current = null;
    };
  }, [api]);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const typing = useCallback(
    (channelId: string) => socket.current?.send({ t: "typing", channelId }),
    [],
  );
  const typingIn = useCallback((channelId: string) => {
    const now = Date.now();
    return [...(typists.current.get(channelId)?.values() ?? [])]
      .filter((who) => who.until > now)
      .map((who) => who.name);
  }, []);
  // `tick` is in the list so what is on screen is drawn again when someone starts or stops typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const value = useMemo(
    () => ({ enabled, connected, subscribe, typing, typingIn }),
    [enabled, connected, subscribe, typing, typingIn, tick],
  );
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export const useChat = () => useContext(ChatContext);
