import { useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import type { Channel, ChannelVisibility } from "../../../packages/domain/src/agent";
import { channelsChanged } from "./channel-events";
import { useHosted } from "./hosted/context";
import { useMuseThread } from "./threads";
import { Button, colors, ErrorNotice, fontSize, radius, Sheet, s, shadow } from "./ui";
import { useWorkspace } from "./workspace";

/** One of two ways to share a channel: a radio, what it is called, and what it comes to. */
function Choice({
  selected,
  title,
  detail,
  onPress,
}: {
  selected: boolean;
  title: string;
  detail: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={title}
      onPress={onPress}
      style={[s.row, { gap: 12, alignItems: "flex-start", paddingVertical: 6 }]}
    >
      <View
        style={{
          width: 20,
          height: 20,
          marginTop: 1,
          borderRadius: 10,
          borderWidth: 2,
          borderColor: selected ? colors.primary : colors.lineStrong,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected && (
          <View
            style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary }}
          />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.text}>{title}</Text>
        <Text style={s.small}>{detail}</Text>
      </View>
    </Pressable>
  );
}

/**
 * The window for a new channel. Where the workspace knows its people a channel is public or private:
 * the team finds a public one and joins it, and only the people in a private one find it. The person
 * who makes it is in it and manages it.
 */
export function NewChannelSheet() {
  const { api, close } = useWorkspace();
  const hosted = useHosted();
  const { select } = useMuseThread();
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<ChannelVisibility>("public");
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    const trimmed = name.trim().replace(/^#+\s*/, "");
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      const made = await api.request<Channel>("/api/agent/channels", {
        name: trimmed,
        ...(hosted ? { visibility } : {}),
      });
      // A workspace that has not taken up the update yet makes every channel public, and says
      // nothing: someone who asked for a private one must not be left thinking they have it.
      if (hosted && visibility === "private" && made.visibility !== "private") {
        await api
          .request(`/api/agent/channels/${encodeURIComponent(made.id)}/archive`, {})
          .catch(() => undefined);
        channelsChanged();
        throw new Error(
          "This workspace is still updating and cannot make private channels yet. Try again in a few minutes.",
        );
      }
      channelsChanged();
      close();
      // A new channel is usable immediately: open it as a chat.
      select({ id: `channel:${made.id}`, existing: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Create a channel" narrow onClose={close}>
      <View style={{ gap: 22 }}>
        <View style={{ gap: 8 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>Name</Text>
          <View
            style={[
              s.row,
              {
                gap: 8,
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: focused ? colors.primary : colors.lineStrong,
                borderRadius: radius.md,
                paddingHorizontal: 14,
                ...(focused ? { boxShadow: shadow.focus } : null),
              },
            ]}
          >
            <Text style={[s.text, { color: colors.muted }]}>#</Text>
            <TextInput
              autoFocus
              accessibilityLabel="Channel name"
              placeholder="e.g. family-trip"
              placeholderTextColor={colors.muted}
              value={name}
              onChangeText={setName}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => void create()}
              style={[
                {
                  flex: 1,
                  minWidth: 0,
                  paddingVertical: 12,
                  fontSize: fontSize.input,
                  color: colors.text,
                },
                Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null,
              ]}
            />
          </View>
          <Text style={s.small}>
            A channel is a place for one topic, with its own threads and files. Pick a name that is
            easy to find.
          </Text>
        </View>

        {hosted && (
          <View style={{ gap: 6 }} accessibilityRole="radiogroup">
            <Text style={[s.text, { fontWeight: "600" }]}>Who can find it</Text>
            <Choice
              selected={visibility === "public"}
              title={`Public: anyone in ${hosted.workspace.name}`}
              detail="They can look inside it and join."
              onPress={() => setVisibility("public")}
            />
            <Choice
              selected={visibility === "private"}
              title="Private: only the people you add"
              detail="No one else can see it or find it."
              onPress={() => setVisibility("private")}
            />
          </View>
        )}

        <ErrorNotice error={error} />
        <View style={[s.row, { gap: 10, justifyContent: "flex-end" }]}>
          <Button disabled={busy} onPress={close}>
            Cancel
          </Button>
          <Button primary busy={busy} disabled={!name.trim()} onPress={() => void create()}>
            Create
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
