import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ChannelView, NotificationPrefs } from "../../../packages/domain/src/agent";
import { channelsChanged } from "./channel-events";
import { Button, CheckRow, ErrorNotice, Pending, SectionHeading, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

const PATH = "/api/agent/notification-prefs";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What this person has asked to be told about, and a way to change it. */
export function usePrefs() {
  const { api } = useWorkspace();
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .request<NotificationPrefs>(PATH)
      .then(setPrefs)
      .catch((e) => setError(message(e)));
  }, [api]);
  /** Say what changed: what is not named stays as it was. Told to the lists of channels, which show a mute. */
  const change = useCallback(
    async (patch: Partial<NotificationPrefs>) => {
      setBusy(true);
      setError("");
      try {
        setPrefs(await api.request<NotificationPrefs>(PATH, patch, "PUT"));
        channelsChanged();
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );
  return { prefs, change, error, busy };
}

/**
 * Notifications, as the person wants them: whether a mention or the end of work they asked for tells
 * them, and the channels they have muted. Their own: no one else's notifications change with them.
 */
export function NotificationSettingsSheet({
  onClose,
  onClearAll,
}: {
  onClose: () => void;
  /** Where the list of notifications is shown, a way to remove every one of them. */
  onClearAll?: () => void;
}) {
  const { api } = useWorkspace();
  const { prefs, change, error, busy } = usePrefs();
  const [channels, setChannels] = useState<ChannelView[]>([]);
  useEffect(() => {
    api
      .request<ChannelView[]>("/api/agent/channels")
      .then(setChannels)
      .catch(() => undefined);
  }, [api]);
  const names = new Map(channels.map((channel) => [channel.id, channel.name]));
  return (
    <Sheet
      title="Notifications"
      subtitle="What you are told about. Only you see these choices."
      onClose={onClose}
    >
      <View style={{ gap: 12 }}>
        <ErrorNotice error={error} />
        {!prefs ? (
          <Pending height={96} />
        ) : (
          <>
            <View>
              <CheckRow
                label="When someone mentions me"
                checked={prefs.mentions}
                onPress={() => void change({ mentions: !prefs.mentions })}
              />
              <CheckRow
                label="When work I asked for is done, or needs me"
                checked={prefs.work}
                onPress={() => void change({ work: !prefs.work })}
              />
            </View>
            <SectionHeading title="Muted channels" />
            {prefs.muted.length === 0 ? (
              <Text style={s.muted}>
                None. Mute a channel from its people list, and it shows no unread mark and tells you
                nothing.
              </Text>
            ) : (
              prefs.muted.map((id) => (
                <View key={id} style={[s.between, { gap: 12 }]}>
                  <Text style={[s.text, { flex: 1 }]} numberOfLines={1}>
                    {names.get(id) ?? id}
                  </Text>
                  <Button
                    small
                    disabled={busy}
                    onPress={() =>
                      void change({ muted: prefs.muted.filter((muted) => muted !== id) })
                    }
                  >
                    Unmute
                  </Button>
                </View>
              ))
            )}
            <Text style={s.small}>
              What you turn off is hidden, not deleted: turn it back on and it is there again.
            </Text>
            {onClearAll && (
              <>
                <SectionHeading title="Your list" />
                <Text style={s.muted}>
                  Remove every notification from your list, read or not. It cannot be undone.
                </Text>
                <Button small onPress={onClearAll} style={{ alignSelf: "flex-start" }}>
                  Clear all notifications
                </Button>
              </>
            )}
          </>
        )}
      </View>
    </Sheet>
  );
}
