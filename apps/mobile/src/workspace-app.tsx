import { Check, X } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Section, Workspace } from "../../../packages/domain/src";
import { AgentActivityScreen, AgentStatus, AppsScreen, GoalsScreen, IdeasScreen } from "./agent-ui";
import { AgentWorkspaceProvider } from "./agent-workspace";
import type { MuseApi } from "./api";
import { ChatScreen, WorkspaceTools } from "./chat";
import { ComputerDraftProvider } from "./computer-drafts";
import { Details } from "./details";
import { ProgressScreen } from "./hosted/progress";
import { places } from "./places";
import { BrowserScreen, CalendarScreen, FilesScreen, MailScreen } from "./screens";
import { ShellHeader } from "./shell-header";
import { Sidebar } from "./sidebar";
import { ThreadsProvider, useMuseThread } from "./threads";
import {
  Backdrop,
  Button,
  colors,
  ErrorNotice,
  fontSize,
  GlassBar,
  glassSurface,
  haze,
  layout,
  Mascot,
  panelStyle,
  radius,
  s,
} from "./ui";
import { type Detail, useWorkspace, WorkspaceContext } from "./workspace";

/** What the bar along the bottom of a phone holds: the places that have room in it. */
const nav = places.filter((place) => place.bar);
/**
 * A workspace once the person is in it. `identity` is who they are here and stays the same when
 * their session is renewed, so what they were doing is kept.
 */
export function WorkspaceApp({
  api,
  identity,
  logout,
}: {
  api: MuseApi;
  identity: string;
  logout: () => Promise<void>;
}) {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [section, setSection] = useState<Section>("chat");
  const [detail, setDetail] = useState<Detail>();
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState<{ id: number; text: string }>();
  const refresh = useCallback(async () => {
    const snapshot = await api.request<Workspace>("/api/workspace");
    setWorkspace(snapshot);
    setError("");
  }, [api]);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [refresh]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh().catch((e) => setError(String(e)));
    });
    return () => listener.remove();
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5500);
    return () => clearTimeout(timer);
  }, [toast]);
  const navigate = useCallback(
    (next: Section) =>
      setSection(next === "today" ? "chat" : next === "connections" ? "apps" : next),
    [],
  );
  const open = useCallback((next: Detail) => setDetail(next), []);
  const close = useCallback(() => setDetail(undefined), []);
  const ask = useCallback((text: string) => {
    setPrompt({ id: Date.now(), text });
    setSection("chat");
  }, []);
  // While it loads it is the same screen as "Opening <workspace>…" that comes just before it, in the
  // same place at the same size, so one turns into the other without anything moving.
  if (!workspace && !error) return <ProgressScreen moving title="Opening your workspace…" />;
  if (!workspace)
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: haze.base,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 18,
        }}
      >
        <Backdrop />
        <Mascot size={56} />
        <ErrorNotice error={error} />
        <Button onPress={() => void refresh().catch((e) => setError(String(e)))}>Try again</Button>
      </SafeAreaView>
    );
  return (
    <WorkspaceContext.Provider
      value={{
        workspace,
        api,
        section,
        navigate,
        refresh,
        open,
        close,
        notify: setToast,
        ask,
        logout,
      }}
    >
      <AgentWorkspaceProvider>
        <ComputerDraftProvider key={identity}>
          <ThreadsProvider>
            <WorkspaceShell
              detail={detail}
              toast={toast}
              clearToast={() => setToast("")}
              error={error}
              prompt={prompt}
            />
          </ThreadsProvider>
        </ComputerDraftProvider>
      </AgentWorkspaceProvider>
    </WorkspaceContext.Provider>
  );
}
function WorkspaceShell({
  detail,
  toast,
  clearToast,
  error,
  prompt,
}: {
  detail?: Detail;
  toast: string;
  clearToast: () => void;
  error: string;
  prompt?: { id: number; text: string };
}) {
  const { section, navigate } = useWorkspace();
  const {
    selection,
    visited,
    mainId,
    loading: threadsLoading,
    error: threadsError,
    retry: retryThreads,
    enabled: richThreads,
  } = useMuseThread();
  const [threadsOpen, setThreadsOpen] = useState(false);
  const { width } = useWindowDimensions();
  const desktop = width >= 900;
  const channelChat = section === "chat" && selection.id.startsWith("channel:");
  // On a wide window a channel draws its own panels, with the header inside the first.
  const ownPanels = desktop && channelChat;
  const channelHeader = desktop ? <ShellHeader onMenu={() => setThreadsOpen(true)} /> : undefined;
  const Screen =
    section === "mail"
      ? MailScreen
      : section === "calendar"
        ? CalendarScreen
        : section === "browser"
          ? BrowserScreen
          : section === "files"
            ? FilesScreen
            : section === "activity"
              ? AgentActivityScreen
              : section === "ideas"
                ? IdeasScreen
                : section === "goals"
                  ? GoalsScreen
                  : AppsScreen;
  const utility = ["mail", "calendar", "browser", "files"].includes(section);
  return (
    <>
      <WorkspaceTools />
      <SafeAreaView style={{ flex: 1, backgroundColor: haze.base }} edges={["top", "bottom"]}>
        <Backdrop />
        <View
          style={{
            flex: 1,
            flexDirection: desktop ? "row" : "column",
          }}
        >
          {desktop && <Sidebar />}
          <View style={[{ flex: 1, minWidth: 0 }, desktop && !ownPanels && panelStyle]}>
            {!ownPanels && <ShellHeader onMenu={() => setThreadsOpen(true)} />}
            <View style={{ flex: 1, minHeight: 0 }}>
              {section !== "chat" && (
                <ScrollView
                  key={section}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={{
                    paddingHorizontal: desktop ? 32 : 22,
                    paddingTop: 20,
                    paddingBottom: 28,
                    width: "100%",
                    maxWidth: 1040,
                    alignSelf: "center",
                  }}
                  keyboardShouldPersistTaps="handled"
                >
                  {utility && (
                    <Button
                      small
                      style={{ alignSelf: "flex-start", marginBottom: 18 }}
                      onPress={() => navigate("apps")}
                    >
                      Back to Apps
                    </Button>
                  )}
                  <ErrorNotice error={error} />
                  <Screen />
                </ScrollView>
              )}
              <View
                style={{
                  display: section === "chat" ? "flex" : "none",
                  flex: 1,
                  width: "100%",
                  maxWidth: channelChat ? undefined : 820,
                  alignSelf: "center",
                  paddingHorizontal: channelChat ? 0 : desktop ? 32 : 17,
                  paddingTop: channelChat ? 0 : 8,
                  paddingBottom: desktop && !ownPanels ? 12 : 0,
                }}
              >
                {!channelChat && <AgentStatus />}
                {richThreads ? (
                  <>
                    <ErrorNotice error={threadsError} />
                    {threadsError ? (
                      <Button onPress={retryThreads}>Retry main chat</Button>
                    ) : threadsLoading ? (
                      // Over the middle of the chat, out of the flow, so it moves nothing when it goes.
                      <View
                        pointerEvents="none"
                        style={{
                          position: "absolute",
                          top: 0,
                          bottom: 0,
                          left: 0,
                          right: 0,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <ActivityIndicator color={colors.primary} />
                      </View>
                    ) : null}
                    {!threadsLoading && selection.id !== mainId && (
                      <Text style={[s.small, { textAlign: "center", marginBottom: 8 }]}>
                        Side chat
                      </Text>
                    )}
                    {visited.map((thread) => (
                      <View
                        key={thread.id}
                        style={{ display: selection.id === thread.id ? "flex" : "none", flex: 1 }}
                      >
                        <ChatScreen
                          thread={thread}
                          active={section === "chat" && selection.id === thread.id}
                          prompt={selection.id === thread.id ? prompt : undefined}
                          header={thread.id.startsWith("channel:") ? channelHeader : undefined}
                        />
                      </View>
                    ))}
                  </>
                ) : (
                  <>
                    {visited
                      .filter((thread) => thread.id !== "local")
                      .map((thread) => (
                        <View
                          key={thread.id}
                          style={{
                            display: selection.id === thread.id ? "flex" : "none",
                            flex: 1,
                          }}
                        >
                          <ChatScreen
                            thread={thread}
                            active={section === "chat" && selection.id === thread.id}
                            prompt={selection.id === thread.id ? prompt : undefined}
                            header={thread.id.startsWith("channel:") ? channelHeader : undefined}
                          />
                        </View>
                      ))}
                    <View
                      style={{
                        display: selection.id === "local" ? "flex" : "none",
                        flex: 1,
                      }}
                    >
                      <ChatScreen
                        prompt={selection.id === "local" ? prompt : undefined}
                        active={section === "chat" && selection.id === "local"}
                      />
                    </View>
                  </>
                )}
              </View>
            </View>
            <View
              style={{
                display: desktop ? "none" : "flex",
                paddingHorizontal: 22,
                paddingTop: 6,
                paddingBottom: desktop ? 22 : 7,
                alignItems: "center",
              }}
            >
              <GlassBar
                kind="bar"
                accessibilityRole="tablist"
                style={{
                  flexDirection: "row",
                  width: "100%",
                  maxWidth: 370,
                  padding: 5,
                  borderRadius: radius.pill,
                }}
              >
                {nav.map((item) => {
                  const active = section === item.id || (item.id === "apps" && utility);
                  return (
                    <Pressable
                      key={item.id}
                      accessibilityRole="tab"
                      accessibilityLabel={item.label}
                      accessibilityState={{ selected: active }}
                      onPress={() => navigate(item.id)}
                      style={{
                        flex: 1,
                        height: 54,
                        gap: 3,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: active ? colors.primarySoft : "transparent",
                        borderRadius: radius.pill,
                      }}
                    >
                      <item.icon
                        size={21}
                        strokeWidth={active ? 2 : 1.8}
                        color={active ? colors.primary : colors.muted}
                      />
                      <Text
                        numberOfLines={1}
                        style={{
                          fontSize: fontSize.micro,
                          lineHeight: 12,
                          fontWeight: active ? "700" : "500",
                          color: active ? colors.text : colors.muted,
                        }}
                      >
                        {item.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </GlassBar>
            </View>
          </View>
        </View>
        {!!toast && (
          <View
            pointerEvents="box-none"
            accessibilityLiveRegion="polite"
            accessibilityRole="alert"
            style={{
              position: "absolute",
              bottom: desktop ? 28 : 94,
              left: 20,
              right: 20,
              alignItems: "center",
            }}
          >
            <View
              style={[
                s.row,
                {
                  gap: 10,
                  padding: 14,
                  backgroundColor: colors.inverse,
                  borderRadius: radius.lg,
                  maxWidth: 560,
                },
              ]}
            >
              <Check size={16} color={colors.onInverse} />
              <Text style={{ color: colors.onInverse, fontSize: fontSize.small, flexShrink: 1 }}>
                {toast}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dismiss notification"
                hitSlop={12}
                onPress={clearToast}
              >
                <X size={16} color={colors.onInverse} />
              </Pressable>
            </View>
          </View>
        )}
        <Modal
          visible={threadsOpen && !desktop}
          transparent
          animationType="fade"
          onRequestClose={() => setThreadsOpen(false)}
        >
          <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.scrim }}>
            <SafeAreaView style={{ width: 310, maxWidth: "86%", ...glassSurface("sheet") }}>
              <Sidebar compact onNavigate={() => setThreadsOpen(false)} />
            </SafeAreaView>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close workspace navigation"
              onPress={() => setThreadsOpen(false)}
              style={{ flex: 1 }}
            />
          </View>
        </Modal>
        {detail && (
          <Details
            key={
              detail.type === "task"
                ? detail.taskId
                : detail.type === "channelFiles"
                  ? `files:${detail.channelId}:${detail.path ?? ""}`
                  : detail.type === "channelFile"
                    ? `file:${detail.channelId}:${detail.path}`
                    : detail.type === "file"
                      ? detail.file.id
                      : detail.type === "browser"
                        ? detail.browser.id
                        : detail.type === "mail"
                          ? detail.mail.id
                          : detail.type === "review"
                            ? detail.action.id
                            : detail.type === "email"
                              ? JSON.stringify(detail.draft)
                              : detail.type === "event"
                                ? detail.event?.id || "event-new"
                                : detail.type
            }
            detail={detail}
          />
        )}
      </SafeAreaView>
    </>
  );
}
