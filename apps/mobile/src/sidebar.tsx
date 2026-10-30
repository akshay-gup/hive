import Bot from "lucide-react-native/dist/esm/icons/bot";
import ChevronDown from "lucide-react-native/dist/esm/icons/chevron-down";
import Hash from "lucide-react-native/dist/esm/icons/hash";
import Lock from "lucide-react-native/dist/esm/icons/lock";
import LogOut from "lucide-react-native/dist/esm/icons/log-out";
import Monitor from "lucide-react-native/dist/esm/icons/monitor";
import Plus from "lucide-react-native/dist/esm/icons/plus";
import SquarePen from "lucide-react-native/dist/esm/icons/square-pen";
import User from "lucide-react-native/dist/esm/icons/user";
import X from "lucide-react-native/dist/esm/icons/x";
import { useCallback, useEffect, useState } from "react";
import { AppState, Pressable, ScrollView, Text, View } from "react-native";
import type { Section } from "../../../packages/domain/src";
import { type ChannelView, ORCHESTRATOR_CHANNEL_ID } from "../../../packages/domain/src/agent";
import { useGuest } from "./access";
import { ProjectsList } from "./activity-projects";
import { useAgentWorkspace } from "./agent-workspace";
import { rememberChannels } from "./channel-cache";
import { useOnChannelsChanged } from "./channel-events";
import { useHosted } from "./hosted/context";
import { readLastCount, writeLastCount } from "./last-count";
import { guestPlaces, places } from "./places";
import { useMuseThread } from "./threads";
import {
  colors,
  ErrorNotice,
  fontSize,
  glass,
  IconButton,
  layout,
  Mascot,
  panelStyle,
  radius,
  SearchField,
  s,
  useHoverTip,
  type WebPressState,
} from "./ui";
import { useWorkspace } from "./workspace";

/**
 * How a row is laid out, thin, so a long list of channels stays in view. On a wide
 * window a row is 30 px; where it is touched it is 38 px. The icon starts 20 px in on a wide window
 * (the list's 12 plus the row's 8), in line with the header above.
 */
const rowMetrics = (dense: boolean) =>
  dense
    ? { padX: 8, padY: 5, gap: 10, icon: 16, radius: 6 }
    : { padX: 8, padY: 8, gap: 12, icon: 17, radius: 8 };

function SidebarRow({
  icon: Icon,
  label,
  active,
  onPress,
  accessibilityLabel,
  dense,
  unread,
}: {
  icon: typeof Bot;
  label: string;
  active?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  dense?: boolean;
  /** Something was written here that the person has not seen. */
  unread?: boolean;
}) {
  const m = rowMetrics(!!dense);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        unread ? `${accessibilityLabel ?? label}, unread` : (accessibilityLabel ?? label)
      }
      onPress={onPress}
      style={({ pressed, hovered }: WebPressState) => ({
        flexDirection: "row",
        gap: m.gap,
        alignItems: "center",
        paddingVertical: m.padY,
        paddingHorizontal: m.padX,
        minHeight: dense ? undefined : 38,
        borderRadius: m.radius,
        backgroundColor: active
          ? colors.primarySoft
          : hovered || pressed
            ? colors.surfaceHover
            : "transparent",
      })}
    >
      <Icon size={m.icon} strokeWidth={1.75} color={active ? colors.primaryText : colors.muted} />
      <Text
        style={[
          s.text,
          dense && { fontSize: fontSize.ui, lineHeight: 20 },
          { flex: 1, fontWeight: unread ? "700" : "400" },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {unread && (
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary }} />
      )}
    </Pressable>
  );
}

/**
 * The channels the sidebar lists: not the main chat's own, not archived ones, and the ones the
 * person is in. The public channels they are not in are found by browsing.
 */
const isListed = (channel: ChannelView) =>
  channel.id !== ORCHESTRATOR_CHANNEL_ID &&
  channel.kind !== "personal" &&
  channel.status !== "archived" &&
  channel.joined !== false;

/**
 * Room for the channels while they load, as many as there were last time, drawn as rows with a
 * bar for the name. Each is a real row made unseen, so it is exactly as tall as the row that
 * replaces it, and the groups under the channels stay where they are.
 */
function ChannelPlaceholders({ count, dense }: { count: number; dense: boolean }) {
  const m = rowMetrics(dense);
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <View
          // The rows are all alike and never reorder.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
          key={index}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
        >
          <View style={{ opacity: 0 }}>
            <SidebarRow dense={dense} icon={Hash} label="channel" onPress={() => {}} />
          </View>
          <View
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: m.padX + m.icon + m.gap,
              justifyContent: "center",
            }}
          >
            <View
              style={{
                width: index % 2 ? 72 : 104,
                height: 10,
                borderRadius: 5,
                backgroundColor: colors.line,
              }}
            />
          </View>
        </View>
      ))}
    </>
  );
}

/** The width of the strip of icons, and of one icon in it. */
const RAIL_WIDTH = 76;
/** The width of the list beside the strip, which is there while in the conversations. */
const LIST_WIDTH = 256;

/** One place in the strip: its icon, and its name under it, so no one has to guess what an icon is. */
function RailItem({
  icon: Icon,
  label,
  active,
  onPress,
  accessibilityLabel,
}: {
  icon: typeof Bot;
  label: string;
  active?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      style={{ width: RAIL_WIDTH - 4, alignItems: "center", gap: 3, paddingVertical: 4 }}
    >
      {(state) => {
        const { pressed, hovered } = state as WebPressState;
        return (
          <>
            {active && (
              <View
                style={{
                  position: "absolute",
                  left: -2,
                  top: 10,
                  width: 3,
                  height: 32,
                  borderTopRightRadius: 2,
                  borderBottomRightRadius: 2,
                  backgroundColor: colors.primary,
                }}
              />
            )}
            <View
              style={{
                width: 44,
                height: 32,
                borderRadius: radius.md,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor:
                  !active && (pressed || hovered) ? colors.surfaceMuted : "transparent",
              }}
            >
              <Icon size={19} strokeWidth={1.8} color={active ? colors.text : colors.muted} />
            </View>
            <Text
              style={{
                fontSize: fontSize.micro,
                lineHeight: 14,
                fontWeight: active ? "600" : "500",
                color: active ? colors.text : colors.muted,
              }}
              numberOfLines={1}
            >
              {label}
            </Text>
          </>
        );
      }}
    </Pressable>
  );
}

/**
 * Persistent conversation sidebar, rendered on desktop widths.
 * The orchestrator is a single tab (no threads); channels open
 * directly as chat surfaces — no thread needed. Threads auto-create from
 * replies and @hive mentions. The menu sheet remains the navigation on
 * narrow screens.
 *
 * On a wide window it is two parts: a thin strip of icons for the places in the
 * workspace, and, only while in the conversations, a list of them (the agent and the channels).
 * Elsewhere the list steps aside and the screen has its room. Where it is touched it is one list
 * in a drawer, with the places in it and the person at the foot. It says as little as it can: no
 * section titles for what is plain, no subtitles, no email.
 */
export function Sidebar({
  compact = false,
  onNavigate,
}: {
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const { api, open, section, navigate, workspace, logout } = useWorkspace();
  const hosted = useHosted();
  const guest = useGuest();
  // A guest has the conversations in their channels, and no other place in the workspace.
  const reachable = guest ? guestPlaces : places;
  const { selection, select } = useMuseThread();
  const { data } = useAgentWorkspace();
  // Each workspace remembers how many channels it had, to hold room for them while they load.
  const channelsKey = `channels:${hosted?.workspace.id ?? "local"}`;
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  // The agent's row is the person's own conversation, a channel of one the chat service keeps.
  const personal = channels?.find((channel) => channel.kind === "personal");
  // The channel of the selected chat is the one highlighted in the list.
  const activeChannelId = selection.id.startsWith("channel:")
    ? selection.id.slice("channel:".length)
    : selection.id === "local"
      ? (personal?.id ?? null)
      : null;

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [find, setFind] = useState("");
  // Whether there is anyone but the person in the workspace to send a message to.
  const [hasOthers, setHasOthers] = useState(false);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) {
        setError("");
        setLoading(true);
      }
      try {
        const loaded = await api.request<ChannelView[]>("/api/agent/channels");
        rememberChannels(api.baseUrl, loaded);
        setChannels(loaded);
        writeLastCount(channelsKey, loaded.filter(isListed).length);
        if (hosted && !guest)
          void api
            .request<{ you?: boolean }[]>("/api/agent/dms/people")
            .then((people) => setHasOthers(people.some((person) => !person.you)))
            .catch(() => undefined);
      } catch (e) {
        // Coming back to the app and finding no network is not worth a message here.
        if (!quiet) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [api, channelsKey, hosted, guest],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // A channel made, joined or left, or someone put in it, is seen in the list at once.
  useOnChannelsChanged(() => void load(true));
  // A channel is read while it is open: tell the workspace, and drop the mark at once.
  useEffect(() => {
    if (section !== "chat" || !activeChannelId) return;
    if (!channels?.some((channel) => channel.id === activeChannelId && channel.unread)) return;
    setChannels((all) =>
      (all ?? []).map((channel) =>
        channel.id === activeChannelId ? { ...channel, unread: false } : channel,
      ),
    );
    void api
      .request(`/api/agent/channels/${encodeURIComponent(activeChannelId)}/read`, {})
      .catch(() => undefined);
  }, [api, section, activeChannelId, channels]);
  // What others write while the app is open shows in the list within the minute.
  useEffect(() => {
    const timer = setInterval(() => void load(true), 30_000);
    return () => clearInterval(timer);
  }, [load]);
  // There is no refresh button: the list is fetched again when the person comes back to the app.
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void load(true);
    });
    return () => listener.remove();
  }, [load]);

  const isMainActive = selection.id === "local";
  const mainSelection = { id: "local", existing: false };

  function go(destination: Section) {
    navigate(destination);
    onNavigate?.();
  }
  function conversation(next: { id: string; existing: boolean }) {
    select(next);
    onNavigate?.();
  }
  // "Find a conversation" narrows the list to the names that hold what was typed.
  const needle = find.trim().toLowerCase();
  const agentName = data?.identity.name || "Hive";
  const showAgent = !guest && (!needle || agentName.toLowerCase().includes(needle));
  const listedMatching = (channels ?? [])
    .filter(isListed)
    .filter((channel) => !needle || channel.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
  const userChannels = listedMatching.filter((channel) => channel.kind !== "dm");
  // A note to oneself is only offered where there is someone else to message too.
  const directMessages = listedMatching.filter(
    (channel) => channel.kind === "dm" && (hasOthers || (channel.members ?? []).length > 1),
  );
  // Searching finds the public channels the person is not in as well: opening one
  // shows it with a Join button.
  const unjoined = needle
    ? (channels ?? [])
        .filter(
          (channel) =>
            channel.id !== ORCHESTRATOR_CHANNEL_ID &&
            channel.status !== "archived" &&
            channel.joined === false &&
            channel.visibility !== "private" &&
            channel.name.toLowerCase().includes(needle),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  const newChannelTip = useHoverTip("New channel");
  const newMessageTip = useHoverTip("New message");
  const dense = !compact;
  const personName = workspace.profile.name || "You";
  const initial = personName.slice(0, 1).toUpperCase();
  const delegate = () => {
    onNavigate?.();
    open({ type: "delegate" });
  };
  const openComputer = () => {
    onNavigate?.();
    open({ type: "computer" });
  };
  const openPeople = () => {
    onNavigate?.();
    open({ type: "people" });
  };
  const openAccount = () => {
    onNavigate?.();
    open({ type: "account" });
  };
  const signOut = () => {
    void logout().catch((e) => setError(String(e)));
  };

  // The workspace's name. A hosted person has one workspace: it is the way to the people in it.
  // The drawer has no strip above it, so there it carries the bee too.
  const title = hosted ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${hosted.workspace.name}: people`}
      onPress={openPeople}
      style={({ pressed, hovered }: WebPressState) => [
        s.row,
        {
          flexShrink: 1,
          minWidth: 0,
          gap: 8,
          paddingVertical: 6,
          paddingHorizontal: 6,
          marginLeft: -6,
          borderRadius: radius.md,
          backgroundColor: pressed || hovered ? colors.surfaceHover : "transparent",
        },
      ]}
    >
      {compact && <Mascot size={24} variant={data?.identity.avatar} />}
      <Text style={[s.heading, { flexShrink: 1 }]} numberOfLines={1}>
        {hosted.workspace.name}
      </Text>
      <ChevronDown size={14} color={colors.muted} />
    </Pressable>
  ) : (
    <>
      {compact && <Mascot size={24} variant={data?.identity.avatar} />}
      <Text style={[s.heading, { flexShrink: 1 }]} numberOfLines={1}>
        {data?.identity.name || "Hive"}
      </Text>
    </>
  );

  // Above the list, so finding a conversation is the first thing to hand.
  const search = (
    <SearchField
      slim
      label="Find a conversation"
      placeholder="Find a conversation…"
      value={find}
      onChangeText={setFind}
    />
  );

  // The conversations: the agent, then the channels with a plus to add one.
  const conversations = (
    <>
      {showAgent && (
        <SidebarRow
          dense={dense}
          icon={Bot}
          label={agentName}
          unread={!!personal?.unread && !(section === "chat" && isMainActive)}
          active={section === "chat" && isMainActive}
          onPress={() => conversation(mainSelection)}
        />
      )}
      <View
        style={[
          s.row,
          { marginTop: guest || !showAgent ? 0 : 16, marginBottom: 2, paddingLeft: 8 },
        ]}
      >
        <Text
          style={[
            s.text,
            { flex: 1, fontSize: fontSize.ui, fontWeight: "500", color: colors.muted },
          ]}
        >
          Channels
        </Text>
        {!guest && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New channel"
            hitSlop={6}
            onPress={() => {
              onNavigate?.();
              open({ type: "newChannel" });
            }}
            {...newChannelTip.props}
            style={({ pressed, hovered }: WebPressState) => ({
              width: 28,
              height: 28,
              borderRadius: radius.sm,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed || hovered ? colors.surfaceHover : "transparent",
            })}
          >
            <Plus size={16} strokeWidth={1.75} color={colors.muted} />
            {newChannelTip.tip}
          </Pressable>
        )}
      </View>
      <ErrorNotice error={error} />
      {!!error && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try loading the channels again"
          onPress={() => void load()}
          style={{ paddingHorizontal: 8, paddingVertical: 6, alignSelf: "flex-start" }}
        >
          <Text style={[s.small, { color: colors.primaryText }]}>Try again</Text>
        </Pressable>
      )}
      {loading && !channels ? (
        <ChannelPlaceholders count={readLastCount(channelsKey)} dense={dense} />
      ) : (
        userChannels.map((channel) => (
          <SidebarRow
            dense={dense}
            key={channel.id}
            icon={channel.visibility === "private" ? Lock : Hash}
            label={channel.name}
            accessibilityLabel={`Open channel: ${channel.name}`}
            unread={channel.unread && activeChannelId !== channel.id}
            active={section === "chat" && !isMainActive && activeChannelId === channel.id}
            onPress={() => conversation({ id: `channel:${channel.id}`, existing: true })}
          />
        ))
      )}
      {unjoined.length > 0 && (
        <>
          <Text style={[s.small, { paddingHorizontal: 8, paddingTop: 10, paddingBottom: 2 }]}>
            Not joined
          </Text>
          {unjoined.map((channel) => (
            <SidebarRow
              dense={dense}
              key={channel.id}
              icon={Hash}
              label={channel.name}
              accessibilityLabel={`Look at channel: ${channel.name}`}
              active={section === "chat" && activeChannelId === channel.id}
              onPress={() => conversation({ id: `channel:${channel.id}`, existing: true })}
            />
          ))}
        </>
      )}
      {/* Direct messages are the team's, so they are where people are known, and not a guest's. */}
      {hosted &&
        !guest &&
        (hasOthers || directMessages.length > 0) &&
        (!needle || directMessages.length > 0) && (
          <>
            <View style={[s.row, { marginTop: 16, marginBottom: 2, paddingLeft: 8 }]}>
              <Text
                style={[
                  s.text,
                  { flex: 1, fontSize: fontSize.ui, fontWeight: "500", color: colors.muted },
                ]}
              >
                Direct messages
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="New message"
                hitSlop={6}
                onPress={() => {
                  onNavigate?.();
                  open({ type: "newMessage" });
                }}
                {...newMessageTip.props}
                style={({ pressed, hovered }: WebPressState) => ({
                  width: 28,
                  height: 28,
                  borderRadius: radius.sm,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed || hovered ? colors.surfaceHover : "transparent",
                })}
              >
                <Plus size={16} strokeWidth={1.75} color={colors.muted} />
                {newMessageTip.tip}
              </Pressable>
            </View>
            {directMessages.map((channel) => (
              <SidebarRow
                dense={dense}
                key={channel.id}
                icon={User}
                label={channel.name}
                accessibilityLabel={`Open direct message: ${channel.name}`}
                unread={channel.unread && activeChannelId !== channel.id}
                active={section === "chat" && !isMainActive && activeChannelId === channel.id}
                onPress={() => conversation({ id: `channel:${channel.id}`, existing: true })}
              />
            ))}
          </>
        )}
      {!!needle &&
        !loading &&
        userChannels.length === 0 &&
        directMessages.length === 0 &&
        unjoined.length === 0 &&
        !showAgent && (
          <Text style={[s.small, { paddingHorizontal: 8, paddingVertical: 6 }]}>
            No conversation by that name.
          </Text>
        )}
    </>
  );

  if (!compact) {
    // Apps is also where mail and the browser are reached from, so it stays lit in them.
    const lit = (id: Section) =>
      id === "apps" ? ["apps", "mail", "browser"].includes(section) : section === id;
    // Two children of the shell's row, not one: the shell puts a gap between its children, and the
    // strip takes back its share of it, so the first panel after the strip is the same distance
    // from it on every page (a list beside it in the conversations, the screen itself elsewhere).
    return (
      <>
        <View style={{ width: RAIL_WIDTH, alignItems: "center" }}>
          <View style={{ height: layout.headerHeight, justifyContent: "center" }}>
            {hosted ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${hosted.workspace.name}: people`}
                hitSlop={6}
                onPress={openPeople}
              >
                <Mascot size={34} variant={data?.identity.avatar} />
              </Pressable>
            ) : (
              <Mascot size={34} variant={data?.identity.avatar} />
            )}
          </View>
          <ScrollView
            style={{ flex: 1, width: "100%" }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ alignItems: "center", paddingTop: 6, gap: 4 }}
          >
            {reachable.map((item) => (
              <RailItem
                key={item.id}
                icon={item.icon}
                label={item.label}
                active={lit(item.id)}
                onPress={() => go(item.id)}
              />
            ))}
          </ScrollView>
          <View style={{ alignItems: "center", gap: 4, paddingBottom: 12 }}>
            {!guest && (
              <>
                <RailItem
                  icon={SquarePen}
                  label="Delegate"
                  onPress={delegate}
                  accessibilityLabel="Delegate task"
                />
                <RailItem
                  icon={Monitor}
                  label="Computer"
                  onPress={openComputer}
                  accessibilityLabel="Agent computer"
                />
              </>
            )}
            {hosted ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Account: ${personName}`}
                hitSlop={4}
                onPress={openAccount}
                style={{ paddingVertical: 6 }}
              >
                {({ pressed, hovered }: WebPressState) => (
                  <View
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 17,
                      backgroundColor: pressed || hovered ? colors.primaryPressed : colors.primary,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text
                      style={[
                        s.text,
                        { fontWeight: "600", fontSize: fontSize.ui, color: colors.onPrimary },
                      ]}
                    >
                      {initial}
                    </Text>
                  </View>
                )}
              </Pressable>
            ) : (
              <RailItem icon={LogOut} label="Log out" onPress={signOut} />
            )}
          </View>
        </View>
        {/* Kept mounted while out of the conversations, so it is as it was when they come back. */}
        <View
          style={[
            { width: LIST_WIDTH },
            panelStyle,
            { backgroundColor: glass.sidebar },
            section !== "chat" && section !== "activity" && { display: "none" },
          ]}
        >
          <View
            style={[
              s.row,
              {
                paddingHorizontal: 20,
                height: layout.headerHeight,
                gap: 8,
              },
            ]}
          >
            {section === "activity" ? <Text style={s.heading}>Activity</Text> : title}
          </View>
          {section !== "activity" && (
            <View style={{ paddingHorizontal: 12, paddingBottom: 4 }}>{search}</View>
          )}
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 1 }}
          >
            {section === "activity" ? <ProjectsList /> : conversations}
          </ScrollView>
        </View>
      </>
    );
  }

  const person = (
    <>
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: radius.md,
          backgroundColor: colors.primarySoft,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{initial}</Text>
      </View>
      <Text
        style={[s.text, { fontSize: fontSize.ui, lineHeight: 20, flex: 1, minWidth: 0 }]}
        numberOfLines={1}
      >
        {personName}
      </Text>
    </>
  );

  return (
    <View style={{ flex: 1, width: "100%" }}>
      <View
        style={[
          s.row,
          {
            paddingHorizontal: 16,
            height: layout.headerHeight,
            gap: 8,
          },
        ]}
      >
        {title}
        <View style={{ flex: 1 }} />
        {!guest && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delegate task"
            hitSlop={6}
            onPress={delegate}
            style={({ pressed, hovered }: WebPressState) => ({
              width: 32,
              height: 32,
              borderRadius: radius.md,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed || hovered ? colors.surfaceHover : "transparent",
            })}
          >
            <SquarePen size={17} color={colors.muted} />
          </Pressable>
        )}
        <IconButton icon={X} label="Close navigation" onPress={() => onNavigate?.()} />
      </View>
      {section !== "activity" && (
        <View style={{ paddingHorizontal: 12, paddingBottom: 4 }}>{search}</View>
      )}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 8, gap: 1 }}
      >
        {section === "activity" ? <ProjectsList onPick={() => onNavigate?.()} /> : conversations}
        {!guest && (
          <>
            <View style={[s.divider, { marginVertical: 8, marginHorizontal: 8 }]} />
            {reachable
              .filter((item) => !item.bar)
              .map((item) => (
                <SidebarRow
                  dense={dense}
                  key={item.id}
                  icon={item.icon}
                  label={item.label}
                  active={section === item.id}
                  onPress={() => go(item.id)}
                />
              ))}
            <SidebarRow
              dense={dense}
              icon={Monitor}
              label="Computer"
              accessibilityLabel="Agent computer"
              onPress={openComputer}
            />
          </>
        )}
      </ScrollView>
      <View style={{ borderTopWidth: 1, borderTopColor: colors.line, padding: 8 }}>
        {hosted ? (
          // Who they are, and what is theirs to do with the account, are in the account.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Account: ${personName}`}
            onPress={openAccount}
            style={({ pressed, hovered }: WebPressState) => [
              s.row,
              {
                gap: 10,
                paddingVertical: 6,
                paddingHorizontal: 8,
                borderRadius: radius.md,
                backgroundColor: pressed || hovered ? colors.surfaceHover : "transparent",
              },
            ]}
          >
            {person}
          </Pressable>
        ) : (
          <View style={[s.row, { gap: 10, paddingVertical: 6, paddingHorizontal: 8 }]}>
            {person}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Log out"
              hitSlop={8}
              onPress={signOut}
              style={{ padding: 4 }}
            >
              <LogOut size={16} color={colors.muted} />
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}
