import { Copy, LogOut, Share2, Trash2, UserMinus } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Platform, Share, Text, View } from "react-native";
import { type ChannelView, ORCHESTRATOR_CHANNEL_ID } from "../../../../packages/domain/src/agent";
import { channelsChanged } from "../channel-events";
import { channelsOfGuest, guestChannelsLine } from "../channel-text";
import { Confirm } from "../confirm";
import {
  Button,
  Card,
  CheckRow,
  Chip,
  colors,
  ErrorNotice,
  Field,
  Pending,
  SectionHeading,
  Segmented,
  Sheet,
  s,
} from "../ui";
import { useWorkspace } from "../workspace";
import { useHosted } from "./context";
import type { InvitedRole, InviteSummary, Member } from "./control-api";
import { describeInvite, guestHint, roleLabel } from "./people-text";
import { RemoveWorkspaceSheet } from "./remove-workspace";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The channels a guest can be put in: the ones that are open, that the person asking can see. */
const choosable = (channels: ChannelView[]) =>
  channels
    .filter((channel) => channel.id !== ORCHESTRATOR_CHANNEL_ID && channel.status !== "archived")
    .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Which channels a guest can open, as a line under their name, and a way to change it: a guest has
 * only the channels they are added to, so this is where an owner or admin chooses them.
 */
function GuestChannels({
  channels,
  email,
  onChanged,
}: {
  channels: ChannelView[];
  email: string;
  onChanged: () => Promise<void>;
}) {
  const { api } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const address = email.trim().toLowerCase();
  const inside = channelsOfGuest(channels, address);
  const has = new Set(inside.map((channel) => channel.id));
  async function toggle(channel: ChannelView) {
    setBusy(channel.id);
    setError("");
    try {
      await api.request(`/api/agent/channels/${encodeURIComponent(channel.id)}/members`, {
        [has.has(channel.id) ? "remove" : "add"]: [address],
      });
      channelsChanged();
      await onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <View style={{ paddingLeft: 48, gap: 6 }}>
      <Text style={s.small}>{guestChannelsLine(inside)}</Text>
      <View style={s.row}>
        <Button small onPress={() => setEditing((on) => !on)}>
          {editing ? "Done" : "Choose channels"}
        </Button>
      </View>
      {editing &&
        choosable(channels).map((channel) => (
          <CheckRow
            key={channel.id}
            label={
              channel.visibility === "private" ? `${channel.name} (private)` : `# ${channel.name}`
            }
            checked={has.has(channel.id)}
            onPress={() => {
              if (!busy) void toggle(channel);
            }}
          />
        ))}
      <ErrorNotice error={error} />
    </View>
  );
}

/**
 * Who is in the workspace and how to bring more people in: a link anyone can use, or an invitation
 * for one email address. Owners and admins invite; the owner decides who is an admin; anyone but
 * the owner can leave.
 */
export function PeopleSheet() {
  const hosted = useHosted();
  const { api, close, notify } = useWorkspace();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [link, setLink] = useState("");
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitedRole>("member");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const control = hosted?.control;
  const workspace = hosted?.workspace;
  const mine = workspace?.role;
  const manages = mine === "owner" || mine === "admin";
  const workspaceId = workspace?.id;

  const load = useCallback(async () => {
    if (!control || !workspaceId) return;
    try {
      setMembers(await control.members(workspaceId));
      if (manages) {
        setInvites(await control.invites(workspaceId));
        setChannels(await api.request<ChannelView[]>("/api/agent/channels").catch(() => []));
      }
    } catch (e) {
      setError(message(e));
    }
  }, [control, workspaceId, manages, api]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!hosted || !control || !workspace || !workspaceId) return null;

  /** Do one thing, show what went wrong if it did, and reload the lists. */
  async function run(what: string, action: () => Promise<void>) {
    setBusy(what);
    setError("");
    try {
      await action();
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  async function shareLink(text: string) {
    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(text);
        notify("Invitation link copied");
      } catch {
        setError("Could not copy it. Select the link and copy it yourself.");
      }
    } else {
      await Share.share({ message: text });
    }
  }

  return (
    <Sheet
      title={workspace.name}
      subtitle={`You are ${mine === "admin" ? "an admin" : mine === "owner" ? "the owner" : mine === "guest" ? "a guest" : "a member"}${members ? ` · ${members.length} ${members.length === 1 ? "person" : "people"}` : ""}`}
      onClose={close}
      tall
    >
      <ErrorNotice error={error} />

      {manages && (
        <View style={{ marginBottom: 24 }}>
          <SectionHeading title="Invite people" />
          <Card style={{ gap: 12 }}>
            <Text style={s.muted}>
              Anyone with the link can join as a member. It works for a week and up to 50 people.
            </Text>
            {link ? (
              <>
                <Field
                  label="Invitation link"
                  value={link}
                  editable={false}
                  selectTextOnFocus
                  compact
                />
                <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
                  <Button
                    primary
                    icon={Platform.OS === "web" ? Copy : Share2}
                    onPress={() => void shareLink(link)}
                  >
                    {Platform.OS === "web" ? "Copy link" : "Share link"}
                  </Button>
                </View>
              </>
            ) : (
              <View style={s.row}>
                <Button
                  primary
                  busy={busy === "link"}
                  onPress={() =>
                    void run("link", async () => {
                      const made = await control.createInvite(workspaceId, {});
                      setLink(made.link);
                    })
                  }
                >
                  Create invite link
                </Button>
              </View>
            )}
          </Card>
          <Card style={{ gap: 4, marginTop: 12 }}>
            <Field
              label="Or invite one person by email"
              value={email}
              onChangeText={setEmail}
              placeholder="colleague@example.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
            />
            <View style={{ marginBottom: 12, gap: 8 }}>
              <Segmented
                label="Role"
                value={inviteRole}
                onChange={setInviteRole}
                options={[
                  { id: "member", label: "Member" },
                  // Only the owner makes admins.
                  ...(mine === "owner" ? [{ id: "admin" as const, label: "Admin" }] : []),
                  { id: "guest", label: "Guest" },
                ]}
              />
              {inviteRole === "guest" && (
                <View style={{ gap: 2 }}>
                  <Text style={s.label}>Channels they can open</Text>
                  {choosable(channels).length === 0 ? (
                    <Text style={s.small}>
                      There are no channels yet. Make one first: a guest can open only the channels
                      they are added to.
                    </Text>
                  ) : (
                    choosable(channels).map((channel) => (
                      <CheckRow
                        key={channel.id}
                        label={
                          channel.visibility === "private"
                            ? `${channel.name} (private)`
                            : `# ${channel.name}`
                        }
                        checked={chosen.includes(channel.id)}
                        onPress={() =>
                          setChosen((now) =>
                            now.includes(channel.id)
                              ? now.filter((id) => id !== channel.id)
                              : [...now, channel.id],
                          )
                        }
                      />
                    ))
                  )}
                  <Text style={s.small}>{guestHint}</Text>
                </View>
              )}
            </View>
            <View style={s.row}>
              <Button
                busy={busy === "email"}
                disabled={!email.trim() || (inviteRole === "guest" && chosen.length === 0)}
                onPress={() =>
                  void run("email", async () => {
                    const to = email.trim();
                    const address = to.toLowerCase();
                    // A guest sees nothing until a channel names them, so the channels
                    // are chosen with the invitation and the guest is put in them first.
                    const put: string[] = [];
                    try {
                      if (inviteRole === "guest")
                        for (const id of chosen) {
                          await api.request(
                            `/api/agent/channels/${encodeURIComponent(id)}/members`,
                            { add: [address] },
                          );
                          put.push(id);
                        }
                      const made = await control.createInvite(workspaceId, {
                        email: to,
                        role: inviteRole,
                      });
                      setEmail("");
                      setChosen([]);
                      setLink(made.link);
                      channelsChanged();
                      notify(`Invitation made for ${to}. Share the link with them.`);
                    } catch (e) {
                      for (const id of put)
                        await api
                          .request(`/api/agent/channels/${encodeURIComponent(id)}/members`, {
                            remove: [address],
                          })
                          .catch(() => undefined);
                      throw e;
                    }
                  })
                }
              >
                Create invitation
              </Button>
            </View>
            <Text style={[s.small, { marginTop: 10 }]}>
              The link it makes works only for that address. Share it with them above.
            </Text>
          </Card>
          {invites.length > 0 && (
            <View style={{ marginTop: 12, gap: 8 }}>
              <Text style={s.label}>Waiting to be used</Text>
              {invites.map((invite) => {
                const { title, detail } = describeInvite(invite);
                return (
                  <View key={invite.id} style={[s.between, { gap: 12 }]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.text} numberOfLines={1}>
                        {title}
                      </Text>
                      <Text style={s.small}>{detail}</Text>
                    </View>
                    <Button
                      small
                      busy={busy === `revoke:${invite.id}`}
                      onPress={() =>
                        void run(`revoke:${invite.id}`, () =>
                          control.revokeInvite(workspaceId, invite.id),
                        )
                      }
                    >
                      Revoke
                    </Button>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}

      <SectionHeading title="People" />
      {!members ? (
        <Pending height={96} />
      ) : (
        <View style={{ gap: 14 }}>
          {members.map((person) => {
            const you = person.accountId === hosted.account.id;
            const canRemove =
              !you &&
              ((mine === "owner" && person.role !== "owner") ||
                (mine === "admin" && (person.role === "member" || person.role === "guest")));
            return (
              <View key={person.accountId} style={{ gap: 8 }}>
                <View style={[s.row, { gap: 12 }]}>
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 18,
                      backgroundColor: colors.primarySoft,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text style={[s.text, { fontWeight: "600" }]}>
                      {(person.name || person.email).slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.text} numberOfLines={1}>
                      {person.name}
                      {you ? " (you)" : ""}
                    </Text>
                    <Text style={s.small} numberOfLines={1}>
                      {person.email}
                    </Text>
                  </View>
                  <Chip>{roleLabel[person.role]}</Chip>
                </View>
                {person.role === "guest" && manages && (
                  <GuestChannels channels={channels} email={person.email} onChanged={load} />
                )}
                {(mine === "owner" && person.role !== "owner" && !you) || canRemove ? (
                  <View style={[s.row, { gap: 10, flexWrap: "wrap", paddingLeft: 48 }]}>
                    {mine === "owner" && person.role !== "owner" && (
                      <Segmented
                        label={`Role of ${person.name}`}
                        value={
                          person.role === "admin" || person.role === "guest"
                            ? person.role
                            : "member"
                        }
                        disabled={busy === `role:${person.accountId}`}
                        onChange={(role) =>
                          void run(`role:${person.accountId}`, () =>
                            control.setRole(workspaceId, person.accountId, role),
                          )
                        }
                        options={[
                          { id: "member", label: "Member" },
                          { id: "admin", label: "Admin" },
                          { id: "guest", label: "Guest" },
                        ]}
                      />
                    )}
                    {canRemove && (
                      <Confirm
                        icon={UserMinus}
                        label="Remove"
                        confirmLabel={`Remove ${person.name}`}
                        busy={busy === `remove:${person.accountId}`}
                        onConfirm={() =>
                          void run(`remove:${person.accountId}`, () =>
                            control.removeMember(workspaceId, person.accountId),
                          )
                        }
                      />
                    )}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      <View style={{ marginTop: 28, gap: 12 }}>
        <SectionHeading title="Danger zone" />
        {mine === "owner" ? (
          <>
            <Text style={s.muted}>
              The owner cannot leave. Delete the workspace instead, which removes it for everyone:
              its chat, files and agent. It cannot be undone.
            </Text>
            <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
              <Button small disabled icon={LogOut} onPress={() => {}}>
                Leave workspace
              </Button>
              <Button small danger icon={Trash2} onPress={() => setRemoving(true)}>
                Delete workspace…
              </Button>
            </View>
          </>
        ) : (
          <>
            <Text style={s.muted}>
              Leaving removes your access to its chat and files. Someone here can invite you back.
            </Text>
            <View style={s.row}>
              <Button small danger icon={LogOut} onPress={() => setRemoving(true)}>
                Leave workspace…
              </Button>
            </View>
          </>
        )}
      </View>

      {removing && (
        <RemoveWorkspaceSheet
          workspace={workspace}
          control={control}
          accountId={hosted.account.id}
          onClose={() => setRemoving(false)}
          onDone={(about) => {
            close();
            hosted.switchWorkspace(about);
          }}
        />
      )}
    </Sheet>
  );
}
