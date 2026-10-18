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
import { ChannelsSection } from "./channels";
import type { Selection } from "./thread-ids";
import { Button, ErrorNotice, LinkRow, Pending, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

export { resolveThreadId } from "./thread-ids";
export type { Selection };

function newThreadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const ThreadContext = createContext<{
  enabled: boolean;
  selection: Selection;
  visited: Selection[];
  mainId: string;
  loading: boolean;
  error: string;
  retry: () => void;
  select: (selection: Selection) => void;
  start: () => void;
  claimPrompt: (id: number) => boolean;
} | null>(null);
export function ThreadsProvider({ children }: { children: ReactNode }) {
  const { workspace, navigate, api } = useWorkspace();
  const handledPrompt = useRef(0);
  const enabled = workspace.runtime.richThreads === true;
  const [selection, setSelection] = useState<Selection>({ id: "local", existing: false });
  const [visited, setVisited] = useState<Selection[]>([]);
  const [mainId, setMainId] = useState("local");
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<{ threadId: string; existing: boolean }>("/api/main-thread")
      .then((main) => {
        if (!active) return;
        const next = { id: main.threadId, existing: main.existing };
        setMainId(next.id);
        setSelection(next);
        setVisited([next]);
        setLoading(false);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, enabled, attempt]);
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
        enabled,
        mainId,
        visited,
        loading,
        error,
        retry: () => setAttempt((n) => n + 1),
        selection,
        select,
        start: () => select({ id: newThreadId(), existing: false }),
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
  const { enabled, mainId, loading, error: mainError, retry, select, selection } = useMuseThread();
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
        {enabled && loading ? (
          <>
            <ErrorNotice error={mainError} />
            {mainError ? <Button onPress={retry}>Retry main chat</Button> : <Pending height={68} />}
          </>
        ) : enabled ? (
          <LinkRow
            icon={Bot}
            title="Orchestrator"
            detail="Chat with the orchestrator"
            onPress={() => {
              select({ id: mainId, existing: true });
              onClose();
            }}
          />
        ) : (
          <>
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
          </>
        )}
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
            const threadId =
              enabled && !selection.id.startsWith("channel:") ? selection.id : undefined;
            open({ type: "delegate", threadId });
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
