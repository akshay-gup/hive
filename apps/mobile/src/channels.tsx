import { Archive, Hash, Lock, Plus, RefreshCw, Search } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type ChannelView, ORCHESTRATOR_CHANNEL_ID } from "../../../packages/domain/src/agent";
import { useGuest } from "./access";
import { NewChannelForm } from "./channel-create";
import { channelsChanged, useOnChannelsChanged } from "./channel-events";
import { useHosted } from "./hosted/context";
import { useMuseThread } from "./threads";
import { Button, colors, Empty, ErrorNotice, Pending, radius, s } from "./ui";
import { useWorkspace } from "./workspace";

/**
 * Channel list for the menu sheet. Channels open directly as chat surfaces —
 * no thread needed. Threads auto-create from replies and @hive mentions and
 * are reached from their parent message's reply count. It lists the channels the person is in; the
 * public ones they are not in are found by browsing.
 */
export function ChannelsSection({ onClose }: { onClose: () => void }) {
  const { api, open } = useWorkspace();
  const hosted = useHosted();
  const guest = useGuest();
  const { selection, select } = useMuseThread();
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

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

  async function archive(channel: ChannelView) {
    setError("");
    setBusy(true);
    try {
      await api.request(`/api/agent/channels/${encodeURIComponent(channel.id)}/archive`, {});
      channelsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openChannel(channel: { id: string }) {
    select({ id: `channel:${channel.id}`, existing: true });
    onClose();
  }

  const userChannels = (channels ?? [])
    .filter(
      (channel) =>
        channel.id !== ORCHESTRATOR_CHANNEL_ID &&
        channel.status !== "archived" &&
        channel.joined !== false,
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <View style={{ gap: 12 }}>
      <View style={[s.between, { marginBottom: 4 }]}>
        <Text style={s.heading}>Channels</Text>
        <Button small onPress={() => void load()} icon={RefreshCw} disabled={loading}>
          Refresh
        </Button>
      </View>
      <ErrorNotice error={error} />
      {loading && !channels ? (
        <Pending height={120} />
      ) : userChannels.length === 0 ? (
        <Empty
          icon={Hash}
          title="No channels yet"
          detail={
            guest
              ? "You'll see a channel here when someone adds you to it."
              : "Create one to start chatting."
          }
        />
      ) : (
        userChannels.map((channel) => {
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
                {!guest && channel.status !== "archived" && (
                  <Button
                    small
                    danger
                    icon={Archive}
                    disabled={busy}
                    onPress={() => void archive(channel)}
                  >
                    Archive
                  </Button>
                )}
              </View>
            </View>
          );
        })
      )}
      {creating ? (
        <NewChannelForm
          onCancel={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            openChannel(created);
          }}
        />
      ) : (
        !guest && (
          <View style={{ gap: 12 }}>
            <Button primary icon={Plus} onPress={() => setCreating(true)}>
              New channel
            </Button>
            {hosted && (
              <Button
                icon={Search}
                onPress={() => {
                  onClose();
                  open({ type: "browseChannels" });
                }}
              >
                Browse channels
              </Button>
            )}
          </View>
        )
      )}
    </View>
  );
}
