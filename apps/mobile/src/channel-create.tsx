import { useState } from "react";
import { Text, View } from "react-native";
import type { Channel, ChannelVisibility } from "../../../packages/domain/src/agent";
import { channelsChanged } from "./channel-events";
import { visibilityHint } from "./channel-text";
import { useHosted } from "./hosted/context";
import { Button, ErrorNotice, Field, Segmented, s } from "./ui";
import { useWorkspace } from "./workspace";

/**
 * The form for a new channel. Where the workspace knows its people a channel is public or private,
 * as in Slack: the team finds a public one and joins it, and only the people in a private one find
 * it. The person who makes it is in it and manages it.
 */
export function NewChannelForm({
  onCreated,
  onCancel,
  autoFocus,
}: {
  onCreated: (channel: Channel) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const { api } = useWorkspace();
  const hosted = useHosted();
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<ChannelVisibility>("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    const trimmed = name.trim();
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
      onCreated(made);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <Field
        label="Channel name"
        compact
        autoFocus={autoFocus}
        value={name}
        onChangeText={setName}
        placeholder="e.g. family-trip"
        returnKeyType="done"
        onSubmitEditing={() => void create()}
        onKeyPress={(event) => {
          if (event.nativeEvent.key === "Escape") onCancel();
        }}
      />
      {hosted && (
        <View style={{ gap: 6 }}>
          <Segmented
            label="Who can find it"
            value={visibility}
            onChange={setVisibility}
            options={[
              { id: "public", label: "Public" },
              { id: "private", label: "Private" },
            ]}
          />
          <Text style={s.small}>{visibilityHint[visibility]}</Text>
        </View>
      )}
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 8 }]}>
        <Button primary small busy={busy} disabled={!name.trim()} onPress={() => void create()}>
          Create
        </Button>
        <Button small disabled={busy} onPress={onCancel}>
          Cancel
        </Button>
      </View>
    </View>
  );
}
