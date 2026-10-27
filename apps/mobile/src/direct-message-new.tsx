import User from "lucide-react-native/dist/esm/icons/user";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ChannelView, DirectMessagePerson } from "../../../packages/domain/src/agent";
import { channelsChanged } from "./channel-events";
import { useMuseThread } from "./threads";
import { colors, ErrorNotice, Pending, radius, SearchField, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

/**
 * The window for a new direct message: the people of the workspace, to find by name or address. Picking
 * one opens the conversation with them, which is made the first time and found again after.
 */
export function NewMessageSheet() {
  const { api, close } = useWorkspace();
  const { select } = useMuseThread();
  const [people, setPeople] = useState<DirectMessagePerson[] | null>(null);
  const [find, setFind] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api
      .request<DirectMessagePerson[]>("/api/agent/dms/people")
      .then((found) => live && setPeople(found))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [api]);

  async function start(person: DirectMessagePerson) {
    if (busy) return;
    setBusy(person.email);
    setError("");
    try {
      const made = await api.request<ChannelView>("/api/agent/dms", { email: person.email });
      channelsChanged();
      close();
      select({ id: `channel:${made.id}`, existing: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy("");
    }
  }

  const needle = find.trim().toLowerCase();
  const shown = (people ?? []).filter(
    (person) => !needle || `${person.name} ${person.email}`.toLowerCase().includes(needle),
  );

  return (
    <Sheet title="New message" narrow onClose={close}>
      <View style={{ gap: 12 }}>
        <SearchField
          label="Find a person"
          placeholder="Find a person…"
          value={find}
          onChangeText={setFind}
        />
        <ErrorNotice error={error} />
        {!people && !error ? (
          <Pending height={120} />
        ) : shown.length === 0 ? (
          <Text style={s.small}>
            {needle ? "No one by that name." : "There is no one to message yet."}
          </Text>
        ) : (
          shown.map((person) => (
            <Pressable
              key={person.email}
              accessibilityRole="button"
              accessibilityLabel={`Message ${person.name || person.email}`}
              disabled={!!busy}
              onPress={() => void start(person)}
              style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                s.row,
                {
                  gap: 12,
                  alignItems: "center",
                  paddingVertical: 10,
                  paddingHorizontal: 12,
                  borderRadius: radius.lg,
                  opacity: busy && busy !== person.email ? 0.5 : 1,
                  backgroundColor: pressed || hovered ? colors.surfaceHover : "transparent",
                },
              ]}
            >
              <User size={18} color={colors.text} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.text} numberOfLines={1}>
                  {person.name || person.email}
                  {person.you ? " (you)" : ""}
                </Text>
                {!!person.name && (
                  <Text style={s.small} numberOfLines={1}>
                    {person.email}
                  </Text>
                )}
              </View>
            </Pressable>
          ))
        )}
      </View>
    </Sheet>
  );
}
