import {
  Bot,
  CalendarDays,
  ChevronsUpDown,
  FileText,
  Hash,
  Lightbulb,
  LogOut,
  Monitor,
  PanelsTopLeft,
  Plus,
  RefreshCw,
  Shapes,
  SquareCheck,
  UserRound,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { Section } from "../../../packages/domain/src";
import { type Channel, ORCHESTRATOR_CHANNEL_ID } from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { useHosted } from "./hosted/context";
import { roleLabel } from "./hosted/people-text";
import { readLastCount, writeLastCount } from "./last-count";
import { useMuseThread } from "./threads";
import {
  Button,
  colors,
  ErrorNotice,
  Field,
  fontSize,
  IconButton,
  layout,
  Mascot,
  panelStyle,
  radius,
  s,
  shadow,
  type WebPressState,
} from "./ui";
import { useWorkspace } from "./workspace";

function SidebarRow({
  icon: Icon,
  label,
  active,
  onPress,
  accessibilityLabel,
  dense,
}: {
  icon: typeof Bot;
  label: string;
  active?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  dense?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={({ pressed, hovered }: WebPressState) => ({
        flexDirection: "row",
        gap: dense ? 10 : 12,
        alignItems: "center",
        paddingVertical: dense ? 7 : 12,
        paddingHorizontal: 12,
        borderRadius: dense ? 8 : 12,
        backgroundColor: active || hovered || pressed ? colors.surfaceHover : "transparent",
        ...(active ? { boxShadow: shadow.active } : null),
      })}
    >
      <Icon size={dense ? 16 : 17} color={active ? colors.primaryText : colors.muted} />
      <Text
        style={[
          s.text,
          dense && { fontSize: fontSize.ui, lineHeight: 20 },
          { flex: 1, fontWeight: active ? "600" : "400" },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** The channels the sidebar lists: not the main chat's own, and not archived ones. */
const isListed = (channel: Channel) =>
  channel.id !== ORCHESTRATOR_CHANNEL_ID && channel.status !== "archived";

/**
 * Room for the channels while they load, as many as there were last time, drawn as rows with a
 * bar for the name. Each is a real row made unseen, so it is exactly as tall as the row that
 * replaces it, and the groups under the channels stay where they are.
 */
function ChannelPlaceholders({ count, dense }: { count: number; dense: boolean }) {
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
              left: 12 + (dense ? 16 + 10 : 17 + 12),
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

/**
 * Persistent Slack-style conversation sidebar, rendered on desktop widths.
 * The orchestrator is a single Slackbot-like tab (no threads); channels open
 * directly as chat surfaces — no thread needed. Threads auto-create from
 * replies and @hive mentions. The menu sheet remains the navigation on
 * narrow screens.
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
  const { enabled, selection, select, mainId } = useMuseThread();
  const { data } = useAgentWorkspace();
  // Each workspace remembers how many channels it had, to hold room for them while they load.
  const channelsKey = `channels:${hosted?.workspace.id ?? "local"}`;
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const loaded = await api.request<Channel[]>("/api/agent/channels");
      setChannels(loaded);
      writeLastCount(channelsKey, loaded.filter(isListed).length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, channelsKey]);
  useEffect(() => {
    void load();
  }, [load]);

  const isMainActive = enabled ? selection.id === mainId : selection.id === "local";
  const mainSelection = enabled ? { id: mainId, existing: true } : { id: "local", existing: false };
  const delegateThreadId =
    enabled && !selection.id.startsWith("channel:") ? selection.id : undefined;

  // Highlight the channel of the selected chat: either the channel chat
  // itself or the channel a forked thread belongs to.
  useEffect(() => {
    let active = true;
    if (isMainActive) {
      setActiveChannelId(null);
      return;
    }
    if (selection.id.startsWith("channel:")) {
      setActiveChannelId(selection.id.slice("channel:".length));
      return;
    }
    void api
      .request<{ channelId: string }>(`/api/agent/threads/${selection.id}/channel`)
      .then((binding) => {
        if (active) setActiveChannelId(binding.channelId);
      })
      .catch(() => {
        if (active) setActiveChannelId(null);
      });
    return () => {
      active = false;
    };
  }, [api, isMainActive, selection.id]);

  async function createChannel() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError("");
    try {
      const created = await api.request<Channel>("/api/agent/channels", { name: trimmed });
      setName("");
      setCreating(false);
      await load();
      // A new channel is usable immediately: open it as a chat.
      select({ id: `channel:${created.id}`, existing: true });
      onNavigate?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function go(destination: Section) {
    navigate(destination);
    onNavigate?.();
  }
  function conversation(next: { id: string; existing: boolean }) {
    select(next);
    onNavigate?.();
  }
  const workspaceLinks: { id: Section; label: string; icon: typeof Bot }[] = [
    { id: "activity", label: "Activity", icon: PanelsTopLeft },
    { id: "ideas", label: "Ideas", icon: Lightbulb },
    { id: "goals", label: "Goals", icon: SquareCheck },
    { id: "apps", label: "Apps", icon: Shapes },
    { id: "calendar", label: "Calendar", icon: CalendarDays },
    { id: "files", label: "Files", icon: FileText },
  ];
  const userChannels = (channels ?? [])
    .filter(isListed)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <View style={compact ? { flex: 1, width: "100%" } : [{ width: 260 }, panelStyle]}>
      <View
        style={[
          s.row,
          {
            paddingHorizontal: 16,
            height: layout.headerHeight,
            gap: 10,
            borderBottomWidth: 1,
            borderBottomColor: colors.line,
          },
        ]}
      >
        {hosted ? (
          // A hosted person has workspaces: this one's name, who is in it, and the way to another.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${hosted.workspace.name}: people and workspaces`}
            onPress={() => {
              onNavigate?.();
              open({ type: "people" });
            }}
            style={({ pressed, hovered }: WebPressState) => [
              s.row,
              {
                flex: 1,
                minWidth: 0,
                gap: 10,
                paddingVertical: 6,
                paddingHorizontal: 6,
                marginLeft: -6,
                borderRadius: radius.md,
                backgroundColor: pressed || hovered ? colors.surfaceHover : "transparent",
              },
            ]}
          >
            <Mascot size={28} variant={data?.identity.avatar} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.heading} numberOfLines={1}>
                {hosted.workspace.name}
              </Text>
              <Text style={s.small} numberOfLines={1}>
                {roleLabel[hosted.workspace.role]} · People
              </Text>
            </View>
            <ChevronsUpDown size={16} color={colors.muted} />
          </Pressable>
        ) : (
          <>
            <Mascot size={28} variant={data?.identity.avatar} />
            <View style={{ flex: 1 }}>
              <Text style={s.heading}>{data?.identity.name || "Hive"}</Text>
              <Text style={s.small}>Your workspace</Text>
            </View>
          </>
        )}
        {compact && <IconButton icon={X} label="Close navigation" onPress={() => onNavigate?.()} />}
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10, gap: compact ? 4 : 1 }}
      >
        <Text style={[s.label, { paddingHorizontal: 12, marginBottom: 4 }]}>Direct messages</Text>
        <SidebarRow
          dense={!compact}
          icon={Bot}
          label={data?.identity.name || "Hive"}
          active={section === "chat" && isMainActive}
          onPress={() => conversation(mainSelection)}
        />
        <View
          style={[
            s.row,
            { alignItems: "center", marginTop: 12, marginBottom: 0, paddingHorizontal: 12 },
          ]}
        >
          <Text style={[s.label, { flex: 1 }]}>Channels</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh channels"
            disabled={loading}
            hitSlop={10}
            onPress={() => void load()}
            style={{ padding: 10 }}
          >
            {/* The refresh icon is the spinner while it loads, in the same 14 px, so nothing is added to the page. */}
            <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}>
              {loading ? (
                <ActivityIndicator
                  size="small"
                  color={colors.muted}
                  style={{ transform: [{ scale: 0.7 }] }}
                />
              ) : (
                <RefreshCw size={14} color={colors.muted} />
              )}
            </View>
          </Pressable>
        </View>
        <ErrorNotice error={error} />
        {loading && !channels ? (
          <ChannelPlaceholders count={readLastCount(channelsKey)} dense={!compact} />
        ) : (
          userChannels.map((channel) => (
            <SidebarRow
              dense={!compact}
              key={channel.id}
              icon={Hash}
              label={channel.name}
              accessibilityLabel={`Open channel: ${channel.name}`}
              active={section === "chat" && !isMainActive && activeChannelId === channel.id}
              onPress={() => conversation({ id: `channel:${channel.id}`, existing: true })}
            />
          ))
        )}
        {creating ? (
          <View style={{ gap: 12, paddingHorizontal: 12, marginTop: 8 }}>
            <Field
              label="Channel name"
              compact
              autoFocus
              value={name}
              onChangeText={setName}
              placeholder="e.g. family-trip"
              returnKeyType="done"
              onSubmitEditing={() => void createChannel()}
              onKeyPress={(event) => {
                if (event.nativeEvent.key === "Escape") {
                  setCreating(false);
                  setName("");
                }
              }}
            />
            <View style={[s.row, { gap: 8 }]}>
              <Button
                primary
                small
                disabled={busy || !name.trim()}
                onPress={() => void createChannel()}
              >
                Create
              </Button>
              <Button small disabled={busy} onPress={() => setCreating(false)}>
                Cancel
              </Button>
            </View>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New channel"
            disabled={busy}
            onPress={() => setCreating(true)}
            style={[
              s.row,
              { gap: 10, alignItems: "center", paddingVertical: 12, paddingHorizontal: 12 },
            ]}
          >
            <Plus size={16} color={colors.muted} />
            <Text style={[s.text, { fontSize: fontSize.ui }]}>New channel</Text>
          </Pressable>
        )}
        <View style={[s.divider, { marginVertical: 8 }]} />
        <Text style={[s.label, { paddingHorizontal: 12, marginBottom: 4 }]}>Workspace</Text>
        {workspaceLinks.map((item) => (
          <SidebarRow
            dense={!compact}
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={section === item.id}
            onPress={() => go(item.id)}
          />
        ))}
        <View style={[s.divider, { marginVertical: 8 }]} />
        <SidebarRow
          dense={!compact}
          icon={Plus}
          label="Delegate task"
          onPress={() => {
            onNavigate?.();
            open({ type: "delegate", threadId: delegateThreadId });
          }}
        />
        <SidebarRow
          dense={!compact}
          icon={Monitor}
          label="Agent computer"
          onPress={() => {
            onNavigate?.();
            open({ type: "computer" });
          }}
        />
      </ScrollView>
      <View
        style={[s.row, { borderTopWidth: 1, borderTopColor: colors.line, padding: 12, gap: 12 }]}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: radius.lg,
            backgroundColor: colors.primarySoft,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={[s.text, { fontWeight: "600" }]}>
            {(workspace.profile.name || "You").slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.text, { fontSize: fontSize.ui, fontWeight: "500" }]} numberOfLines={1}>
            {workspace.profile.name || "You"}
          </Text>
          <Text style={s.small} numberOfLines={1}>
            {workspace.profile.email || "Signed in"}
          </Text>
          <View style={[s.row, { gap: 16 }]}>
            {hosted && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Account"
                hitSlop={8}
                onPress={() => {
                  onNavigate?.();
                  open({ type: "account" });
                }}
                style={[s.row, { gap: 6, paddingVertical: 8 }]}
              >
                <UserRound size={14} color={colors.muted} />
                <Text style={s.small}>Account</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Log out"
              hitSlop={8}
              onPress={() => {
                void logout().catch((e) => setError(String(e)));
              }}
              style={[s.row, { gap: 6, paddingVertical: 8 }]}
            >
              <LogOut size={14} color={colors.muted} />
              <Text style={s.small}>Log out</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}
