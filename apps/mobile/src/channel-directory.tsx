import Archive from "lucide-react-native/dist/esm/icons/archive";
import Lock from "lucide-react-native/dist/esm/icons/lock";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ChannelDirectoryEntry } from "../../../packages/domain/src/agent";
import { ArchiveChannelSheet } from "./channel-archive";
import { useOnChannelsChanged } from "./channel-events";
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
 * otherwise find, so that one nobody looks after is not lost. An owner or admin cannot join one: to be in it they
 * must be added by someone who is. Nothing is listed when there are none.
 */
export function usePrivateChannels(enabled: boolean) {
  const { api } = useWorkspace();
  const [rows, setRows] = useState<ChannelDirectoryEntry[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const all = await api.request<ChannelDirectoryEntry[]>("/api/agent/admin/channels");
      setRows(
        all.filter((entry) => !entry.archived && entry.visibility === "private" && !entry.joined),
      );
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, [api, enabled]);
  useEffect(() => {
    void load();
  }, [load]);
  useOnChannelsChanged(() => void load());
  return { channels: rows, error };
}

/** The private channels an owner or admin is not in: what each is and who is in it, not what is said there, and a way to archive it. */
export function PrivateChannelList({
  channels,
  error,
}: {
  channels: ChannelDirectoryEntry[];
  error: string;
}) {
  const [archiving, setArchiving] = useState<ChannelDirectoryEntry | null>(null);
  return (
    <View style={{ gap: 12 }}>
      <Text style={s.muted}>
        You can see that these exist and who is in them, and archive them. You cannot read them or
        join them: to be in one, someone who is must add you.
      </Text>
      <ErrorNotice error={error} />
      {!channels.length && !error && <Text style={s.small}>There are none.</Text>}
      {channels.map((entry) => (
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
      {archiving && (
        <ArchiveChannelSheet
          id={archiving.id}
          name={archiving.name}
          admin
          onClose={() => setArchiving(null)}
          onArchived={() => setArchiving(null)}
        />
      )}
    </View>
  );
}
