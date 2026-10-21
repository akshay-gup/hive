import { UserMinus, UserPlus } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button, Card, ErrorNotice, Field, Pending, SectionHeading, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

interface Access {
  /** The guests added to the channel, by email address. */
  members: string[];
  /** The guests who have come in to this workspace, whoever they are added to. */
  guests: { email: string; name: string }[];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Who a channel is open to beyond the team. Members and admins can open every channel, so this is
 * the list of guests: a guest can open only the channels that name them.
 */
export function ChannelAccessSheet({ channelId, name }: { channelId: string; name?: string }) {
  const { api, close } = useWorkspace();
  const [access, setAccess] = useState<Access | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = `/api/agent/channels/${encodeURIComponent(channelId)}/members`;

  const load = useCallback(async () => {
    try {
      setAccess(await api.request<Access>(path));
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, [api, path]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(members: string[]) {
    setBusy(true);
    setError("");
    try {
      setAccess(await api.request<Access>(path, { members }, "PUT"));
      setEmail("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const nameOf = (address: string) => access?.guests.find((guest) => guest.email === address)?.name;
  const typed = email.trim().toLowerCase();
  const candidates = access?.guests.filter((guest) => !access.members.includes(guest.email)) ?? [];

  return (
    <Sheet
      title={name ? `Who can open # ${name}` : "Who can open this channel"}
      subtitle="Members and admins can open every channel. A guest can open only the channels they are added to."
      onClose={close}
    >
      <ErrorNotice error={error} />
      {!access ? (
        error ? null : (
          <Pending height={96} />
        )
      ) : (
        <View style={{ gap: 24 }}>
          <View style={{ gap: 12 }}>
            <SectionHeading title="Guests in this channel" />
            {access.members.length === 0 ? (
              <Text style={s.muted}>No guests yet. Only the team can open this channel.</Text>
            ) : (
              access.members.map((address) => (
                <View key={address} style={[s.between, { gap: 12 }]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.text} numberOfLines={1}>
                      {nameOf(address) || address}
                    </Text>
                    {!!nameOf(address) && (
                      <Text style={s.small} numberOfLines={1}>
                        {address}
                      </Text>
                    )}
                  </View>
                  <Button
                    small
                    icon={UserMinus}
                    disabled={busy}
                    accessibilityLabel={`Remove ${nameOf(address) || address} from this channel`}
                    onPress={() => void save(access.members.filter((m) => m !== address))}
                  >
                    Remove
                  </Button>
                </View>
              ))
            )}
          </View>
          <View style={{ gap: 12 }}>
            <SectionHeading title="Add a guest" />
            {candidates.map((guest) => (
              <View key={guest.email} style={[s.between, { gap: 12 }]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.text} numberOfLines={1}>
                    {guest.name || guest.email}
                  </Text>
                  {!!guest.name && (
                    <Text style={s.small} numberOfLines={1}>
                      {guest.email}
                    </Text>
                  )}
                </View>
                <Button
                  small
                  icon={UserPlus}
                  disabled={busy}
                  accessibilityLabel={`Add ${guest.name || guest.email} to this channel`}
                  onPress={() => void save([...access.members, guest.email])}
                >
                  Add
                </Button>
              </View>
            ))}
            <Card style={{ gap: 4 }}>
              <Field
                label="Or add one by email address"
                value={email}
                onChangeText={setEmail}
                placeholder="client@example.com"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                autoComplete="email"
              />
              <View style={s.row}>
                <Button
                  busy={busy}
                  disabled={!typed || access.members.includes(typed)}
                  onPress={() => void save([...access.members, typed])}
                >
                  Add guest
                </Button>
              </View>
            </Card>
            <Text style={s.small}>
              Invite someone as a guest from People first. They see nothing until you add them to a
              channel here.
            </Text>
          </View>
        </View>
      )}
    </Sheet>
  );
}
