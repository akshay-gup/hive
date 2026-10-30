import Archive from "lucide-react-native/dist/esm/icons/archive";
import Lock from "lucide-react-native/dist/esm/icons/lock";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ChannelDirectoryEntry } from "../../../packages/domain/src/agent";
import { ArchiveChannelSheet } from "./channel-archive";
import { useOnChannelsChanged } from "./channel-events";
import { Disclosure } from "./disclosure";
import { Button, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Who is in a channel, in a line: how many, and who looks after it. */
function line(entry: ChannelDirectoryEntry): string {
  const people = entry.everyone
    ? "Everyone"
    : `${entry.count} ${entry.count === 1 ? "person" : "people"}`;
  return entry.managers.length ? `${people} · managed by ${entry.managers.join(", ")}` : people;
}

/**
 * The private channels in the workspace that an owner or admin is not in, which no one but their people can
 * otherwise find, so that one nobody looks after is not lost. It shows what a channel is and who is in it, not
 * what is said there, and an owner or admin cannot join one: to be in it they must be added by someone who is.
 * They can archive it. Nothing shows when there is none.
 */
export function ChannelDirectory() {
  const { api } = useWorkspace();
  const [rows, setRows] = useState<ChannelDirectoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [archiving, setArchiving] = useState<ChannelDirectoryEntry | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.request<ChannelDirectoryEntry[]>("/api/agent/admin/channels"));
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  useOnChannelsChanged(() => void load());

  const live = (rows ?? []).filter(
    (entry) => !entry.archived && entry.visibility === "private" && !entry.joined,
  );
  if (!live.length && !error) return archiving ? sheet() : null;
  return (
    <Disclosure
      title="Private channels you are not in"
      detail={`${live.length} ${live.length === 1 ? "channel" : "channels"} · you can archive them, not read them`}
    >
      <ErrorNotice error={error} />
      {live.map((entry) => (
        <View key={entry.id} style={[s.row, { gap: 12 }]}>
          <Lock size={18} color={colors.text} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.text} numberOfLines={1}>
              {entry.name}
            </Text>
            <Text style={s.small} numberOfLines={2}>
              {line(entry)}
            </Text>
          </View>
          <Button small danger icon={Archive} onPress={() => setArchiving(entry)}>
            Archive…
          </Button>
        </View>
      ))}
      {sheet()}
    </Disclosure>
  );
  function sheet() {
    return archiving ? (
      <ArchiveChannelSheet
        id={archiving.id}
        name={archiving.name}
        admin
        onClose={() => setArchiving(null)}
        onArchived={() => setArchiving(null)}
      />
    ) : null;
  }
}
