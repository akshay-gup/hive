import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Pressable, Text, type TextStyle, View } from "react-native";
import { type Mentionable, splitMentions } from "../../../packages/domain/src/mentions";
import { useOnChannelsChanged } from "./channel-events";
import { useHosted } from "./hosted/context";
import { Card, colors, fontSize, radius, s } from "./ui";
import { useWorkspace } from "./workspace";

/**
 * The people who can be mentioned in a channel, by the handle typed after the `@`. They come from
 * the workspace: those who can open the channel, and no one it is closed to. Nothing is asked of
 * a workspace that has no people of its own, or of a chat that is not in a channel.
 */
export function useMentionable(channelId: string | null, threadId?: string): Mentionable[] {
  const { api } = useWorkspace();
  const hosted = useHosted();
  const [people, setPeople] = useState<Mentionable[]>([]);
  const [channel, setChannel] = useState<string | null>(channelId);
  const [stamp, setStamp] = useState(0);
  useOnChannelsChanged(() => setStamp((n) => n + 1));
  // A thread is in a channel, and its people are that channel's.
  useEffect(() => {
    let live = true;
    if (channelId || !threadId || !hosted) {
      setChannel(channelId);
      return;
    }
    api
      .request<{ channelId: string }>(`/api/agent/threads/${encodeURIComponent(threadId)}/channel`)
      .then((binding) => live && setChannel(binding.channelId))
      .catch(() => live && setChannel(null));
    return () => {
      live = false;
    };
  }, [api, channelId, threadId, hosted]);
  useEffect(() => {
    let live = true;
    if (!hosted || !channel) {
      setPeople([]);
      return;
    }
    api
      .request<Mentionable[]>(`/api/agent/channels/${encodeURIComponent(channel)}/mentionable`)
      .then((list) => live && setPeople(Array.isArray(list) ? list : []))
      // A workspace that has not taken up the update has no such list: no one to offer.
      .catch(() => live && setPeople([]));
    return () => {
      live = false;
    };
  }, [api, hosted, channel, stamp]);
  return people;
}

/** What each handle is called (lowercase handle or address to name), so a mention reads as the person's name. */
const MentionNames = createContext<ReadonlyMap<string, string>>(new Map());

/** Draws the mentions in what is inside by the names of the people they name. */
export function MentionNamesProvider({
  people,
  children,
}: {
  people: Mentionable[];
  children: React.ReactNode;
}) {
  const names = useMemo(() => {
    const map = new Map<string, string>([["hive", "Hive"]]);
    for (const person of people) {
      const name = person.name.trim();
      if (!name) continue;
      map.set(person.handle.toLowerCase(), name);
      map.set(person.email.toLowerCase(), name);
    }
    return map;
  }, [people]);
  return <MentionNames.Provider value={names}>{children}</MentionNames.Provider>;
}

/** Some text, with the mentions in it that name someone set apart. */
export function MentionText({
  text,
  handles,
  style,
}: {
  text: string;
  /** The handles that name someone here. */
  handles: string[];
  style?: TextStyle | TextStyle[];
}) {
  const pieces = splitMentions(text, handles, useContext(MentionNames));
  return (
    <Text selectable style={style}>
      {pieces.map((piece, index) =>
        piece.mention ? (
          <Text
            // The pieces of one text are in a fixed order.
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed order
            key={index}
            style={{
              color: colors.primaryText,
              fontWeight: "600",
              backgroundColor: colors.primarySoft,
            }}
          >
            {piece.text}
          </Text>
        ) : (
          piece.text
        ),
      )}
    </Text>
  );
}

export interface MentionOption {
  handle: string;
  name: string;
  /** A word beside the name: what the option is, such as the agent. */
  note?: string;
}

/** The people to choose from while an `@` is being typed, above the message box. */
export function MentionPicker({
  options,
  selected,
  onPick,
}: {
  options: MentionOption[];
  selected: number;
  onPick: (option: MentionOption) => void;
}) {
  if (!options.length) return null;
  return (
    <Card style={{ marginBottom: 8, padding: 6, gap: 2 }}>
      {options.map((option, index) => (
        <Pressable
          key={option.handle}
          accessibilityRole="menuitem"
          accessibilityLabel={`Mention ${option.name}`}
          accessibilityState={{ selected: index === selected }}
          // Picking must not take the focus from the message box.
          onPressIn={(event) => event.preventDefault?.()}
          onPress={() => onPick(option)}
          style={[
            s.row,
            {
              gap: 10,
              paddingVertical: 7,
              paddingHorizontal: 10,
              borderRadius: radius.md,
              backgroundColor: index === selected ? colors.primarySoft : "transparent",
            },
          ]}
        >
          <Text style={[s.text, { fontWeight: "600" }]} numberOfLines={1}>
            {option.name}
          </Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: fontSize.caption, color: colors.muted }} numberOfLines={1}>
              @{option.handle}
              {option.note ? ` · ${option.note}` : ""}
            </Text>
          </View>
        </Pressable>
      ))}
    </Card>
  );
}
