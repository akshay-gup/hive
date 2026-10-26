import {
  Bot,
  CalendarDays,
  FileText,
  Monitor,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react-native";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { type Channel, ORCHESTRATOR_CHANNEL_ID } from "../../../packages/domain/src/agent";
import { useGuest } from "./access";
import { ChannelsSection } from "./channels";
import type { Selection } from "./thread-ids";
import { Button, ErrorNotice, LinkRow, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

export type { Selection };

const ThreadContext = createContext<{
  selection: Selection;
  visited: Selection[];
  loading: boolean;
  error: string;
  /** A guest who was not added to any channel yet: there is nothing for them to open. */
  empty: boolean;
  retry: () => void;
  select: (selection: Selection) => void;
  /** Back to where a person starts: their own chat, or for a guest the first channel they were added to. */
  home: () => void;
  claimPrompt: (id: number) => boolean;
} | null>(null);
export function ThreadsProvider({ children }: { children: ReactNode }) {
  const { navigate, api } = useWorkspace();
  const handledPrompt = useRef(0);
  const guest = useGuest();
  const [selection, setSelection] = useState<Selection>({ id: "local", existing: false });
  const [visited, setVisited] = useState<Selection[]>([]);
  const [loading, setLoading] = useState(guest);
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!guest) return;
    let active = true;
    setLoading(true);
    setError("");
    setEmpty(false);
    // No main chat to open: a guest starts in the first channel they were added to.
    void api
      .request<Channel[]>("/api/agent/channels")
      .then((channels) => {
        if (!active) return;
        const first = channels
          .filter((c) => c.id !== ORCHESTRATOR_CHANNEL_ID && c.status !== "archived")
          .sort((a, b) => a.name.localeCompare(b.name))[0];
        if (first) {
          const next = { id: `channel:${first.id}`, existing: true };
          setSelection(next);
          setVisited([next]);
        } else setEmpty(true);
        setLoading(false);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, attempt, guest]);
  function select(next: Selection) {
    setSelection(next);
    setVisited((items) => (items.some((item) => item.id === next.id) ? items : [...items, next]));
    navigate("chat");
  }
  return (
    <ThreadContext.Provider
      value={{
        claimPrompt: (id) => {
          if (handledPrompt.current === id) return false;
          handledPrompt.current = id;
          return true;
        },
        visited,
        loading,
        error,
        empty,
        retry: () => setAttempt((n) => n + 1),
        selection,
        select,
        home: () => (guest ? setAttempt((n) => n + 1) : select({ id: "local", existing: false })),
      }}
    >
      {children}
    </ThreadContext.Provider>
  );
}
export function useMuseThread() {
  const context = useContext(ThreadContext);
  if (!context) throw new Error("Threads provider is unavailable");
  return context;
}
export function ThreadsSheet({ onClose }: { onClose: () => void }) {
  const { select } = useMuseThread();
  const { workspace, open, navigate, refresh } = useWorkspace();
  const [error, setError] = useState("");
  async function mutate(action: () => Promise<void>) {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function go(section: "calendar" | "files" | "apps") {
    onClose();
    navigate(section);
  }
  return (
    <Sheet
      title="Hive"
      subtitle={workspace.mode === "sample" ? "Your workspace" : workspace.profile.name}
      onClose={onClose}
      tall
    >
      <View style={{ gap: 14 }}>
        <LinkRow
          icon={Bot}
          title="Orchestrator"
          detail="Saved in this workspace"
          onPress={() => {
            select({ id: "local", existing: false });
            onClose();
          }}
        />
        <Text style={s.muted}>
          Your conversation is saved in this workspace. You can manage connections in Apps.
        </Text>
        <View style={{ marginTop: 12 }}>
          <ChannelsSection onClose={onClose} />
        </View>
        <View style={s.divider} />
        <LinkRow
          icon={Plus}
          title="Delegate task"
          detail="A plan, document, or spending summary"
          onPress={() => {
            onClose();
            open({ type: "delegate" });
          }}
        />
        <LinkRow
          icon={Monitor}
          title="Agent computer"
          detail="Browser, sessions and documents"
          onPress={() => {
            onClose();
            open({ type: "computer" });
          }}
        />
        <LinkRow icon={CalendarDays} title="Calendar" onPress={() => go("calendar")} />
        <LinkRow icon={FileText} title="Files" onPress={() => go("files")} />
        <LinkRow icon={Settings2} title="Apps & settings" onPress={() => go("apps")} />
        <ErrorNotice error={error} />
        <Button small icon={RefreshCw} onPress={() => void mutate(refresh)}>
          Refresh workspace
        </Button>
      </View>
    </Sheet>
  );
}
