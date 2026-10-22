import { Hash, Search } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type ChannelView, ORCHESTRATOR_CHANNEL_ID } from "../../../packages/domain/src/agent";
import { channelsChanged, useOnChannelsChanged } from "./channel-events";
import { peopleIn } from "./channel-text";
import { useHosted } from "./hosted/context";
import { useMuseThread } from "./threads";
import { Button, Chip, colors, Empty, ErrorNotice, Field, Pending, radius, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Every public channel in the workspace, to look in and to join, as Slack's "Browse channels". A
 * private channel is not here: it is found only by the people in it, who have it in their list.
 */
export function BrowseChannelsSheet() {
  const { api, close } = useWorkspace();
  const me = useHosted()?.user.email.toLowerCase() ?? "";
  const { select } = useMuseThread();
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setChannels(await api.request<ChannelView[]>("/api/agent/channels"));
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  useOnChannelsChanged(() => void load());

  async function join(channel: ChannelView) {
    setBusy(channel.id);
    setError("");
    try {
      await api.request(`/api/agent/channels/${encodeURIComponent(channel.id)}/members`, {
        add: [me],
      });
      channelsChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }

  const needle = query.trim().toLowerCase();
  const listed = (channels ?? [])
    .filter(
      (channel) =>
        channel.id !== ORCHESTRATOR_CHANNEL_ID &&
        channel.status !== "archived" &&
        channel.visibility !== "private" &&
        (!needle || channel.name.toLowerCase().includes(needle)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Sheet
      title="Browse channels"
      subtitle="The public channels in this workspace"
      onClose={close}
      tall
    >
      <ErrorNotice error={error} />
      <Field
        label="Search channels"
        value={query}
        onChangeText={setQuery}
        placeholder="Find a channel"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {!channels ? (
        error ? null : (
          <Pending height={120} />
        )
      ) : listed.length === 0 ? (
        <Empty
          icon={Search}
          title={needle ? "No channel by that name" : "No public channels yet"}
          detail={needle ? "Try another word." : "Make one from the plus beside Channels."}
        />
      ) : (
        <View style={{ gap: 4 }}>
          {listed.map((channel) => (
            <View
              key={channel.id}
              style={[
                s.row,
                {
                  gap: 12,
                  alignItems: "center",
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.line,
                },
              ]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Look at channel: ${channel.name}`}
                onPress={() => {
                  close();
                  select({ id: `channel:${channel.id}`, existing: true });
                }}
                style={[s.row, { flex: 1, minWidth: 0, gap: 12, borderRadius: radius.md }]}
              >
                <Hash size={17} color={colors.muted} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.text} numberOfLines={1}>
                    {channel.name}
                  </Text>
                  <Text style={s.small} numberOfLines={1}>
                    {peopleIn(channel)}
                  </Text>
                </View>
              </Pressable>
              {channel.joined === false ? (
                <Button
                  small
                  busy={busy === channel.id}
                  accessibilityLabel={`Join channel: ${channel.name}`}
                  onPress={() => void join(channel)}
                >
                  Join
                </Button>
              ) : (
                <Chip>Joined</Chip>
              )}
            </View>
          ))}
        </View>
      )}
    </Sheet>
  );
}
