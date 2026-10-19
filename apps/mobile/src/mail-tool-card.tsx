import { ChevronRight, Mail, Search } from "lucide-react-native";
import { useContext } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { z } from "zod";
import { BrowserRunContext } from "./browser-tool-card";
import { colors, ErrorNotice, IconSlot, radius, s, type WebPressState } from "./ui";
import { useWorkspace } from "./workspace";

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sender: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  date: z.string(),
  unread: z.boolean(),
  label: z.string(),
  attachments: z.array(z.string()),
});

export function MailToolCard({
  result,
  loading,
  search = false,
}: {
  result: unknown;
  loading: boolean;
  search?: boolean;
}) {
  const { open } = useWorkspace();
  const { active } = useContext(BrowserRunContext);
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const error = z.object({ error: z.string() }).safeParse(value);
  if (error.success) return <ErrorNotice error={error.data.error} />;
  if (loading)
    return (
      <View style={[s.row, { gap: 10, padding: 14 }]}>
        <IconSlot>
          {active ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Mail size={16} color={colors.muted} />
          )}
        </IconSlot>
        <Text style={s.muted}>
          {!active ? "Mail reading paused" : search ? "Checking your inbox…" : "Reading the email…"}
        </Text>
      </View>
    );
  if (search) {
    const parsed = z
      .object({ matches: z.array(z.object({ id: z.string() })), truncated: z.boolean() })
      .safeParse(value);
    if (!parsed.success)
      return <ErrorNotice error="The mailbox did not return readable results." />;
    const count = parsed.data.matches.length;
    return (
      <View style={[s.row, { gap: 9, padding: 12 }]}>
        <Search size={16} color={colors.muted} />
        <Text style={s.muted}>
          {count
            ? `Found ${parsed.data.truncated ? "at least " : ""}${count} ${count === 1 ? "email" : "emails"}`
            : "No matching emails"}
        </Text>
      </View>
    );
  }
  const parsed = z
    .object({ messages: z.array(messageSchema), truncated: z.boolean() })
    .safeParse(value);
  if (!parsed.success) return <ErrorNotice error="The email could not be displayed." />;
  const message = parsed.data.messages.at(-1);
  if (!message) return <Text style={s.muted}>No messages in this thread.</Text>;
  const count = parsed.data.messages.length;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open email from ${message.sender}: ${message.subject}`}
      onPress={() => open({ type: "mail", mail: message })}
      style={({ pressed, hovered }: WebPressState) => ({
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 10,
        maxWidth: 480,
        paddingVertical: 9,
        paddingHorizontal: 14,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.line,
        backgroundColor: pressed || hovered ? colors.surfaceMuted : colors.surface,
      })}
    >
      <Mail size={18} color={colors.primary} />
      <View style={{ flexShrink: 1 }}>
        <Text style={[s.text, { fontWeight: "600" }]} numberOfLines={1}>
          {message.subject}
        </Text>
        <Text style={s.small} numberOfLines={1}>
          {message.sender}
          {count > 1 ? ` · ${count} messages` : ""}
          {parsed.data.truncated ? " · excerpt" : ""}
        </Text>
      </View>
      <ChevronRight size={16} color={colors.muted} />
    </Pressable>
  );
}
