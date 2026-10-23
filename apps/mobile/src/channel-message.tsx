import { Copy, type LucideIcon, MessageSquare, Share2 } from "lucide-react-native";
import { useState } from "react";
import { Platform, Pressable, Share, Text, View } from "react-native";
import { useAgentWorkspace } from "./agent-workspace";
import { AssistantResponse } from "./assistant-response";
import { MentionText } from "./mention-ui";
import {
  avatarTints,
  colors,
  fontSize,
  Mascot,
  radius,
  s,
  shadow,
  useDense,
  useHoverTip,
  type WebPressState,
} from "./ui";

/** A stable tint per person, so a busy channel is easier to scan than a wall of identical tiles. */
export function authorTint(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return avatarTints[hash % avatarTints.length];
}

function clock(timestamp: number, withPeriod = true): string {
  const label = new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return withPeriod ? label : label.replace(/\s?[AP]M$/i, "");
}

function ActionPill({
  icon: Icon,
  label,
  onPress,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.row,
        {
          gap: 6,
          minHeight: 36,
          paddingHorizontal: 12,
          borderRadius: radius.md,
          backgroundColor: pressed ? colors.primarySoftStrong : colors.surfaceMuted,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Icon size={15} color={colors.text} />
      <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: colors.text }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ChannelMessage({
  text,
  author,
  assistant,
  onReply,
  replyCount = 0,
  hasThread,
  replyDisabled,
  selected,
  grouped = false,
  timestamp,
  onNotify,
  mentions = [],
}: {
  /** The handles that name someone in this channel, to set them apart in the text. */
  mentions?: string[];
  text: string;
  author: string;
  assistant?: boolean;
  onReply?: () => void;
  replyCount?: number;
  hasThread?: boolean;
  replyDisabled?: boolean;
  selected?: boolean;
  onNotify: (message: string) => void;
  grouped?: boolean;
  timestamp?: number;
}) {
  const [rowHovered, setHovered] = useState(false);
  // How many of the toolbar's buttons the pointer is on (one, or none). React Native for the web
  // takes the hover away from a hoverable that has another inside it while the pointer is on the
  // inner one, so the message loses its hover on reaching a button; the toolbar and the message's
  // highlight must not go with it, or the toolbar hides, the pointer falls through to the message,
  // the hover comes back and the toolbar shows again, over and over.
  const [onButtons, setOnButtons] = useState(0);
  const hovered = rowHovered || onButtons > 0;
  const [focused, setFocused] = useState(false);
  const webCopy = Platform.OS === "web";
  const replyTip = useHoverTip("Reply in thread");
  const copyTip = useHoverTip(webCopy ? "Copy message" : "Share message");
  const overButton = (tip: ReturnType<typeof useHoverTip>) => ({
    ...tip.props,
    onHoverIn: () => {
      setOnButtons((n) => n + 1);
      tip.props.onHoverIn();
    },
    onHoverOut: () => {
      setOnButtons((n) => Math.max(0, n - 1));
      tip.props.onHoverOut();
    },
  });
  const [expanded, setExpanded] = useState(false);
  const { data } = useAgentWorkspace();
  // Pointer devices get a hover toolbar. Touch layouts tap a message to reveal its actions
  // inline, because a floating toolbar on every message covers the text it belongs to.
  const hoverUi = useDense();
  const toolbarVisible = hovered || focused;
  async function copy() {
    try {
      if (webCopy) {
        await navigator.clipboard.writeText(text);
        onNotify("Message copied");
      } else await Share.share({ message: text });
    } catch {
      onNotify("Could not copy message. Select the text to copy it.");
    }
  }
  const showGutterTime = grouped && !!timestamp && hoverUi && toolbarVisible;
  return (
    <Pressable
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={hoverUi ? undefined : () => setExpanded((open) => !open)}
      onLongPress={onReply}
      delayLongPress={350}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      accessibilityActions={[
        ...(onReply ? [{ name: "reply", label: "Reply in thread" }] : []),
        { name: "copy", label: webCopy ? "Copy message" : "Share message" },
      ]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "reply") onReply?.();
        else if (nativeEvent.actionName === "copy") void copy();
      }}
      style={{
        paddingHorizontal: 8,
        paddingTop: grouped ? 1 : 6,
        paddingBottom: 1,
        borderRadius: radius.md,
        backgroundColor: selected ? colors.surface : hovered ? colors.surfaceMuted : "transparent",
        ...(selected ? { boxShadow: shadow.active } : null),
      }}
    >
      <View style={{ flexDirection: "row", gap: 8 }}>
        {
          <View style={{ width: 32, alignItems: "center" }}>
            {grouped ? (
              showGutterTime && (
                // Same line height as the message text, so showing it on hover cannot make the row taller.
                <Text style={[s.small, { fontSize: fontSize.micro, lineHeight: 20 }]}>
                  {clock(timestamp, false)}
                </Text>
              )
            ) : assistant ? (
              <Mascot size={32} variant={data?.identity.avatar} />
            ) : (
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: radius.md,
                  backgroundColor: authorTint(author),
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={[s.text, { fontWeight: "700" }]}>
                  {author.slice(0, 1).toUpperCase()}
                </Text>
              </View>
            )}
          </View>
        }
        <View style={{ flex: 1, minWidth: 0 }}>
          {!grouped && (
            <View style={[s.row, { gap: 8 }]}>
              <Text style={[s.text, { fontWeight: "700", lineHeight: 20 }]}>{author}</Text>
              {!!timestamp && <Text style={[s.small, { lineHeight: 20 }]}>{clock(timestamp)}</Text>}
            </View>
          )}
          {assistant ? (
            <AssistantResponse content={text} />
          ) : (
            // Flat, as in a team chat: everyone's words sit on the page, on the left, under their name.
            <MentionText text={text} handles={mentions} style={[s.text, { lineHeight: 20 }]} />
          )}
          {onReply && hasThread && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                replyCount ? `Open thread, ${replyCount} replies` : "Reply in thread"
              }
              disabled={replyDisabled}
              onPress={onReply}
              style={{ alignSelf: "flex-start", paddingVertical: 4 }}
            >
              <Text
                style={{ color: colors.primaryText, fontSize: fontSize.small, fontWeight: "600" }}
              >
                {replyCount
                  ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`
                  : hasThread
                    ? "Thread started · 0 replies"
                    : "Reply in thread"}
                {selected ? " · Viewing thread" : ""}
              </Text>
            </Pressable>
          )}
          {!hoverUi && expanded && (
            <View style={[s.row, { gap: 8, paddingTop: 4, flexWrap: "wrap" }]}>
              {onReply && (
                <ActionPill
                  icon={MessageSquare}
                  label="Reply"
                  disabled={replyDisabled}
                  onPress={() => {
                    setExpanded(false);
                    onReply();
                  }}
                />
              )}
              <ActionPill
                icon={webCopy ? Copy : Share2}
                label={webCopy ? "Copy" : "Share"}
                onPress={() => {
                  setExpanded(false);
                  void copy();
                }}
              />
            </View>
          )}
        </View>
      </View>
      {hoverUi && (
        <View
          pointerEvents={toolbarVisible ? "auto" : "none"}
          style={[
            s.row,
            {
              gap: 2,
              position: "absolute",
              right: 8,
              top: -16,
              opacity: toolbarVisible ? 1 : 0,
              zIndex: 1,
              // Opaque: the message under it is tinted, and a tint on a tint shows through.
              backgroundColor: colors.paper,
              borderWidth: 1,
              borderColor: colors.line,
              borderRadius: radius.md,
              padding: 2,
            },
          ]}
        >
          {onReply && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reply in thread"
              disabled={replyDisabled}
              onPress={onReply}
              {...overButton(replyTip)}
              style={({ pressed, hovered: over }: WebPressState) => ({
                padding: 7,
                borderRadius: radius.sm,
                opacity: replyDisabled ? 0.4 : 1,
                backgroundColor: pressed || over ? colors.tile : colors.paper,
              })}
            >
              <MessageSquare size={16} color={colors.muted} />
              {replyTip.tip}
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy message"
            onPress={() => void copy()}
            {...overButton(copyTip)}
            style={({ pressed, hovered: over }: WebPressState) => ({
              padding: 7,
              borderRadius: radius.sm,
              backgroundColor: pressed || over ? colors.tile : colors.paper,
            })}
          >
            <Copy size={16} color={colors.muted} />
            {copyTip.tip}
          </Pressable>
        </View>
      )}
    </Pressable>
  );
}
