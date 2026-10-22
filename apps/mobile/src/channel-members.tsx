import { LogOut, UserMinus, UserPlus, Users } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ChannelPeopleView } from "../../../packages/domain/src/agent";
import { useManagesAccess } from "./access";
import { channelsChanged } from "./channel-events";
import { Confirm } from "./confirm";
import { useHosted } from "./hosted/context";
import { roleLabel } from "./hosted/people-text";
import { useMuseThread } from "./threads";
import {
  Button,
  Card,
  Chip,
  colors,
  ErrorNotice,
  Field,
  Pending,
  SectionHeading,
  Sheet,
  s,
} from "./ui";
import { useWorkspace } from "./workspace";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What a channel being public or private means for who finds it, in a line. */
function standing(view: ChannelPeopleView, guest: boolean): string {
  if (view.archived) return "Archived. It is read-only, and no one is added or taken out.";
  // A guest did not find it: they were added to it.
  if (guest)
    return `${view.visibility === "private" ? "Private" : "Public"}. You can open it because you were added to it.`;
  if (view.visibility === "private") return "Private. Only the people in it can find it.";
  if (view.everyone) return "Public. Everyone in the workspace is in it.";
  return "Public. Anyone in the workspace can find it and join.";
}

/** The person's mark: the first letter of who they are. */
function Initial({ text }: { text: string }) {
  return (
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
      <Text style={[s.text, { fontWeight: "600" }]}>{text.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

/**
 * Who is in a channel: the people, with who manages it and who is a guest;
 * adding people, taking them out, joining and leaving; and, for a manager, whether the channel is
 * private. What each person may do is the server's say: the buttons are the ones it allows.
 */
export function ChannelMembersSheet({ channelId, name }: { channelId: string; name?: string }) {
  const { api, close } = useWorkspace();
  const hosted = useHosted();
  const me = hosted?.user.email.toLowerCase() ?? "";
  // Only an owner or admin can add someone who has not opened this workspace yet.
  const runs = useManagesAccess();
  const { mainId, select, retry } = useMuseThread();
  const [view, setView] = useState<ChannelPeopleView | null>(null);
  const [email, setEmail] = useState("");
  const [topic, setTopic] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const base = `/api/agent/channels/${encodeURIComponent(channelId)}`;

  const load = useCallback(async () => {
    try {
      const loaded = await api.request<ChannelPeopleView>(`${base}/members`);
      // A workspace that has not taken up the update answers in the old shape.
      if (!Array.isArray(loaded.people))
        throw new Error("This workspace is still updating. Try again in a few minutes.");
      setView(loaded);
      setTopic((was) => was ?? loaded.topic ?? "");
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, [api, base]);
  useEffect(() => {
    void load();
  }, [load]);

  /** Do one thing to the channel, and show it as it is after. */
  async function act(what: string, path: string, body: unknown, method = "POST") {
    setBusy(what);
    setError("");
    try {
      const result = await api.request<ChannelPeopleView | { left: true }>(path, body, method);
      channelsChanged();
      if ("left" in result) {
        // They can no longer open it: move them to somewhere they can.
        close();
        if (mainId) select({ id: mainId, existing: true });
        else retry();
        return;
      }
      setView(result);
      setTopic(result.topic ?? "");
      setEmail("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  const people = (what: string, body: { add?: string[]; remove?: string[] }) =>
    act(what, `${base}/members`, body);
  const managers = (what: string, body: { add?: string[]; remove?: string[] }) =>
    act(what, `${base}/managers`, body);
  const settings = (
    what: string,
    body: { visibility?: string; everyone?: boolean; topic?: string },
  ) => act(what, base, body, "PATCH");

  const you = view?.you;
  const typed = email.trim().toLowerCase();
  const named = new Set(view?.people.map((person) => person.email));

  return (
    <Sheet
      title={view ? `# ${view.name}` : name ? `# ${name}` : "Channel"}
      subtitle={view ? standing(view, hosted?.user.role === "guest") : undefined}
      onClose={close}
      tall
    >
      <ErrorNotice error={error} />
      {!view ? (
        error ? null : (
          <Pending height={120} />
        )
      ) : (
        <View style={{ gap: 28 }}>
          {you?.join && (
            <View style={s.row}>
              <Button
                primary
                busy={busy === "join"}
                onPress={() => void people("join", { add: [me] })}
              >
                Join channel
              </Button>
            </View>
          )}

          {(you?.topic || !!view.topic) && (
            <View style={{ gap: 10 }}>
              <SectionHeading title="Topic" />
              {you?.topic ? (
                <>
                  <Field
                    label="What this channel is for"
                    value={topic ?? ""}
                    onChangeText={setTopic}
                    placeholder="Add a line on what this channel is for"
                    maxLength={250}
                    returnKeyType="done"
                    onSubmitEditing={() => void settings("topic", { topic: topic ?? "" })}
                  />
                  <View style={s.row}>
                    <Button
                      small
                      busy={busy === "topic"}
                      disabled={(topic ?? "").trim() === view.topic}
                      onPress={() => void settings("topic", { topic: topic ?? "" })}
                    >
                      Save topic
                    </Button>
                  </View>
                </>
              ) : (
                <Text style={s.text}>{view.topic}</Text>
              )}
            </View>
          )}

          <View style={{ gap: 14 }}>
            <SectionHeading title={`People${view.everyone ? "" : ` · ${view.people.length}`}`} />
            {view.everyone && (
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
                  <Users size={17} color={colors.primaryText} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.text}>Everyone in the workspace</Text>
                  <Text style={s.small}>Guests are not, unless they are added below.</Text>
                </View>
              </View>
            )}
            {view.people.length === 0 && !view.everyone && (
              <Text style={s.muted}>No one is in this channel.</Text>
            )}
            {view.people.map((person) => {
              const yours = person.email === me;
              const label = person.name || person.email;
              const canManage = you?.manager && person.role !== "guest";
              const canRemove = !!you?.remove && !yours;
              return (
                <View key={person.email} style={{ gap: 8 }}>
                  <View style={[s.row, { gap: 12 }]}>
                    <Initial text={label} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.text} numberOfLines={1}>
                        {label}
                        {yours ? " (you)" : ""}
                      </Text>
                      {!!person.name && (
                        <Text style={s.small} numberOfLines={1}>
                          {person.email}
                        </Text>
                      )}
                    </View>
                    <View style={[s.row, { gap: 6, flexShrink: 0 }]}>
                      {person.manager && <Chip>Manager</Chip>}
                      {(person.role === "guest" ||
                        person.role === "owner" ||
                        person.role === "admin") && <Chip>{roleLabel[person.role]}</Chip>}
                    </View>
                  </View>
                  {(canManage || canRemove) && (
                    <View style={[s.row, { gap: 10, flexWrap: "wrap", paddingLeft: 48 }]}>
                      {canManage && (
                        <Button
                          small
                          busy={busy === `manager:${person.email}`}
                          onPress={() =>
                            void managers(
                              `manager:${person.email}`,
                              person.manager ? { remove: [person.email] } : { add: [person.email] },
                            )
                          }
                        >
                          {person.manager ? "Remove as manager" : "Make manager"}
                        </Button>
                      )}
                      {canRemove && (
                        <Confirm
                          icon={UserMinus}
                          label="Remove"
                          confirmLabel={`Remove ${label}`}
                          busy={busy === `remove:${person.email}`}
                          onConfirm={() =>
                            void people(`remove:${person.email}`, { remove: [person.email] })
                          }
                        />
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </View>

          {you?.add && (
            <View style={{ gap: 12 }}>
              <SectionHeading title="Add people" />
              {view.candidates.length === 0 && (
                <Text style={s.muted}>
                  {view.everyone
                    ? "Everyone in the workspace is in it. Add a guest by their address."
                    : "Everyone you can add is in it already."}
                </Text>
              )}
              {view.candidates.map((person) => (
                <View key={person.email} style={[s.between, { gap: 12 }]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.text} numberOfLines={1}>
                      {person.name || person.email}
                    </Text>
                    {!!(person.role === "guest" || person.name) && (
                      <Text style={s.small} numberOfLines={1}>
                        {[person.role === "guest" ? "Guest" : "", person.name ? person.email : ""]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    )}
                  </View>
                  <Button
                    small
                    icon={UserPlus}
                    busy={busy === `add:${person.email}`}
                    accessibilityLabel={`Add ${person.name || person.email} to this channel`}
                    onPress={() => void people(`add:${person.email}`, { add: [person.email] })}
                  >
                    Add
                  </Button>
                </View>
              ))}
              {runs && (
                <Card style={{ gap: 4 }}>
                  <Field
                    label="Or add someone by email address"
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
                      busy={busy === "add:typed"}
                      disabled={!typed || named.has(typed)}
                      onPress={() => void people("add:typed", { add: [typed] })}
                    >
                      Add
                    </Button>
                  </View>
                  <Text style={[s.small, { marginTop: 8 }]}>
                    A guest has to be invited from People first. They see only the channels they are
                    added to.
                  </Text>
                </Card>
              )}
            </View>
          )}

          {(you?.makePrivate || you?.makePublic || you?.setEveryone) && (
            <View style={{ gap: 12 }}>
              <SectionHeading title="Settings" />
              {you.makePrivate && (
                <View style={{ gap: 6 }}>
                  <Text style={s.small}>
                    A private channel is found only by the people in it. Only an owner or admin can
                    make it public again.
                  </Text>
                  <View style={s.row}>
                    <Confirm
                      label="Make private"
                      confirmLabel="Make this channel private"
                      busy={busy === "private"}
                      onConfirm={() => void settings("private", { visibility: "private" })}
                    />
                  </View>
                </View>
              )}
              {you.makePublic && (
                <View style={{ gap: 6 }}>
                  <Text style={s.small}>Anyone in the workspace could then find it and join.</Text>
                  <View style={s.row}>
                    <Confirm
                      label="Make public"
                      confirmLabel="Make this channel public"
                      busy={busy === "public"}
                      onConfirm={() => void settings("public", { visibility: "public" })}
                    />
                  </View>
                </View>
              )}
              {you.setEveryone && (
                <View style={{ gap: 6 }}>
                  <Text style={s.small}>
                    {view.everyone
                      ? "Everyone in the workspace is in this channel, and new people join it as they arrive. Taking everyone out keeps the people who are here."
                      : "Put everyone in the workspace in this channel, and everyone who joins later."}
                  </Text>
                  <View style={s.row}>
                    <Button
                      small
                      busy={busy === "everyone"}
                      onPress={() => void settings("everyone", { everyone: !view.everyone })}
                    >
                      {view.everyone ? "Stop adding everyone" : "Add everyone"}
                    </Button>
                  </View>
                </View>
              )}
            </View>
          )}

          {you?.leave && (
            <View style={s.row}>
              <Confirm
                icon={LogOut}
                label="Leave channel"
                confirmLabel="Leave this channel"
                busy={busy === "leave"}
                onConfirm={() => void people("leave", { remove: [me] })}
              />
            </View>
          )}
        </View>
      )}
    </Sheet>
  );
}
