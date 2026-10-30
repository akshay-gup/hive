import Hash from "lucide-react-native/dist/esm/icons/hash";
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
import { useGuest } from "./access";
import { ActivityProjectsProvider } from "./activity-projects";
import {
  AgentActivityScreen,
  AgentStatus,
  AppsScreen,
  GoalsScreen,
  IdeasScreen,
  RoutinesScreen,
} from "./agent-ui";
import { AgentWorkspaceProvider } from "./agent-workspace";
import type { MuseApi } from "./api";
import { useBrowserBack } from "./browser-history";
import { ChannelChat } from "./channel-chat";
import { ChatProvider } from "./chat-context";
import { ComputerDraftProvider } from "./computer-drafts";
import { Details } from "./details";
import { useHosted } from "./hosted/context";
import { ProgressScreen } from "./hosted/progress";
import { InboxScreen } from "./inbox";
import { guestPlaces, places } from "./places";
import { BrowserScreen, CalendarScreen, FilesScreen, MailScreen } from "./screens";
import { ShellHeader } from "./shell-header";
import { Sidebar } from "./sidebar";
import { ThreadsProvider, useMuseThread } from "./threads";
import { ToastBubble, ToastContext } from "./toast";
import {
  Backdrop,
  Button,
  colors,
  Empty,
  ErrorNotice,
  fontSize,
  GlassBar,
  glassSurface,
  haze,
  Mascot,
  panelStyle,
  radius,
  s,
} from "./ui";
import { useKeyboardOpen } from "./use-keyboard-open";
import { usePersonalChannel } from "./use-personal-channel";
import { type Detail, type ToastOptions, useWorkspace, WorkspaceContext } from "./workspace";

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
  const [toast, setToast] = useState<(ToastOptions & { text: string }) | null>(null);
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
    // One that offers to be tried again waits longer for it.
    const timer = setTimeout(() => setToast(null), toast.retry ? 12000 : 5500);
    return () => clearTimeout(timer);
  }, [toast]);
  const navigate = useCallback(
    (next: Section) =>
      setSection(next === "today" ? "chat" : next === "connections" ? "apps" : next),
    [],
  );
  const open = useCallback((next: Detail) => setDetail(next), []);
  const close = useCallback(() => setDetail(undefined), []);
  useBrowserBack({
    section,
    hasDetail: !!detail,
    goTo: (place) => setSection(place as Section),
    closeDetail: close,
  });
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
        notify: (text, options) => setToast(text ? { text, ...options } : null),
        ask,
        logout,
      }}
    >
      <ToastContext.Provider value={{ toast, clear: () => setToast(null) }}>
        <ChatProvider>
          <AgentWorkspaceProvider>
            <ActivityProjectsProvider>
              <ComputerDraftProvider key={identity}>
                <ThreadsProvider>
                  <WorkspaceShell
                    detail={detail}
                    toast={toast}
                    clearToast={() => setToast(null)}
                    error={error}
                    prompt={prompt}
                  />
                </ThreadsProvider>
              </ComputerDraftProvider>
            </ActivityProjectsProvider>
          </AgentWorkspaceProvider>
        </ChatProvider>
      </ToastContext.Provider>
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
  toast: (ToastOptions & { text: string }) | null;
  clearToast: () => void;
  error: string;
  prompt?: { id: number; text: string };
}) {
  const { section, navigate } = useWorkspace();
  const guest = useGuest();
  const {
    selection,
    visited,
    loading: threadsLoading,
    error: threadsError,
    empty: noChannels,
    retry: retryThreads,
  } = useMuseThread();
  /** What the bar along the bottom of a phone holds: the places that have room in it. */
  const nav = (guest ? guestPlaces : places).filter((place) => place.bar);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const { width } = useWindowDimensions();
  const desktop = width >= 900;
  // The bar along the bottom steps aside while typing, so the keyboard does not leave it floating above.
  const typing = useKeyboardOpen();
  const hosted = useHosted();
  const personalId = usePersonalChannel(!guest);
  const channelChat =
    section === "chat" && (selection.id.startsWith("channel:") || (!guest && !!personalId));
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
              : section === "inbox"
                ? InboxScreen
                : section === "ideas"
                  ? IdeasScreen
                  : section === "goals"
                    ? GoalsScreen
                    : section === "routines"
                      ? RoutinesScreen
                      : AppsScreen;
  const utility = ["mail", "calendar", "browser", "files"].includes(section);
  // How wide a page may grow. Activity is columns and rows of work, so it uses the window, up to a
  // width a list and a feed still read well at; the pages of forms and settings read better in a
  // narrower column.
  const pageWidth = section === "activity" ? 1400 : section === "inbox" ? 1180 : 1040;
  return (
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
                  maxWidth: pageWidth,
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
              {(!channelChat || selection.id === "local") && !guest && <AgentStatus />}
              {guest && noChannels && (
                <Empty
                  icon={Hash}
                  title="No channels yet"
                  detail="You have not been added to a channel. Ask whoever invited you to add you to one."
                />
              )}
              {guest && (
                <>
                  <ErrorNotice error={threadsError} />
                  {threadsError ? (
                    <Button onPress={retryThreads}>Retry</Button>
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
                </>
              )}
              {visited
                .filter((thread) => thread.id.startsWith("channel:"))
                .map((thread) => (
                  <View
                    key={thread.id}
                    style={{
                      display: selection.id === thread.id ? "flex" : "none",
                      flex: 1,
                    }}
                  >
                    <ChannelChat
                      channelId={thread.id.slice("channel:".length)}
                      active={section === "chat" && selection.id === thread.id}
                      header={channelHeader}
                    />
                  </View>
                ))}
              {!guest && (
                <View
                  style={{
                    display: selection.id === "local" ? "flex" : "none",
                    flex: 1,
                  }}
                >
                  {personalId ? (
                    <ChannelChat
                      channelId={personalId}
                      active={section === "chat" && selection.id === "local"}
                      header={channelHeader}
                      prompt={selection.id === "local" ? prompt : undefined}
                    />
                  ) : hosted ? (
                    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                      <ActivityIndicator color={colors.primary} />
                    </View>
                  ) : (
                    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                      <Text style={[s.muted, { textAlign: "center", maxWidth: 360 }]}>
                        Chat is kept by Hive's chat service, so it is only here in a hosted
                        workspace.
                      </Text>
                    </View>
                  )}
                </View>
              )}
            </View>
          </View>
          <View
            style={{
              display: desktop || typing ? "none" : "flex",
              paddingHorizontal: 14,
              paddingTop: 4,
              paddingBottom: desktop ? 22 : 6,
              alignItems: "center",
            }}
          >
            <GlassBar
              kind="bar"
              accessibilityRole="tablist"
              style={{
                flexDirection: "row",
                width: "100%",
                maxWidth: 400,
                padding: 4,
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
                    aria-selected={active}
                    onPress={() => navigate(item.id)}
                    style={{
                      flex: 1,
                      height: 46,
                      gap: 2,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: active ? colors.primarySoft : "transparent",
                      borderRadius: radius.pill,
                    }}
                  >
                    <item.icon
                      size={20}
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
      {toast && (
        <ToastBubble toast={toast} clear={clearToast} place={{ bottom: desktop ? 28 : 80 }} />
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
  );
}
