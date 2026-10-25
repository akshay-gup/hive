import { ArrowUp, Paperclip, Square, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, TextInput, View } from "react-native";
import { activeMention, insertMention, matchPeople } from "../../../packages/domain/src/mentions";
import { useChat } from "./chat-context";
import { sendChatFile } from "./chat-upload";
import { fileSize } from "./file-format";
import { type PickedFile, pickFiles } from "./file-upload";
import { type MentionOption, MentionPicker, useMentionable } from "./mention-ui";
import { colors, composingText, fontSize, radius, s, shadow, useDense, useFineInput } from "./ui";
import { useWorkspace } from "./workspace";

interface Attachment {
  key: string;
  name: string;
  size: number;
  state: "sending" | "ready" | "failed";
  fileId?: string;
  error?: string;
}

/** What was being written in each box, so going to another channel and back does not lose it. */
const drafts = new Map<string, string>();

/**
 * The box a message is written in, for a channel or a thread: words, `@` to name someone, files to
 * attach (sent as they are chosen, so a message goes the moment the person presses send). Enter sends and
 * Shift+Enter makes a new line, on a keyboard.
 */
export function ChatComposer({
  channelId,
  draftKey,
  placeholder,
  onSend,
  autoFocus,
  disabled,
  agent,
  onStop,
}: {
  channelId: string;
  /** What this box's unsent words are kept under. */
  draftKey: string;
  placeholder: string;
  onSend: (body: string, fileIds: string[]) => Promise<void> | void;
  autoFocus?: boolean;
  disabled?: boolean;
  /** The agent is on in this channel, so `@hive` is offered. */
  agent?: boolean;
  /** Something is going that this person may stop: the send button is a stop button while nothing is written. */
  onStop?: () => void;
}) {
  const { api, notify } = useWorkspace();
  const chat = useChat();
  const people = useMentionable(channelId);
  const denseUi = useDense();
  const fineInput = useFineInput();
  const [draft, setDraft] = useState(() => drafts.get(draftKey) ?? "");
  const [cursor, setCursor] = useState(0);
  const [placeCursor, setPlaceCursor] = useState<{ start: number; end: number } | undefined>();
  const [pick, setPick] = useState(0);
  const [mentionOff, setMentionOff] = useState(false);
  const [focused, setFocused] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [height, setHeight] = useState(36);
  const typedAt = useRef(0);
  const box = useRef<TextInput>(null);
  const min = denseUi ? 32 : 36;

  // Another box (a different channel) starts with its own words.
  useEffect(() => {
    setDraft(drafts.get(draftKey) ?? "");
    setAttachments([]);
  }, [draftKey]);

  const change = (text: string) => {
    setDraft(text);
    drafts.set(draftKey, text);
    // Where the cursor is after typing, on the web, where it is the box's own: the browser does not
    // always say so through the selection change.
    setTimeout(() => {
      const element = box.current as unknown as { selectionStart?: number } | null;
      if (typeof element?.selectionStart === "number") setCursor(element.selectionStart);
    }, 0);
    setMentionOff(false);
    setPick(0);
    // Said at most every few seconds, and only while there are words.
    if (text.trim() && Date.now() - typedAt.current > 2_500) {
      typedAt.current = Date.now();
      chat.typing(channelId);
    }
  };

  const mention = activeMention(draft, cursor);
  const options: MentionOption[] =
    mention && !mentionOff
      ? matchPeople(
          [
            ...(agent ? [{ handle: "hive", name: "Hive", note: "Agent" }] : []),
            ...people.map((person) => ({
              handle: person.handle,
              name: person.name || person.email,
              note: person.role === "guest" ? "Guest" : undefined,
            })),
          ],
          mention.query,
        )
      : [];
  function choose(option: MentionOption) {
    if (!mention) return;
    const next = insertMention(draft, mention, cursor, option.handle);
    change(next.text);
    setCursor(next.cursor);
    setPlaceCursor({ start: next.cursor, end: next.cursor });
  }

  async function attach() {
    let chosen: PickedFile[] = [];
    try {
      chosen = await pickFiles({ multiple: true });
    } catch {
      return;
    }
    for (const file of chosen) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setAttachments((all) => [
        ...all,
        { key, name: file.name, size: file.size ?? file.file?.size ?? 0, state: "sending" },
      ]);
      sendChatFile(api, channelId, file)
        .then((sent) =>
          setAttachments((all) =>
            all.map((a) =>
              a.key === key ? { ...a, state: "ready", fileId: sent.fileId, size: sent.size } : a,
            ),
          ),
        )
        .catch((e) => {
          const error = e instanceof Error ? e.message : String(e);
          setAttachments((all) =>
            all.map((a) => (a.key === key ? { ...a, state: "failed", error } : a)),
          );
          notify(error, { error: true });
        });
    }
  }
  const dropAttachment = (key: string) => setAttachments((all) => all.filter((a) => a.key !== key));

  const ready = attachments.filter((a) => a.state === "ready" && a.fileId);
  const sending = attachments.some((a) => a.state === "sending");
  const canSend = !disabled && !sending && (!!draft.trim() || ready.length > 0);
  const stopping = !!onStop && !draft.trim() && ready.length === 0 && !sending;
  function send() {
    if (!canSend) return;
    const body = draft;
    const fileIds = ready.map((a) => a.fileId as string);
    setDraft("");
    drafts.delete(draftKey);
    setAttachments([]);
    setHeight(min);
    void onSend(body, fileIds);
  }

  return (
    <View>
      <MentionPicker
        options={options}
        selected={Math.min(pick, Math.max(0, options.length - 1))}
        onPick={choose}
      />
      <View
        style={{
          borderRadius: denseUi ? 22 : radius.xxl,
          borderWidth: 1,
          borderColor: focused ? colors.primary : colors.lineStrong,
          backgroundColor: colors.paper,
          padding: 4,
          ...(focused ? { boxShadow: shadow.focus } : null),
        }}
      >
        {attachments.length > 0 && (
          <View style={[s.row, { gap: 6, flexWrap: "wrap", padding: 8 }]}>
            {attachments.map((a) => (
              <View
                key={a.key}
                style={[
                  s.row,
                  {
                    gap: 6,
                    maxWidth: 260,
                    paddingVertical: 4,
                    paddingLeft: 10,
                    paddingRight: 6,
                    borderRadius: radius.pill,
                    borderWidth: 1,
                    borderColor: a.state === "failed" ? colors.dangerLine : colors.line,
                    backgroundColor: a.state === "failed" ? colors.dangerBg : colors.surface,
                  },
                ]}
              >
                {a.state === "sending" && <ActivityIndicator size="small" color={colors.primary} />}
                <Text style={[s.small, { flexShrink: 1, color: colors.text }]} numberOfLines={1}>
                  {a.name}
                  {a.size ? ` · ${fileSize(a.size)}` : ""}
                  {a.state === "failed" ? " · not sent" : ""}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${a.name}`}
                  onPress={() => dropAttachment(a.key)}
                  style={{ padding: 4 }}
                >
                  <X size={13} color={colors.muted} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach files"
            disabled={disabled}
            onPress={() => void attach()}
            style={{
              width: denseUi ? 32 : 34,
              height: denseUi ? 32 : 34,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Paperclip size={18} color={colors.muted} />
          </Pressable>
          <TextInput
            ref={box}
            accessibilityLabel="Message"
            value={draft}
            onChangeText={change}
            autoFocus={autoFocus}
            placeholder={agent && focused ? "Type @hive to ask the agent" : placeholder}
            placeholderTextColor={colors.muted}
            selectionColor={colors.primary}
            selection={placeCursor}
            onSelectionChange={(event) => {
              setCursor(event.nativeEvent.selection.end);
              setPlaceCursor(undefined);
            }}
            onContentSizeChange={(event) =>
              setHeight(Math.max(min, Math.min(140, event.nativeEvent.contentSize.height)))
            }
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            multiline
            editable={!disabled}
            style={{
              flex: 1,
              color: colors.text,
              // An empty box is one line, whatever its hint measures: a hint that wraps must not make it taller.
              height: draft ? height : min,
              minHeight: min,
              maxHeight: 140,
              fontSize: fineInput ? fontSize.body : fontSize.input,
              lineHeight: fineInput ? 20 : 22,
              paddingHorizontal: 2,
              paddingTop: denseUi ? 6 : 8,
              paddingBottom: denseUi ? 6 : 8,
              ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null),
            }}
            onKeyPress={
              Platform.OS === "web"
                ? (event) => {
                    const key = event.nativeEvent.key;
                    if (options.length) {
                      const last = options.length - 1;
                      if (key === "ArrowDown" || key === "ArrowUp") {
                        event.preventDefault();
                        setPick((n) =>
                          key === "ArrowDown" ? (n >= last ? 0 : n + 1) : n <= 0 ? last : n - 1,
                        );
                        return;
                      }
                      if (key === "Enter" || key === "Tab") {
                        event.preventDefault();
                        choose(options[Math.min(pick, last)] ?? (options[0] as MentionOption));
                        return;
                      }
                      if (key === "Escape") {
                        event.preventDefault();
                        setMentionOff(true);
                        return;
                      }
                    }
                    if (
                      key === "Enter" &&
                      !("shiftKey" in event.nativeEvent && event.nativeEvent.shiftKey) &&
                      !composingText(event.nativeEvent)
                    ) {
                      event.preventDefault();
                      send();
                    }
                  }
                : undefined
            }
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={stopping ? "Stop the agent" : "Send message"}
            disabled={!canSend && !stopping}
            onPress={stopping ? onStop : send}
            style={({ pressed }) => ({
              width: denseUi ? 32 : 34,
              height: denseUi ? 32 : 34,
              borderRadius: denseUi ? 16 : 17,
              backgroundColor: colors.action,
              opacity: canSend || stopping ? 1 : 0.4,
              alignItems: "center",
              justifyContent: "center",
              transform: [{ scale: pressed ? 0.94 : 1 }],
            })}
          >
            {stopping ? (
              <Square size={denseUi ? 12 : 14} fill={colors.onPrimary} color={colors.onPrimary} />
            ) : (
              <ArrowUp size={denseUi ? 18 : 22} strokeWidth={2.4} color={colors.onPrimary} />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}
