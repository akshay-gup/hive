import { useState } from "react";
import { Text } from "react-native";
import { channelsChanged } from "./channel-events";
import { TypedConfirmSheet } from "./hosted/typed-confirm";
import { s } from "./ui";
import { useWorkspace } from "./workspace";

/**
 * The question before a channel is put away. Nothing in the app brings one back, so the button stays
 * off until the person has typed the channel's name. An owner or admin archiving a channel from the
 * list of every channel goes by the route that does not need them to be in it.
 */
export function ArchiveChannelSheet({
  id,
  name,
  admin,
  onClose,
  onArchived,
}: {
  id: string;
  name: string;
  admin?: boolean;
  onClose: () => void;
  onArchived: () => void;
}) {
  const { api } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function archive() {
    setBusy(true);
    setError("");
    try {
      const path = `${admin ? "/api/agent/admin/channels" : "/api/agent/channels"}/${encodeURIComponent(id)}/archive`;
      await api.request(path, {});
      channelsChanged();
      onArchived();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <TypedConfirmSheet
      title={`Archive ${name}`}
      word={name}
      confirmLabel="Archive channel"
      busyText="Archiving…"
      busy={busy}
      error={error}
      onConfirm={() => void archive()}
      onClose={onClose}
    >
      <Text style={s.muted}>
        The channel becomes read-only: its messages, files and board stay as they are, no one is
        added or taken out, and it leaves everyone's list. Nothing in the app brings it back.
      </Text>
    </TypedConfirmSheet>
  );
}
