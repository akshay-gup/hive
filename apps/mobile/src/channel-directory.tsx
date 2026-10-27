import Archive from "lucide-react-native/dist/esm/icons/archive";
import Hash from "lucide-react-native/dist/esm/icons/hash";
import Lock from "lucide-react-native/dist/esm/icons/lock";
import LogIn from "lucide-react-native/dist/esm/icons/log-in";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ChannelDirectoryEntry } from "../../../packages/domain/src/agent";
import { ArchiveChannelSheet } from "./channel-archive";
import { channelsChanged, useOnChannelsChanged } from "./channel-events";
import { useMuseThread } from "./threads";
import { Button, colors, ErrorNotice, Pending, SectionHeading, s } from "./ui";
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
 * Every channel in the workspace, for an owner or admin: the private ones too, which no one but
 * their people can otherwise find, so that a channel whose people have gone is not lost. It shows
 * what a channel is and who is in it, not what is said there; joining one puts the admin in its list
 * of people, where everyone in it can see them.
 */
export function ChannelDirectory() {
  const { api, close } = useWorkspace();
  const { select } = useMuseThread();
  const [rows, setRows] = useState<ChannelDirectoryEntry[] | null>(null);
  const [busy, setBusy] = useState("");
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

  async function join(entry: ChannelDirectoryEntry) {
    setBusy(entry.id);
    setError("");
    try {
      await api.request(`/api/agent/admin/channels/${encodeURIComponent(entry.id)}/join`, {});
      channelsChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  function open(entry: ChannelDirectoryEntry) {
    select({ id: `channel:${entry.id}`, existing: true });
    close();
  }

  const live = (rows ?? []).filter((entry) => !entry.archived);
  const archived = (rows ?? []).length - live.length;
  return (
    <View style={{ gap: 12 }}>
      <SectionHeading title="Channels" />
      <Text style={s.muted}>
        Every channel in the workspace, private ones too. Joining one puts you in its list of
        people.
      </Text>
      <ErrorNotice error={error} />
      {!rows ? (
        <Pending height={72} />
      ) : (
        <View style={{ gap: 12 }}>
          {live.map((entry) => {
            const Icon = entry.visibility === "private" ? Lock : Hash;
            return (
              <View key={entry.id} style={{ gap: 8 }}>
                <View style={[s.row, { gap: 12 }]}>
                  <Icon size={18} color={colors.text} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.text} numberOfLines={1}>
                      {entry.name}
                    </Text>
                    <Text style={s.small} numberOfLines={2}>
                      {line(entry)}
                    </Text>
                  </View>
                </View>
                <View style={[s.row, { gap: 10, flexWrap: "wrap", paddingLeft: 30 }]}>
                  {entry.joined ? (
                    <Button small onPress={() => open(entry)}>
                      Open
                    </Button>
                  ) : (
                    <Button
                      small
                      icon={LogIn}
                      busy={busy === entry.id}
                      onPress={() => void join(entry)}
                    >
                      Join
                    </Button>
                  )}
                  <Button small danger icon={Archive} onPress={() => setArchiving(entry)}>
                    Archive…
                  </Button>
                </View>
              </View>
            );
          })}
          {archived > 0 && (
            <Text style={s.small}>
              {archived} archived {archived === 1 ? "channel" : "channels"}, read-only.
            </Text>
          )}
        </View>
      )}
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
