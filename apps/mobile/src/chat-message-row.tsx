import { Copy, MessageSquare, Pencil, RotateCcw, Smile, Trash2, X } from "lucide-react-native";
import { useState } from "react";
import { Platform, Pressable, Share, Text, TextInput, View } from "react-native";
import type { ChatReaction } from "../../../packages/domain/src/chat";
import type { PromptChoice } from "../../../packages/domain/src/chat-agent";
import { authorTint } from "./channel-message";
import { agentView } from "./chat-agent-extra";
import { ChatAgentBody } from "./chat-agent-message";
import type { FeedMessage } from "./chat-feed";
import { ChatFiles } from "./chat-files";
import { MentionText } from "./mention-ui";
import {
  Button,
  colors,
  composingText,
  fontSize,
  Mascot,
  radius,
  s,
  shadow,
  useDense,
  useHoverTip,
  type WebPressState,
} from "./ui";

/** The pictures offered for a quick reaction. */
const QUICK = ["👍", "❤️", "😄", "🎉", "👀", "🙏"];

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function Toolbar({ children, visible }: { children: React.ReactNode; visible: boolean }) {
  return (
    <View
      pointerEvents={visible ? "auto" : "none"}
      style={[
        s.row,
        {
          gap: 2,
          position: "absolute",
          right: 8,
          top: -16,
          opacity: visible ? 1 : 0,
          zIndex: 1,
          backgroundColor: colors.paper,
          borderWidth: 1,
          borderColor: colors.line,
          borderRadius: radius.md,
          padding: 2,
        },
      ]}
    >
      {children}
    </View>
  );
}

function ToolButton({
  icon: Icon,
  label,
  onPress,
}: {
  icon: typeof Copy;
  label: string;
  onPress: () => void;
}) {
  const tip = useHoverTip(label);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...tip.props}
      style={({ pressed, hovered }: WebPressState) => ({
        padding: 7,
        borderRadius: radius.sm,
        backgroundColor: pressed || hovered ? colors.tile : colors.paper,
      })}
    >
      <Icon size={16} color={colors.muted} />
      {tip.tip}
    </Pressable>
  );
}

function Reactions({
  reactions,
  me,
  onToggle,
  disabled,
}: {
  reactions: ChatReaction[];
  me: string;
  onToggle: (emoji: string, on: boolean) => void;
  disabled: boolean;
}) {
  if (!reactions.length) return null;
  return (
    <View style={[s.row, { gap: 6, flexWrap: "wrap", paddingTop: 4 }]}>
      {reactions.map((r) => {
        const mine = r.users.includes(me);
        return (
          <Pressable
            key={r.emoji}
            accessibilityRole="button"
            accessibilityLabel={`${r.emoji} ${r.count}${mine ? ", yours" : ""}`}
            accessibilityState={{ selected: mine }}
            disabled={disabled}
            onPress={() => onToggle(r.emoji, !mine)}
            style={[
              s.row,
              {
                gap: 4,
                paddingVertical: 2,
                paddingHorizontal: 8,
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: mine ? colors.primary : colors.line,
                backgroundColor: mine ? colors.primarySoft : colors.surface,
              },
            ]}
          >
            <Text style={{ fontSize: fontSize.small }}>{r.emoji}</Text>
            <Text
              style={{
                fontSize: fontSize.caption,
                color: mine ? colors.primaryText : colors.muted,
                fontWeight: "600",
              }}
            >
              {r.count}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * One message in a channel or a thread: who and when, what was said, its files, the reactions to it, and
 * what a thread under it has. What can be done to it (react, reply, edit, delete) is offered on hover, or
 * on a tap where there is no pointer; what this person may not do is not offered.
 */
export function ChatMessageRow({
  message,
  me,
  grouped,
  mentions,
  canTakePart,
  canDelete,
  selected,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onResend,
  onDiscard,
  onNotify,
  agent,
}: {
  message: FeedMessage;
  /** This person's id. */
  me: string;
  /** Shown under the one before it, without its name. */
  grouped: boolean;
  mentions: string[];
  /** In the channel, so may react, reply and edit their own. */
  canTakePart: boolean;
  /** May take this message away (its author, a manager, an admin or the owner). */
  canDelete: boolean;
  selected?: boolean;
  /** Open the thread under it; left out inside a thread. */
  onReply?: () => void;
  onReact: (emoji: string, on: boolean) => void;
  onEdit: (body: string) => Promise<void>;
  onDelete: () => void;
  onResend: () => void;
  onDiscard: () => void;
  onNotify: (text: string) => void;
  /** What can be done about the agent's replies: decide what it asks. */
  agent?: {
    /** A teammate in the channel (not a guest) may decide what it asks. */
    canAnswer: boolean;
    answer: (runId: string, promptId: string, choice: PromptChoice) => Promise<void>;
  };
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [saving, setSaving] = useState(false);
  const hoverUi = useDense();
  const mine = message.author.id === me;
  // The agent's reply to a mention, when this app can read how its run is going.
  const run = message.author.kind === "agent" ? agentView(message.extra) : null;
  const toolbar = (hovered || focused || picking) && !editing && !message.pending;
  const lastReply = message.lastReplyAt ? clock(message.lastReplyAt) : "";

  async function copy() {
    try {
      if (Platform.OS === "web") {
        await navigator.clipboard.writeText(message.body);
        onNotify("Message copied");
      } else await Share.share({ message: message.body });
    } catch {
      onNotify("Could not copy message. Select the text to copy it.");
    }
  }
  async function save() {
    const text = draft.trim();
    if (!text || text === message.body) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onEdit(text);
      setEditing(false);
    } catch (e) {
      onNotify(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (message.deleted)
    return (
      <View style={{ paddingHorizontal: 8, paddingTop: 6, paddingBottom: 1 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ width: 32 }} />
          <View style={{ flex: 1 }}>
            <Text style={[s.small, { fontStyle: "italic", lineHeight: 20 }]}>
              This message was deleted.
            </Text>
            {!!message.replyCount && onReply && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open thread, ${message.replyCount} replies`}
                onPress={onReply}
                style={{ alignSelf: "flex-start", paddingVertical: 4 }}
              >
                <Text
                  style={{ color: colors.primaryText, fontSize: fontSize.small, fontWeight: "600" }}
                >
                  {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    );

  return (
    <Pressable
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={hoverUi ? undefined : () => setExpanded((open) => !open)}
      onLongPress={onReply && canTakePart ? onReply : undefined}
      delayLongPress={350}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        paddingHorizontal: 8,
        paddingTop: grouped ? 1 : 6,
        paddingBottom: 1,
        borderRadius: radius.md,
        opacity: message.pending && !message.failed ? 0.6 : 1,
        backgroundColor: selected ? colors.surface : hovered ? colors.surfaceMuted : "transparent",
        ...(selected ? { boxShadow: shadow.active } : null),
      }}
    >
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ width: 32, alignItems: "center" }}>
          {grouped ? (
            hoverUi && toolbar ? (
              <Text style={[s.small, { fontSize: fontSize.micro, lineHeight: 20 }]}>
                {clock(message.createdAt).replace(/\s?[AP]M$/i, "")}
              </Text>
            ) : null
          ) : message.author.kind === "agent" ? (
            <Mascot size={32} />
          ) : (
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: radius.md,
                backgroundColor: authorTint(message.author.name),
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={[s.text, { fontWeight: "700" }]}>
                {message.author.name.slice(0, 1).toUpperCase()}
              </Text>
            </View>
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {!grouped && (
            <View style={[s.row, { gap: 8 }]}>
              <Text style={[s.text, { fontWeight: "700", lineHeight: 20 }]}>
                {message.author.name}
              </Text>
              <Text style={[s.small, { lineHeight: 20 }]}>{clock(message.createdAt)}</Text>
            </View>
          )}
          {editing ? (
            <View style={{ gap: 8, paddingVertical: 4 }}>
              <TextInput
                accessibilityLabel="Edit message"
                value={draft}
                onChangeText={setDraft}
                autoFocus
                multiline
                editable={!saving}
                onKeyPress={
                  Platform.OS === "web"
                    ? (event) => {
                        const key = event.nativeEvent.key;
                        if (key === "Escape") setEditing(false);
                        else if (
                          key === "Enter" &&
                          !("shiftKey" in event.nativeEvent && event.nativeEvent.shiftKey) &&
                          !composingText(event.nativeEvent)
                        ) {
                          event.preventDefault();
                          void save();
                        }
                      }
                    : undefined
                }
                style={[s.input, { minHeight: 40 }]}
              />
              <View style={[s.row, { gap: 8 }]}>
                <Button
                  small
                  primary
                  busy={saving}
                  disabled={!draft.trim()}
                  onPress={() => void save()}
                >
                  Save
                </Button>
                <Button small disabled={saving} onPress={() => setEditing(false)}>
                  Cancel
                </Button>
              </View>
            </View>
          ) : run ? (
            <ChatAgentBody
              view={run}
              body={message.body}
              canAnswer={!!agent?.canAnswer}
              onAnswer={async (promptId, choice) => {
                await agent?.answer(run.runId, promptId, choice);
              }}
            />
          ) : (
            !!message.body && (
              <View>
                <MentionText
                  text={message.body}
                  handles={mentions}
                  style={[s.text, { lineHeight: 20 }]}
                />
                {!!message.editedAt && (
                  <Text style={{ fontSize: fontSize.micro, color: colors.muted }}>(edited)</Text>
                )}
              </View>
            )
          )}
          <ChatFiles files={message.files} />
          <Reactions
            reactions={message.reactions}
            me={me}
            onToggle={onReact}
            disabled={!canTakePart || !!message.pending}
          />
          {message.failed && (
            <View style={[s.row, { gap: 12, paddingTop: 4 }]}>
              <Text style={{ color: colors.danger, fontSize: fontSize.small }}>Not sent.</Text>
              <Pressable accessibilityRole="button" onPress={onResend} style={s.row}>
                <RotateCcw size={13} color={colors.primaryText} />
                <Text
                  style={{ color: colors.primaryText, fontSize: fontSize.small, fontWeight: "600" }}
                >
                  {" "}
                  Try again
                </Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={onDiscard}>
                <Text style={{ color: colors.muted, fontSize: fontSize.small, fontWeight: "600" }}>
                  Discard
                </Text>
              </Pressable>
            </View>
          )}
          {onReply && message.replyCount > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open thread, ${message.replyCount} replies`}
              onPress={onReply}
              style={[s.row, { alignSelf: "flex-start", gap: 8, paddingVertical: 4 }]}
            >
              <Text
                style={{ color: colors.primaryText, fontSize: fontSize.small, fontWeight: "600" }}
              >
                {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
                {selected ? " · Viewing thread" : ""}
              </Text>
              {!!lastReply && <Text style={s.small}>Last reply {lastReply}</Text>}
            </Pressable>
          )}
          {!hoverUi && expanded && !editing && !message.pending && (
            <View style={[s.row, { gap: 8, paddingTop: 4, flexWrap: "wrap" }]}>
              {canTakePart && (
                <Button
                  small
                  onPress={() => {
                    setExpanded(false);
                    setPicking(true);
                  }}
                >
                  React
                </Button>
              )}
              {onReply && canTakePart && (
                <Button
                  small
                  onPress={() => {
                    setExpanded(false);
                    onReply();
                  }}
                >
                  Reply
                </Button>
              )}
              {mine && canTakePart && (
                <Button
                  small
                  onPress={() => {
                    setExpanded(false);
                    setDraft(message.body);
                    setEditing(true);
                  }}
                >
                  Edit
                </Button>
              )}
              {canDelete && (
                <Button
                  small
                  danger
                  onPress={() => {
                    setExpanded(false);
                    onDelete();
                  }}
                >
                  Delete
                </Button>
              )}
              <Button
                small
                onPress={() => {
                  setExpanded(false);
                  void copy();
                }}
              >
                Copy
              </Button>
            </View>
          )}
          {picking && (
            <View style={[s.row, { gap: 4, paddingTop: 4, flexWrap: "wrap" }]}>
              {QUICK.map((emoji) => (
                <Pressable
                  key={emoji}
                  accessibilityRole="button"
                  accessibilityLabel={`React with ${emoji}`}
                  onPress={() => {
                    setPicking(false);
                    onReact(
                      emoji,
                      !message.reactions.find((r) => r.emoji === emoji)?.users.includes(me),
                    );
                  }}
                  style={{
                    padding: 6,
                    borderRadius: radius.sm,
                    backgroundColor: colors.surface,
                    borderWidth: 1,
                    borderColor: colors.line,
                  }}
                >
                  <Text style={{ fontSize: fontSize.body }}>{emoji}</Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close reactions"
                onPress={() => setPicking(false)}
                style={{ padding: 8 }}
              >
                <X size={14} color={colors.muted} />
              </Pressable>
            </View>
          )}
        </View>
      </View>
      {hoverUi && (
        <Toolbar visible={toolbar}>
          {canTakePart && (
            <ToolButton
              icon={Smile}
              label="Add reaction"
              onPress={() => setPicking((open) => !open)}
            />
          )}
          {onReply && canTakePart && (
            <ToolButton icon={MessageSquare} label="Reply in thread" onPress={onReply} />
          )}
          {mine && canTakePart && (
            <ToolButton
              icon={Pencil}
              label="Edit message"
              onPress={() => {
                setDraft(message.body);
                setEditing(true);
              }}
            />
          )}
          {canDelete && <ToolButton icon={Trash2} label="Delete message" onPress={onDelete} />}
          <ToolButton icon={Copy} label="Copy message" onPress={() => void copy()} />
        </Toolbar>
      )}
    </Pressable>
  );
}
