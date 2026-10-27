import Maximize2 from "lucide-react-native/dist/esm/icons/maximize-2";
import Minimize2 from "lucide-react-native/dist/esm/icons/minimize-2";
import X from "lucide-react-native/dist/esm/icons/x";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ChannelView } from "../../../packages/domain/src/agent";
import type { PromptChoice } from "../../../packages/domain/src/chat-agent";
import { useGuest } from "./access";
import { channelsChanged, useOnChannelsChanged } from "./channel-events";
import { agentOnIn, agentView, asksAgent } from "./chat-agent-extra";
import { ChatComposer } from "./chat-composer";
import { useChat } from "./chat-context";
import { continues, type FeedMessage } from "./chat-feed";
import { ChatMessageRow } from "./chat-message-row";
import { useHosted } from "./hosted/context";
import { MentionNamesProvider, useMentionable } from "./mention-ui";
import PanelResizer from "./PanelResizer";
import {
  clampPanelWidth,
  expandedPanelWidth,
  isExpandedPanel,
  largestPanelWidth,
  PANEL_DEFAULT,
  PANEL_MIN,
  readPanelWidth,
  writePanelWidth,
} from "./panel-width";
import { Backdrop, Button, colors, ErrorNotice, fontSize, haze, panelStyle, s } from "./ui";
import { useChannelFeed } from "./use-channel-feed";
import { useWorkspace } from "./workspace";

const enc = encodeURIComponent;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

/** The channel as this person is shown it: whether they are in it, whether it is read-only, who it is with. */
function useChannelInfo(channelId: string) {
  const { api } = useWorkspace();
  const [channel, setChannel] = useState<ChannelView | null>(null);
  const load = useCallback(async () => {
    try {
      setChannel(await api.request<ChannelView>(`/api/agent/channels/${enc(channelId)}`));
    } catch {
      setChannel(null);
    }
  }, [api, channelId]);
  useEffect(() => {
    void load();
  }, [load]);
  useOnChannelsChanged(() => void load());
  return channel;
}

function DayLabel({ iso }: { iso: string }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: 10 }}>
      <Text style={[s.small, { fontWeight: "600" }]}>{day(iso)}</Text>
    </View>
  );
}

/** The list of messages, in order with the day's name where it changes, kept at the newest unless the person has gone back. */
function MessageList({
  messages,
  me,
  mentions,
  channel,
  openThread,
  threadRoot,
  feeder,
  inThread,
  header,
  empty,
}: {
  messages: FeedMessage[];
  me: string;
  mentions: string[];
  channel: ChannelView | null;
  openThread?: (id: string) => void;
  threadRoot?: string | null;
  feeder: ReturnType<typeof useChannelFeed>;
  inThread?: boolean;
  header?: React.ReactNode;
  empty?: React.ReactNode;
}) {
  const { api, notify } = useWorkspace();
  const guest = useGuest();
  const scroller = useRef<ScrollView>(null);
  const stuck = useRef(true);
  // What can be done about the agent's replies. The service decides who may; this offers what the person can.
  const agent = useMemo(
    () => ({
      canAnswer: !guest,
      answer: async (runId: string, promptId: string, choice: PromptChoice) => {
        await api.request(`/chat/v1/runs/${enc(runId)}/answer`, { promptId, choice });
      },
    }),
    [api, guest],
  );
  const takePart = !!channel && channel.joined !== false && channel.status !== "archived";
  const manager = channel?.manager === true;
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    stuck.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 80;
  };
  return (
    <ScrollView
      ref={scroller}
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingVertical: 8, flexGrow: 1 }}
      onScroll={onScroll}
      scrollEventThrottle={64}
      onContentSizeChange={() => {
        if (stuck.current) scroller.current?.scrollToEnd({ animated: false });
      }}
      keyboardShouldPersistTaps="handled"
    >
      {header}
      {messages.length === 0
        ? empty
        : messages.map((message, index) => {
            const previous = messages[index - 1];
            const newDay = !previous || day(previous.createdAt) !== day(message.createdAt);
            return (
              <View key={message.clientId && message.pending ? message.clientId : message.id}>
                {newDay && <DayLabel iso={message.createdAt} />}
                <ChatMessageRow
                  message={message}
                  me={me}
                  grouped={!newDay && continues(previous, message)}
                  mentions={mentions}
                  canTakePart={takePart}
                  canDelete={message.author.id === me || manager}
                  selected={!inThread && threadRoot === message.id}
                  onReply={inThread || !openThread ? undefined : () => openThread(message.id)}
                  onReact={(emoji, on) =>
                    void feeder
                      .react(message.id, emoji, on)
                      .catch((e) => notify(String(e.message ?? e), { error: true }))
                  }
                  onEdit={(body) => feeder.edit(message.id, body)}
                  onDelete={() =>
                    void feeder
                      .remove(message.id)
                      .catch((e) => notify(String(e.message ?? e), { error: true }))
                  }
                  onResend={() => message.clientId && void feeder.resend(message.clientId)}
                  onDiscard={() => message.clientId && feeder.discard(message.clientId)}
                  onNotify={notify}
                  agent={agent}
                />
              </View>
            );
          })}
    </ScrollView>
  );
}

/** One thread: the message it hangs from, the replies, and a box to reply in. */
function ThreadView({
  channelId,
  root,
  channel,
  me,
  mentions,
  onClose,
  wider,
}: {
  channelId: string;
  root: FeedMessage;
  channel: ChannelView | null;
  me: string;
  mentions: string[];
  onClose: () => void;
  /** On a wide window: whether the panel is at its wide setting, and the button that toggles it. */
  wider?: { on: boolean; toggle: () => void };
}) {
  const feeder = useChannelFeed(channelId, { root: root.id });
  const { api, notify } = useWorkspace();
  const takePart = !!channel && channel.joined !== false && channel.status !== "archived";
  // A run going in this thread that this person may stop (they asked it, or they manage the channel):
  // the box a reply is written in then offers to stop it while nothing is typed.
  const going = feeder.feed.messages
    .map((m) => (m.author.kind === "agent" ? agentView(m.extra) : null))
    .find(
      (view) => view && (view.queued || view.working) && (view.askedBy === me || channel?.manager),
    );
  const stop = going
    ? () =>
        void api
          .request(`/chat/v1/runs/${enc(going.runId)}/stop`, {})
          .catch((e) => notify(e instanceof Error ? e.message : String(e), { error: true }))
    : undefined;
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={[s.between, { paddingBottom: 8 }]}>
        <Text style={s.heading}>Thread</Text>
        <View style={[s.row, { gap: 2 }]}>
          {wider && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={wider.on ? "Make thread narrower" : "Make thread wider"}
              onPress={wider.toggle}
              style={{ padding: 8 }}
            >
              {wider.on ? (
                <Minimize2 size={18} color={colors.muted} />
              ) : (
                <Maximize2 size={18} color={colors.muted} />
              )}
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close thread"
            onPress={onClose}
            style={{ padding: 8 }}
          >
            <X size={18} color={colors.muted} />
          </Pressable>
        </View>
      </View>
      <ErrorNotice error={feeder.error} />
      <MessageList
        inThread
        messages={[root, ...feeder.feed.messages]}
        me={me}
        mentions={mentions}
        channel={channel}
        feeder={feeder}
      />
      {takePart && (
        <ChatComposer
          channelId={channelId}
          draftKey={`thread:${root.id}`}
          placeholder="Reply…"
          agent={!!channel && agentOnIn(channel)}
          onStop={stop}
          onSend={async (body, fileIds) => {
            await feeder.send(body, { fileIds });
          }}
        />
      )}
    </View>
  );
}

/**
 * A channel's conversation, in the chat service: the messages, who is typing, a box to write in, and
 * the threads under them. The agent answers a mention in a thread under the message that asked.
 */
export function ChannelChat({
  channelId,
  active,
  header,
}: {
  channelId: string;
  /** The channel on screen: the one that is read as it is looked at. */
  active: boolean;
  /** The bar a channel carries across the top of its own panel on a wide window. */
  header?: React.ReactNode;
}) {
  const { api, notify } = useWorkspace();
  const hosted = useHosted();
  const chat = useChat();
  const { width } = useWindowDimensions();
  const channel = useChannelInfo(channelId);
  const feeder = useChannelFeed(channelId, { active });
  const people = useMentionable(channelId);
  const mentions = useMemo(() => ["hive", ...people.flatMap((p) => [p.handle, p.email])], [people]);
  const me = hosted?.user.id ?? "";
  const [threadId, setThreadId] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const wide = width >= 900;
  const panels = wide;
  // How wide the thread panel is on a wide window; the width is kept on this device.
  const [rowWidth, setRowWidth] = useState(0);
  const [panelPref, setPanelPref] = useState(PANEL_DEFAULT);
  const widthBeforeExpanding = useRef(PANEL_DEFAULT);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const kept = readPanelWidth();
    if (kept) setPanelPref(kept);
  }, []);
  const room = rowWidth || width;
  const panelWidth = clampPanelWidth(panelPref, room);
  const panelExpanded = isExpandedPanel(panelWidth, room);
  function keepPanelWidth(next: number) {
    const kept = clampPanelWidth(next, room);
    setPanelPref(kept);
    writePanelWidth(kept);
  }
  function togglePanelExpanded() {
    if (!panelExpanded) widthBeforeExpanding.current = panelWidth;
    keepPanelWidth(panelExpanded ? widthBeforeExpanding.current : expandedPanelWidth(room));
  }
  const thread = threadId ? feeder.feed.messages.find((m) => m.id === threadId) : undefined;
  const takePart = !!channel && channel.joined !== false && channel.status !== "archived";
  const typing = chat.typingIn(channelId);
  const direct = channel?.kind === "dm" ? channel.name : null;

  // Another channel closes the thread of this one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the channel is what changes
  useEffect(() => setThreadId(null), [channelId]);

  async function join() {
    setJoining(true);
    try {
      await api.request(`/api/agent/channels/${enc(channelId)}/members`, {
        add: [hosted?.user.email],
      });
      channelsChanged();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), { error: true });
    } finally {
      setJoining(false);
    }
  }

  const empty = feeder.loading ? null : (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 6 }}>
      <Text style={[s.heading, { textAlign: "center" }]}>
        {direct ? direct : channel ? `#${channel.name}` : "Start the conversation"}
      </Text>
      <Text style={[s.muted, { textAlign: "center", maxWidth: 360 }]}>
        {direct
          ? "Only the two of you can see this."
          : "This is the start of the channel. Say something to get it going."}
      </Text>
    </View>
  );

  const body = (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        paddingHorizontal: width >= 900 ? 20 : 16,
        paddingBottom: 16,
      }}
    >
      <ErrorNotice error={feeder.error && feeder.feed.messages.length === 0 ? feeder.error : ""} />
      <MessageList
        messages={feeder.feed.messages}
        me={me}
        mentions={mentions}
        channel={channel}
        openThread={setThreadId}
        threadRoot={threadId}
        feeder={feeder}
        header={
          feeder.feed.more ? (
            <View style={{ alignItems: "center", paddingVertical: 8 }}>
              <Button
                small
                onPress={() =>
                  void feeder
                    .loadOlder()
                    .catch((e) => notify(String(e.message ?? e), { error: true }))
                }
              >
                Show earlier messages
              </Button>
            </View>
          ) : null
        }
        empty={empty}
      />
      <Text
        style={[s.small, { minHeight: 18, paddingHorizontal: 8, paddingBottom: 2 }]}
        numberOfLines={1}
      >
        {typing.length === 1
          ? `${typing[0]} is typing…`
          : typing.length > 1
            ? `${typing.slice(0, 2).join(" and ")}${typing.length > 2 ? " and others" : ""} are typing…`
            : ""}
      </Text>
      {channel?.status === "archived" ? (
        <Text style={[s.muted, { textAlign: "center", paddingVertical: 8 }]}>
          This channel is archived. It is read-only.
        </Text>
      ) : channel && channel.joined === false ? (
        <View style={[s.row, { justifyContent: "center", gap: 12, paddingVertical: 6 }]}>
          <Text style={s.muted}>You are looking at #{channel.name}.</Text>
          <Button small primary busy={joining} onPress={() => void join()}>
            Join channel
          </Button>
        </View>
      ) : (
        <ChatComposer
          channelId={channelId}
          draftKey={`channel:${channelId}`}
          placeholder={
            direct ? `Message ${direct}…` : channel ? `Message #${channel.name}…` : "Message…"
          }
          disabled={!takePart}
          agent={!!channel && agentOnIn(channel)}
          onSend={async (text, fileIds) => {
            const made = await feeder.send(text, { fileIds });
            // The agent answers in a thread under the message that asked: that thread is opened.
            if (made && asksAgent(text)) setThreadId(made.id);
          }}
        />
      )}
    </View>
  );

  const threadView = thread ? (
    <ThreadView
      channelId={channelId}
      root={thread}
      channel={channel}
      me={me}
      mentions={mentions}
      onClose={() => setThreadId(null)}
      wider={width >= 1100 ? { on: panelExpanded, toggle: togglePanelExpanded } : undefined}
    />
  ) : null;

  return (
    <MentionNamesProvider people={people}>
      <View
        style={{ flex: 1, flexDirection: "row", minHeight: 0 }}
        onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
      >
        <View style={[{ flex: 1, minWidth: 0 }, panels && panelStyle]}>
          {panels && header}
          {body}
        </View>
        {threadView &&
          (width >= 1100 ? (
            <View style={{ width: panelWidth }}>
              <PanelResizer
                width={panelWidth}
                min={PANEL_MIN}
                max={largestPanelWidth(room)}
                onChange={(next) => setPanelPref(clampPanelWidth(next, room))}
                onCommit={keepPanelWidth}
                onReset={() => keepPanelWidth(PANEL_DEFAULT)}
              />
              <View
                style={[
                  { flex: 1, paddingHorizontal: 20, paddingBottom: 16, paddingTop: 12 },
                  panelStyle,
                ]}
              >
                {threadView}
              </View>
            </View>
          ) : (
            <Modal visible={active} animationType="slide" onRequestClose={() => setThreadId(null)}>
              <SafeAreaView style={{ flex: 1, padding: 18, backgroundColor: haze.base }}>
                <Backdrop />
                {threadView}
              </SafeAreaView>
            </Modal>
          ))}
      </View>
    </MentionNamesProvider>
  );
}
