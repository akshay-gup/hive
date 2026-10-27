import Archive from "lucide-react-native/dist/esm/icons/archive";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ChannelFootprint } from "../../../packages/domain/src/agent";
import { channelsChanged } from "./channel-events";
import { footprintLines } from "./channel-footprint";
import { TypedConfirmSheet } from "./hosted/typed-confirm";
import { Button, Card, CheckRow, colors, Pending, s } from "./ui";
import { useWorkspace } from "./workspace";

/**
 * The question before a channel is deleted, which nothing brings back. It says what would go, with the
 * numbers, before anything else; the button stays off until the person has ticked that they understand
 * and has typed the channel's name; and it offers archiving, which keeps everything, instead.
 */
export function DeleteChannelSheet({
  id,
  name,
  onClose,
  onDeleted,
  onArchiveInstead,
}: {
  id: string;
  name: string;
  onClose: () => void;
  onDeleted: () => void;
  onArchiveInstead: () => void;
}) {
  const { api } = useWorkspace();
  const [footprint, setFootprint] = useState<ChannelFootprint | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api
      .request<ChannelFootprint>(`/api/agent/channels/${encodeURIComponent(id)}/footprint`)
      .then((found) => live && setFootprint(found))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [api, id]);

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api.request(`/api/agent/channels/${encodeURIComponent(id)}`, undefined, "DELETE");
      channelsChanged();
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <TypedConfirmSheet
      title={`Delete ${name} for good?`}
      subtitle="This cannot be undone."
      word={name}
      confirmLabel={`Delete ${name} and everything in it`}
      busyText="Deleting…"
      busy={busy}
      error={error}
      also={understood && !!footprint}
      onConfirm={() => void remove()}
      onClose={onClose}
    >
      <Card style={{ gap: 10, borderColor: colors.dangerLine }}>
        <Text style={[s.text, { fontWeight: "600", color: colors.danger }]}>
          Everything in {name} will be deleted, and nobody can get it back, not you and not an
          admin.
        </Text>
        {footprint ? (
          <View style={{ gap: 6 }}>
            {footprintLines(footprint).map((line) => (
              <Text key={line} style={s.text}>
                · {line}
              </Text>
            ))}
          </View>
        ) : error ? null : (
          <Pending height={80} />
        )}
      </Card>
      <View style={{ gap: 6 }}>
        <Text style={s.small}>
          If you only want it out of the way, archive it instead: it stays as it is, read-only, and
          leaves everyone's list.
        </Text>
        <View style={s.row}>
          <Button small icon={Archive} disabled={busy} onPress={onArchiveInstead}>
            Archive instead
          </Button>
        </View>
      </View>
      <CheckRow
        label={`I understand that everything in ${name} will be deleted for good.`}
        checked={understood}
        onPress={() => setUnderstood(!understood)}
      />
    </TypedConfirmSheet>
  );
}
