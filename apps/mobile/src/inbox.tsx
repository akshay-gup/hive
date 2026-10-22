import { BellOff, Check, Mail, Trash2 } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import type { AgentNotification } from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { authorTint } from "./channel-message";
import {
  groupByDay,
  type NoticeTab,
  noticeAction,
  noticeFrom,
  noticesFor,
  noticeTabs,
  unreadCounts,
} from "./notice-text";
import { useMuseThread } from "./threads";
import {
  Button,
  Card,
  colors,
  Empty,
  ErrorNotice,
  fontSize,
  IconButton,
  Mascot,
  radius,
  relativeDate,
  Segmented,
  s,
  timeLabel,
  type WebPressState,
} from "./ui";
import { useWorkspace } from "./workspace";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Who a notice is from: a person's initial in their own tint, or the bee for what the agents did. */
function From({ note, size = 34 }: { note: AgentNotification; size?: number }) {
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

/** One notice in the list: who, what, a line of it, and when. An unread one has a dot and a bold title. */
function Row({
  note,
  selected,
  onPress,
  onToggle,
}: {
  note: AgentNotification;
  selected: boolean;
  onPress: () => void;
  /** Without it (on a phone) the row is only the notice; what to do with it is one tap away. */
  onToggle?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${note.read ? "" : "Unread: "}${note.title}`}
      onPress={onPress}
      style={({ pressed, hovered }: WebPressState) => [
        s.row,
        {
          gap: 12,
          alignItems: "flex-start",
          paddingVertical: 12,
          paddingHorizontal: 12,
          borderRadius: radius.lg,
          backgroundColor: selected
            ? colors.primarySoft
            : pressed || hovered
              ? colors.surfaceHover
              : "transparent",
        },
      ]}
    >
      <View style={{ width: 8, paddingTop: 13 }}>
        {!note.read && (
          <View
            accessibilityLabel="Unread"
            style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary }}
          />
        )}
      </View>
      <From note={note} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={[s.text, { fontWeight: note.read ? "400" : "700" }]} numberOfLines={2}>
          {note.title}
        </Text>
        {!!note.body && (
          <Text style={s.muted} numberOfLines={2}>
            {note.body}
          </Text>
        )}
        <Text style={s.small}>{relativeDate(note.createdAt)}</Text>
      </View>
      {onToggle && (
        <IconButton
          icon={note.read ? Mail : Check}
          label={note.read ? "Mark as unread" : "Mark as read"}
          onPress={onToggle}
        />
      )}
    </Pressable>
  );
}

/**
 * What a notice says in full, and what to do with it: go where it points, mark it read or unread,
 * or put it away. Beside the list on a wide window; a phone goes straight to where it points.
 */
function Detail({
  note,
  busy,
  onOpen,
  onToggle,
  onDismiss,
}: {
  note: AgentNotification;
  busy: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onDismiss: () => void;
}) {
  const action = noticeAction(note);
  return (
    <Card style={{ gap: 16 }}>
      <View style={[s.row, { gap: 12, alignItems: "flex-start" }]}>
        <From note={note} size={40} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={s.heading}>{note.title}</Text>
          <Text style={s.small}>
            {new Date(note.createdAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}{" "}
            · {timeLabel(note.createdAt)}
          </Text>
        </View>
      </View>
      {!!note.body && (
        <View
          style={{
            borderLeftWidth: 3,
            borderLeftColor: colors.lineStrong,
            paddingLeft: 14,
            paddingVertical: 2,
          }}
        >
          <Text selectable style={[s.text, { lineHeight: 22 }]}>
            {note.body}
          </Text>
        </View>
      )}
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        {!!action && (
          <Button primary small busy={busy} onPress={onOpen}>
            {action}
          </Button>
        )}
        <Button small icon={note.read ? Mail : Check} onPress={onToggle}>
          {note.read ? "Mark as unread" : "Mark as read"}
        </Button>
        <Button small icon={Trash2} onPress={onDismiss}>
          Dismiss
        </Button>
      </View>
    </Card>
  );
}

/**
 * The notices that are the person's own: what their agents did, who named them, and what the
 * workspace has to say. Tabs by kind with what is unread in each, grouped by day, and a pane beside
 * the list to read one and act on it.
 */
export function InboxScreen() {
  const { data, mutate } = useAgentWorkspace();
  const { navigate, open } = useWorkspace();
  const { select } = useMuseThread();
  const { width } = useWindowDimensions();
  const split = width >= 1000;
  const [tab, setTab] = useState<NoticeTab>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const all = data?.notifications ?? [];
  const shown = useMemo(() => noticesFor(all, tab, unreadOnly), [all, tab, unreadOnly]);
  const groups = useMemo(() => groupByDay(shown), [shown]);
  const counts = useMemo(() => unreadCounts(all), [all]);
  const note = shown.find((n) => n.id === chosen) ?? (split ? shown[0] : undefined);
  // Opening one on a wide window marks it read, as opening a message does.
  const noteId = note?.id;
  const noteRead = note?.read;
  useEffect(() => {
    if (split && noteId && noteId === chosen && noteRead === false)
      void mutate(`/notifications/${noteId}/read`, {}).catch(() => undefined);
  }, [split, noteId, chosen, noteRead, mutate]);

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
  const toggle = (n: AgentNotification) =>
    run(n.id, `/notifications/${n.id}/${n.read ? "unread" : "read"}`);
  async function go(n: AgentNotification) {
    if (!n.read) await run(n.id, `/notifications/${n.id}/read`);
    if (n.taskId) open({ type: "task", taskId: n.taskId });
    else if (n.channelId) {
      navigate("chat");
      select({ id: `channel:${n.channelId}`, existing: true });
    }
  }

  return (
    <View style={{ gap: 16 }}>
      {/* On a wide window the tabs and the buttons share a line; on a phone the tabs are one row, the actions another. */}
      <View style={split ? [s.between, { gap: 12 }] : { gap: 8 }}>
        {/* The tabs are as wide as their names, so on a phone they slide sideways. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={split ? { flexGrow: 0 } : { alignSelf: "stretch", flexGrow: 0 }}
        >
          <Segmented
            label="Kind of notification"
            value={tab}
            onChange={setTab}
            options={noticeTabs.map((t) => {
              // A phone has no room for the long names, so "My agents" is "Agents" there.
              const name = split ? t.label : t.id === "agent" ? "Agents" : t.label;
              return {
                id: t.id,
                label: counts[t.id] ? `${name} ${counts[t.id]}` : name,
                accessibilityLabel: counts[t.id] ? `${t.label}, ${counts[t.id]} unread` : t.label,
              };
            })}
          />
        </ScrollView>
        {split ? (
          <View style={[s.row, { gap: 8 }]}>
            <Button small primary={unreadOnly} onPress={() => setUnreadOnly((on) => !on)}>
              Unread only
            </Button>
            <Button
              small
              icon={Check}
              disabled={!counts.all}
              busy={busy === "all"}
              onPress={() => void run("all", "/notifications/read-all")}
            >
              Mark all as read
            </Button>
            <Button
              small
              icon={Trash2}
              disabled={!all.length}
              busy={busy === "clear"}
              onPress={() => void run("clear", "/notifications/dismiss-all")}
            >
              Clear all
            </Button>
          </View>
        ) : (
          <View style={[s.between, { gap: 8 }]}>
            <Button small primary={unreadOnly} onPress={() => setUnreadOnly((on) => !on)}>
              Unread only
            </Button>
            <View style={[s.row, { gap: 4 }]}>
              <IconButton
                icon={Check}
                label="Mark all as read"
                onPress={() => void run("all", "/notifications/read-all")}
              />
              <IconButton
                icon={Trash2}
                label="Clear all"
                onPress={() => void run("clear", "/notifications/dismiss-all")}
              />
            </View>
          </View>
        )}
      </View>
      <ErrorNotice error={error} />
      {!shown.length ? (
        <Empty
          icon={BellOff}
          title={unreadOnly || all.length ? "You're all caught up" : "Nothing here yet"}
          detail={
            all.length
              ? unreadOnly
                ? "Nothing is waiting for you in this tab."
                : "Nothing of this kind yet."
              : "What your agents finish, and where people mention you, will show up here."
          }
        >
          {unreadOnly && (
            <Button small onPress={() => setUnreadOnly(false)}>
              Show all
            </Button>
          )}
        </Empty>
      ) : (
        <View style={[s.row, { alignItems: "flex-start", gap: 20 }]}>
          <View
            style={
              split
                ? { flexGrow: 0, flexShrink: 0, width: 440, gap: 4 }
                : { flex: 1, minWidth: 0, gap: 4 }
            }
          >
            {groups.map((group) => (
              <View key={group.label} style={{ gap: 2, marginBottom: 12 }}>
                <Text style={[s.label, { paddingHorizontal: 12, paddingBottom: 4 }]}>
                  {group.label}
                </Text>
                {group.notes.map((n) => (
                  <Row
                    key={n.id}
                    note={n}
                    selected={split && note?.id === n.id}
                    onToggle={split ? () => void toggle(n) : undefined}
                    onPress={() => (split ? setChosen(n.id) : void go(n))}
                  />
                ))}
              </View>
            ))}
          </View>
          {split && note && (
            <View style={{ flex: 1, minWidth: 0, position: "sticky" as never, top: 0 }}>
              <Detail
                note={note}
                busy={busy === note.id}
                onOpen={() => void go(note)}
                onToggle={() => void toggle(note)}
                onDismiss={() => void run(note.id, `/notifications/${note.id}/dismiss`)}
              />
            </View>
          )}
        </View>
      )}
      {split && (
        <Text style={[s.small, { fontSize: fontSize.caption }]}>
          Only what is yours is here: results of agents you started, and mentions of you.
        </Text>
      )}
    </View>
  );
}
