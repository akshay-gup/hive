import Archive from "lucide-react-native/dist/esm/icons/archive";
import Hash from "lucide-react-native/dist/esm/icons/hash";
import Lock from "lucide-react-native/dist/esm/icons/lock";
import Plus from "lucide-react-native/dist/esm/icons/plus";
import RefreshCw from "lucide-react-native/dist/esm/icons/refresh-cw";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type ChannelView, ORCHESTRATOR_CHANNEL_ID } from "../../../packages/domain/src/agent";
import { useGuest } from "./access";
import { ArchiveChannelSheet } from "./channel-archive";
import { useOnChannelsChanged } from "./channel-events";
import { useMuseThread } from "./threads";
import { Button, colors, Empty, ErrorNotice, Pending, radius, SearchField, s } from "./ui";
import { useWorkspace } from "./workspace";

/**
 * Channel list for the menu sheet. Channels open directly as chat surfaces —
 * no thread needed. Threads auto-create from replies and @hive mentions and
 * are reached from their parent message's reply count. It lists the channels the person is in; the
 * public ones they are not in are found by browsing.
 */
export function ChannelsSection({ onClose }: { onClose: () => void }) {
  const { api, open } = useWorkspace();
  const guest = useGuest();
  const { selection, select } = useMuseThread();
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [archiving, setArchiving] = useState<ChannelView | null>(null);
  const [find, setFind] = useState("");

  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      setChannels(await api.request<ChannelView[]>("/api/agent/channels"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  useOnChannelsChanged(() => void load());

  function openChannel(channel: { id: string }) {
    select({ id: `channel:${channel.id}`, existing: true });
    onClose();
  }

  const needle = find.trim().toLowerCase();
  const named = (channel: ChannelView) => !needle || channel.name.toLowerCase().includes(needle);
  const listed = (channels ?? []).filter(
    (channel) =>
      channel.id !== ORCHESTRATOR_CHANNEL_ID &&
      channel.status !== "archived" &&
      channel.kind !== "dm",
  );
  const userChannels = listed
    .filter((channel) => channel.joined !== false && named(channel))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Searching finds the public channels the person is not in as well; opening one offers to join.
  const unjoined = needle
    ? listed
        .filter(
          (channel) =>
            channel.joined === false && channel.visibility !== "private" && named(channel),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return (
    <View style={{ gap: 12 }}>
      <View style={[s.between, { marginBottom: 4 }]}>
        <Text style={s.heading}>Channels</Text>
        <Button small onPress={() => void load()} icon={RefreshCw} disabled={loading}>
          Refresh
        </Button>
      </View>
      <SearchField
        label="Find a conversation"
        placeholder="Find a conversation…"
        value={find}
        onChangeText={setFind}
      />
      <ErrorNotice error={error} />
      {loading && !channels ? (
        <Pending height={120} />
      ) : userChannels.length === 0 && unjoined.length === 0 ? (
        <Empty
          icon={Hash}
          title={needle ? "No channel by that name" : "No channels yet"}
          detail={
            needle
              ? "Try another word."
              : guest
                ? "You'll see a channel here when someone adds you to it."
                : "Create one to start chatting."
          }
        />
      ) : (
        <>
          {userChannels.map((channel) => {
            const isActive = selection.id === `channel:${channel.id}`;
            const Icon = channel.visibility === "private" ? Lock : Hash;
            return (
              <View
                key={channel.id}
                style={{
                  paddingVertical: 8,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.line,
                }}
              >
                <View style={[s.row, { gap: 12, alignItems: "center" }]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open channel: ${channel.name}`}
                    onPress={() => openChannel(channel)}
                    style={[
                      s.row,
                      {
                        flex: 1,
                        gap: 12,
                        alignItems: "center",
                        paddingVertical: 10,
                        paddingHorizontal: 12,
                        borderRadius: radius.lg,
                        backgroundColor: isActive ? colors.primarySoft : "transparent",
                      },
                    ]}
                  >
                    <Icon size={18} color={colors.text} />
                    <Text
                      style={[s.text, { flex: 1, fontWeight: isActive ? "600" : "400" }]}
                      numberOfLines={1}
                    >
                      {channel.name}
                    </Text>
                  </Pressable>
                  {!guest &&
                    channel.status !== "archived" &&
                    (channel.manager || (channel.visibility === "private" && channel.joined)) && (
                      <Button small danger icon={Archive} onPress={() => setArchiving(channel)}>
                        Archive…
                      </Button>
                    )}
                </View>
              </View>
            );
          })}
          {unjoined.length > 0 && (
            <>
              <Text style={[s.small, { paddingTop: 8 }]}>Not joined</Text>
              {unjoined.map((channel) => (
                <Pressable
                  key={channel.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Look at channel: ${channel.name}`}
                  onPress={() => openChannel(channel)}
                  style={[
                    s.row,
                    { gap: 12, alignItems: "center", paddingVertical: 10, paddingHorizontal: 12 },
                  ]}
                >
                  <Hash size={18} color={colors.text} />
                  <Text style={[s.text, { flex: 1 }]} numberOfLines={1}>
                    {channel.name}
                  </Text>
                </Pressable>
              ))}
            </>
          )}
        </>
      )}
      {archiving && (
        <ArchiveChannelSheet
          id={archiving.id}
          name={archiving.name}
          onClose={() => setArchiving(null)}
          onArchived={() => setArchiving(null)}
        />
      )}
      {!guest && (
        <Button
          primary
          icon={Plus}
          onPress={() => {
            onClose();
            open({ type: "newChannel" });
          }}
        >
          New channel
        </Button>
      )}
    </View>
  );
}
