import { BellOff, Check, Settings, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import type { AgentNotification } from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { authorTint } from "./channel-message";
import {
  groupByDay,
  type NoticeTab,
  noticeFrom,
  noticesFor,
  noticeTabs,
  unreadCounts,
} from "./notice-text";
import { NotificationSettingsSheet } from "./notification-settings";
import { useMuseThread } from "./threads";
import {
  Button,
  colors,
  Empty,
  ErrorNotice,
  fontSize,
  IconButton,
  Mascot,
  radius,
  relativeDate,
  s,
  useOver,
} from "./ui";
import { useWorkspace } from "./workspace";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Who a notice is from: a person's initial in their own tint, or the bee for what the agents did. */
function From({ note, size = 36 }: { note: AgentNotification; size?: number }) {
  const { data } = useAgentWorkspace();
  const from = noticeFrom(note);
  // What no person did is the agent's, or the workspace's: the bee.
  if (!from) return <Mascot size={size} variant={data?.identity.avatar} />;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius.md,
        backgroundColor: authorTint(from),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={[s.text, { fontWeight: "700" }]}>{from.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

/**
 * One notice in the list: who, what, a line of it, and when. An unread one has a dot and a heavier
 * title. Where there is a pointer, hovering swaps the time for what can be done with it (mark it read,
 * put it away); on a phone the row is only the notice, and tapping goes where it points. The buttons
 * sit beside the row's own pressable, not inside it, so reaching for them does not end the hover.
 */
function Row({
  note,
  onPress,
  onRead,
  onDismiss,
}: {
  note: AgentNotification;
  onPress: () => void;
  onRead?: () => void;
  onDismiss?: () => void;
}) {
  const { ref, over } = useOver();
  const actions = over && !!onDismiss;
  return (
    <View ref={ref}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${note.read ? "" : "Unread: "}${note.title}`}
        onPress={onPress}
        style={({ pressed }) => [
          s.row,
          {
            gap: 12,
            alignItems: "flex-start",
            paddingVertical: 12,
            paddingRight: 12,
            paddingLeft: 4,
            borderRadius: radius.lg,
            backgroundColor: pressed || over ? colors.surfaceHover : "transparent",
          },
        ]}
      >
        <View style={{ width: 8, paddingTop: 14 }}>
          {!note.read && (
            <View
              accessibilityLabel="Unread"
              style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary }}
            />
          )}
        </View>
        <From note={note} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text style={[s.text, { fontWeight: note.read ? "500" : "700" }]} numberOfLines={1}>
            {note.title}
          </Text>
          {!!note.body && (
            <Text style={s.muted} numberOfLines={1}>
              {note.body}
            </Text>
          )}
        </View>
        {/* The time keeps its place whether or not the buttons show, so nothing under the pointer moves. */}
        <View style={{ minWidth: onDismiss ? 72 : 0, alignItems: "flex-end" }}>
          <Text style={[s.small, { lineHeight: 20, opacity: actions ? 0 : 1 }]}>
            {relativeDate(note.createdAt)}
          </Text>
        </View>
      </Pressable>
      {actions && (
        <View style={[s.row, { gap: 2, position: "absolute", right: 12, top: 6 }]}>
          {!note.read && onRead && (
            <IconButton icon={Check} label="Mark as read" onPress={onRead} />
          )}
          <IconButton icon={X} label="Dismiss" onPress={onDismiss} />
        </View>
      )}
    </View>
  );
}

/** The kinds, as underlined words with what is unread in each; the agent's tab carries its name. */
function Tabs({
  value,
  onChange,
  counts,
  agentName,
}: {
  value: NoticeTab;
  onChange: (tab: NoticeTab) => void;
  counts: Record<NoticeTab, number>;
  agentName: string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, flexShrink: 1 }}
      contentContainerStyle={{ gap: 22 }}
      accessibilityLabel="Kind of notification"
    >
      {noticeTabs.map((tab) => {
        const on = tab.id === value;
        const name = tab.id === "agent" ? agentName : tab.label;
        const count = counts[tab.id];
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={count ? `${name}, ${count} unread` : name}
            onPress={() => onChange(tab.id)}
            style={[
              s.row,
              {
                gap: 6,
                paddingVertical: 10,
                borderBottomWidth: 2,
                borderBottomColor: on ? colors.primary : "transparent",
              },
            ]}
          >
            <Text
              style={[
                s.text,
                { color: on ? colors.text : colors.muted, fontWeight: on ? "600" : "400" },
              ]}
            >
              {name}
            </Text>
            {count > 0 && (
              <View
                style={{
                  minWidth: 18,
                  height: 18,
                  paddingHorizontal: 5,
                  borderRadius: 9,
                  backgroundColor: colors.primary,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: colors.onPrimary, fontSize: 11, fontWeight: "700" }}>
                  {count}
                </Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * The notices that are the person's own: what the agent answered or finished for them, who named
 * them, and what the workspace has to say. Tabs by kind with what is unread in each, one list grouped
 * by day; a notice opens where it points.
 */
export function InboxScreen() {
  const { data, mutate } = useAgentWorkspace();
  const { navigate, open } = useWorkspace();
  const { select } = useMuseThread();
  const { width } = useWindowDimensions();
  const wide = width >= 700;
  const [tab, setTab] = useState<NoticeTab>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [settings, setSettings] = useState(false);
  const all = data?.notifications ?? [];
  const shown = useMemo(() => noticesFor(all, tab, unreadOnly), [all, tab, unreadOnly]);
  const groups = useMemo(() => groupByDay(shown), [shown]);
  const counts = useMemo(() => unreadCounts(all), [all]);

  async function run(what: string, path: string) {
    setBusy(what);
    setError("");
    try {
      await mutate(path, {});
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  async function go(n: AgentNotification) {
    if (!n.read) await run(n.id, `/notifications/${n.id}/read`);
    if (n.taskId) open({ type: "task", taskId: n.taskId });
    else if (n.channelId) {
      navigate("chat");
      select({ id: `channel:${n.channelId}`, existing: true });
    }
  }

  return (
    <View style={{ gap: 12, width: "100%", maxWidth: 900, alignSelf: "center" }}>
      <View style={[s.between, { gap: 12, borderBottomWidth: 1, borderBottomColor: colors.line }]}>
        <Tabs
          value={tab}
          onChange={setTab}
          counts={counts}
          agentName={data?.identity.name || "Hive"}
        />
        <View style={[s.row, { gap: wide ? 8 : 4 }]}>
          <Button small primary={unreadOnly} onPress={() => setUnreadOnly((on) => !on)}>
            Unread only
          </Button>
          {wide ? (
            <Button
              small
              disabled={!counts.all}
              busy={busy === "all"}
              onPress={() => void run("all", "/notifications/read-all")}
            >
              Mark all read
            </Button>
          ) : (
            <IconButton
              icon={Check}
              label="Mark all as read"
              onPress={() => void run("all", "/notifications/read-all")}
            />
          )}
          <IconButton
            icon={Settings}
            label="Notification settings"
            onPress={() => setSettings(true)}
          />
        </View>
      </View>
      <ErrorNotice error={error} />
      {settings && <NotificationSettingsSheet onClose={() => setSettings(false)} />}
      {!shown.length ? (
        <Empty
          icon={BellOff}
          title={all.length ? "You're all caught up" : "Nothing here yet"}
          detail={
            all.length
              ? unreadOnly
                ? "Nothing is waiting for you in this tab."
                : "Nothing of this kind yet."
              : "What the agent answers or finishes for you, and where people mention you, will show up here."
          }
        />
      ) : (
        groups.map((group) => (
          <View key={group.label} style={{ gap: 2 }}>
            <Text style={[s.label, { paddingHorizontal: 12, paddingVertical: 6 }]}>
              {group.label}
            </Text>
            {group.notes.map((n) => (
              <Row
                key={n.id}
                note={n}
                onPress={() => void go(n)}
                onRead={wide ? () => void run(n.id, `/notifications/${n.id}/read`) : undefined}
                onDismiss={
                  wide ? () => void run(n.id, `/notifications/${n.id}/dismiss`) : undefined
                }
              />
            ))}
          </View>
        ))
      )}
      <Text style={[s.small, { fontSize: fontSize.caption, paddingHorizontal: 12 }]}>
        Only what is yours is here: what the agent answered or finished for you, and mentions of
        you.
      </Text>
    </View>
  );
}
