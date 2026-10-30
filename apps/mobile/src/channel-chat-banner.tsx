import FolderOpen from "lucide-react-native/dist/esm/icons/folder-open";
import Lock from "lucide-react-native/dist/esm/icons/lock";
import User from "lucide-react-native/dist/esm/icons/user";
import Users from "lucide-react-native/dist/esm/icons/users";
import { useCallback, useEffect, useState } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import type { ChannelView } from "../../../packages/domain/src/agent";
import { channelsChanged, useOnChannelsChanged } from "./channel-events";
import { useHosted } from "./hosted/context";
import { Button, colors, fontSize, IconButton, s } from "./ui";
import { useWorkspace } from "./workspace";

/** The line across the top of a channel: its name, who is in it, its files, and a way to join. */
export function ChannelChatBanner({ channelId }: { channelId: string }) {
  const { api, open } = useWorkspace();
  // Who is in a channel is a hosted workspace's: elsewhere there are no people to be in it.
  const hosted = useHosted();
  const me = hosted?.user.email.toLowerCase() ?? "";
  // On a phone the header has little room: the files are an icon, and the title keeps the rest.
  const narrow = useWindowDimensions().width < 600;
  const [channel, setChannel] = useState<ChannelView | null>(null);
  const [joining, setJoining] = useState(false);
  const load = useCallback(async () => {
    try {
      const channels = await api.request<ChannelView[]>("/api/agent/channels");
      setChannel(channels.find((c) => c.id === channelId) ?? null);
    } catch {
      setChannel(null);
    }
  }, [api, channelId]);
  useEffect(() => {
    void load();
  }, [load]);
  useOnChannelsChanged(() => void load());
  const name = channel?.name ?? null;
  async function join() {
    setJoining(true);
    try {
      await api.request(`/api/agent/channels/${encodeURIComponent(channelId)}/members`, {
        add: [me],
      });
      channelsChanged();
    } catch {
      // The members sheet says why, if they open it.
    } finally {
      setJoining(false);
    }
  }
  return (
    <View style={[s.row, { gap: 12 }]}>
      <View style={[s.row, { gap: 12, flexShrink: 1 }]}>
        {channel?.kind === "dm" ? (
          <User size={16} color={colors.muted} />
        ) : (
          channel?.visibility === "private" && <Lock size={16} color={colors.muted} />
        )}
        <Text style={[s.heading, { fontSize: fontSize.title, flexShrink: 1 }]} numberOfLines={1}>
          {channel?.visibility === "private" ? "" : "# "}
          {name ?? "channel"}
        </Text>
        {/* The topic is the channel's own line; a phone has no room for it here, so it is in the people sheet. */}
        {!narrow && !!channel?.topic && (
          <Text style={[s.small, { flexShrink: 2 }]} numberOfLines={1}>
            {channel.topic}
          </Text>
        )}
      </View>
      <View style={{ flex: 1 }} />
      {hosted && channel?.joined === false && (
        <Button
          small
          primary
          busy={joining}
          accessibilityLabel="Join channel"
          onPress={() => void join()}
        >
          {narrow ? "Join" : "Join channel"}
        </Button>
      )}
      {hosted && channel?.kind !== "dm" && (
        <Button
          small
          icon={Users}
          accessibilityLabel="Who is in this channel"
          onPress={() => open({ type: "channelMembers", channelId, name: name ?? undefined })}
        >
          {channel && channel.everyone !== false && channel.visibility !== "private"
            ? "People"
            : String((channel?.members ?? []).length)}
        </Button>
      )}
      {narrow ? (
        <IconButton
          icon={FolderOpen}
          label="Files in this channel"
          onPress={() => open({ type: "channelFiles", channelId, name: name ?? undefined })}
        />
      ) : (
        <Button
          small
          icon={FolderOpen}
          accessibilityLabel="Files in this channel"
          onPress={() => open({ type: "channelFiles", channelId, name: name ?? undefined })}
        >
          Files
        </Button>
      )}
    </View>
  );
}
