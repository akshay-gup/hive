import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, Platform } from "react-native";
import type {
  AgentMachineView,
  AgentNotification,
  AgentTask,
  AgentWorkspace,
  CreateTaskInput,
  Goal,
  Idea,
  Project,
  Routine,
} from "../../../packages/domain/src/agent";
import type { ChatNotice } from "../../../packages/domain/src/chat";
import { useChat } from "./chat-context";
import { useWorkspace } from "./workspace";

/** A notice from the chat service in the shape the notification screens already show. */
const asNotification = (notice: ChatNotice): AgentNotification => ({
  id: notice.id,
  taskId: notice.taskId,
  channelId: notice.channelId,
  by: notice.by,
  byName: notice.byName,
  title: notice.title,
  body: notice.body,
  createdAt: notice.createdAt,
  read: notice.read,
});

/** What the machine tells of the agent while the board, which the chat service keeps, comes separately. */
type Machine = Omit<AgentMachineView, "notifications">;
/** What there is to show of the agent before the machine has answered, or while it is asleep. */
const NO_MACHINE: Machine = {
  ideas: [],
  artifacts: [],
  identity: { name: "Hive", tone: "warm" },
  worker: { running: false },
};

/** How long the board is trusted to be as last read, with nothing from the chat service saying otherwise. */
const BOARD_RECHECK_MS = 30_000;

interface AgentContextValue {
  data?: AgentWorkspace;
  error: string;
  refresh: () => Promise<void>;
  mutate: <T>(path: string, body: unknown) => Promise<T>;
  delegate: (input: CreateTaskInput) => Promise<AgentTask>;
}
const AgentContext = createContext<AgentContextValue | null>(null);
export function AgentWorkspaceProvider({ children }: { children: ReactNode }) {
  const { api } = useWorkspace();
  const [data, setData] = useState<AgentWorkspace>();
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const chat = useChat();
  // The last the machine said, shown while it is asleep.
  const machine = useRef<Machine>(NO_MACHINE);
  // The board as last read, and when: it is read again when the chat service says it changed, after what this
  // person does, and now and then in case a message was missed.
  const board = useRef<
    | {
        tasks: AgentTask[];
        projects: Project[];
        goals: Goal[];
        routines: Routine[];
        ideas: Idea[];
        at: number;
      }
    | undefined
  >(undefined);
  const readBoard = useCallback(
    () =>
      api
        .request<{
          tasks: AgentTask[];
          projects: Project[];
          goals: Goal[];
          routines: Routine[];
          ideas: Idea[];
        }>("/chat/v1/work")
        .then((read) => {
          board.current = { ...read, at: Date.now() };
          return board.current;
        }),
    [api],
  );
  const refresh = useCallback(
    async (options: { board?: boolean } = {}) => {
      const version = ++requestVersion.current;
      try {
        const [shown, rest, notices] = await Promise.all([
          // The board is the chat service's, so it is there while the machine sleeps.
          options.board === false && board.current ? board.current : readBoard(),
          api
            .request<AgentMachineView>("/api/agent")
            .then(({ notifications: _notifications, ...kept }) => {
              machine.current = kept;
              return kept;
            })
            .catch(() => ({ ...machine.current, worker: { running: false } })),
          // All notices are kept by the chat service, including connection failures from the machine.
          api.chat
            ? api.request<ChatNotice[]>("/chat/v1/notifications").catch(() => [] as ChatNotice[])
            : Promise.resolve([] as ChatNotice[]),
        ]);
        if (version === requestVersion.current) {
          const next: AgentWorkspace = {
            ...rest,
            tasks: shown.tasks,
            projects: shown.projects,
            goals: shown.goals,
            routines: shown.routines,
            ideas: shown.ideas,
            notifications: notices.map(asNotification),
          };
          setData(next);
          setError("");
        }
      } catch (e) {
        if (version === requestVersion.current)
          setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [api, readBoard],
  );
  useEffect(() => {
    const visible = () =>
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive" &&
      (Platform.OS !== "web" || typeof document === "undefined" || !document.hidden);
    let polling = false;
    const poll = () => {
      if (!visible() || polling) return;
      polling = true;
      // The chat service says when the board changes; it is read in between only in case a message was missed.
      const stale = !board.current || Date.now() - board.current.at > BOARD_RECHECK_MS;
      void refresh({ board: stale })
        .catch(() => {})
        .finally(() => {
          polling = false;
        });
    };
    poll();
    const timer = setInterval(poll, 3000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") poll();
    });
    if (Platform.OS === "web" && typeof document !== "undefined")
      document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(timer);
      subscription.remove();
      requestVersion.current++;
      if (Platform.OS === "web" && typeof document !== "undefined")
        document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);
  // A notice, a mention or a reply, that just arrived shows at once; so does a change to the board.
  const boardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () =>
      chat.subscribe((frame) => {
        if (frame.t !== "event") return;
        if (frame.type.startsWith("notification.")) void refresh().catch(() => {});
        else if (
          frame.type === "task.changed" ||
          frame.type === "project.changed" ||
          frame.type === "entry.changed"
        ) {
          // Many changes arrive together while a task works: the board is read once for them.
          if (boardTimer.current) return;
          boardTimer.current = setTimeout(() => {
            boardTimer.current = null;
            readBoard()
              .then((read) => setData((prev) => (prev ? { ...prev, ...read } : prev)))
              .catch(() => undefined);
          }, 250);
        }
      }),
    [chat.subscribe, refresh, readBoard],
  );
  useEffect(
    () => () => {
      if (boardTimer.current) clearTimeout(boardTimer.current);
    },
    [],
  );
  const mutate = useCallback(
    async <T,>(path: string, body: unknown): Promise<T> => {
      const result = await api.request<T>(
        path.startsWith("/notifications/") ? `/chat/v1${path}` : `/api/agent${path}`,
        body,
      );
      // The successful mutation stays successful even if the following read fails.
      await refresh().catch(() => {});
      return result;
    },
    [api, refresh],
  );
  const delegate = useCallback(
    (input: CreateTaskInput) => mutate<AgentTask>("/tasks", input),
    [mutate],
  );
  return (
    <AgentContext.Provider value={{ data, error, refresh, mutate, delegate }}>
      {children}
    </AgentContext.Provider>
  );
}
export function useAgentWorkspace() {
  const context = useContext(AgentContext);
  if (!context) throw new Error("Agent workspace is unavailable");
  return context;
}
