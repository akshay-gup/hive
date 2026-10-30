import Check from "lucide-react-native/dist/esm/icons/check";
import ChevronDown from "lucide-react-native/dist/esm/icons/chevron-down";
import { useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { colors, fontSize, radius, SearchField, shadow } from "./ui";

export interface PickOption {
  id: string;
  label: string;
  /** Shown small at the end of the row, and searched with the label: an address beside a name. */
  detail?: string;
}

/**
 * One choice out of many, as a button that shows the choice and opens a searchable list over the page,
 * under the button (or above it, where there is no room below). The list is drawn in a layer of its own,
 * so a sheet that scrolls does not cut it off.
 */
export function PickMenu({
  label,
  value,
  options,
  onChange,
  disabled,
  placeholder = "",
  caption,
}: {
  label: string;
  value: string;
  /** What the button says while nothing is chosen. */
  placeholder?: string;
  /** A small line above the choice, inside the button. */
  caption?: string;
  options: PickOption[];
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [spot, setSpot] = useState<{ x: number; y: number; width: number; height: number } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const button = useRef<View>(null);
  const { height: screen } = useWindowDimensions();
  const open = spot !== null;
  const close = () => setSpot(null);
  const chosen = options.find((option) => option.id === value);
  const wanted = query.trim().toLowerCase();
  const shown = options.filter((option) =>
    `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(wanted),
  );
  const room = spot ? screen - spot.y - spot.height - 16 : 0;
  const above = !!spot && room < 220 && spot.y > room;
  const listHeight = spot ? Math.min(300, (above ? spot.y - 16 : room) - 8) : 0;
  return (
    <View>
      <Pressable
        ref={button}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${chosen?.label ?? placeholder}. Choose another`}
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={() => {
          setQuery("");
          button.current?.measureInWindow((x, y, width, height) =>
            setSpot({ x, y, width, height }),
          );
        }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          minHeight: 40,
          paddingHorizontal: 14,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: open ? colors.primary : colors.lineStrong,
          backgroundColor: colors.paper,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          {!!caption && (
            <Text style={{ fontSize: fontSize.small, color: colors.muted }}>{caption}</Text>
          )}
          <Text
            numberOfLines={1}
            style={{ fontSize: fontSize.body, fontWeight: "600", color: colors.text }}
          >
            {chosen?.label ?? placeholder}
          </Text>
        </View>
        <ChevronDown size={16} color={colors.muted} strokeWidth={2.5} />
      </Pressable>
      {spot && (
        <Modal transparent animationType="none" visible onRequestClose={close}>
          <Pressable accessibilityLabel={`Close ${label}`} onPress={close} style={{ flex: 1 }}>
            <Pressable
              accessibilityRole="menu"
              // A tap in the list is not a tap outside it.
              onPress={() => undefined}
              style={{
                position: "absolute",
                left: spot.x,
                width: Math.max(spot.width, 240),
                ...(above ? { bottom: screen - spot.y + 4 } : { top: spot.y + spot.height + 4 }),
                maxHeight: listHeight,
                gap: 6,
                padding: 6,
                borderRadius: radius.lg,
                borderWidth: 1,
                borderColor: colors.line,
                backgroundColor: colors.paper,
                boxShadow: shadow.popover,
              }}
            >
              <SearchField
                label={`Search ${label}`}
                placeholder="Search"
                value={query}
                onChangeText={setQuery}
              />
              <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }}>
                {shown.length === 0 && (
                  <Text style={{ padding: 12, fontSize: fontSize.body, color: colors.muted }}>
                    No match
                  </Text>
                )}
                {shown.map((option) => (
                  <Pressable
                    key={option.id}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: option.id === value }}
                    onPress={() => {
                      close();
                      if (option.id !== value) onChange(option.id);
                    }}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderRadius: 9,
                      backgroundColor: option.id === value ? colors.selected : "transparent",
                    }}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        flex: 1,
                        fontSize: fontSize.body,
                        fontWeight: option.id === value ? "700" : "500",
                        color: option.id === value ? colors.text : colors.muted,
                      }}
                    >
                      {option.label}
                    </Text>
                    {!!option.detail && option.id !== value && (
                      <Text
                        numberOfLines={1}
                        style={{
                          flexShrink: 1,
                          maxWidth: "50%",
                          fontSize: fontSize.small,
                          color: colors.muted,
                        }}
                      >
                        {option.detail}
                      </Text>
                    )}
                    {option.id === value && (
                      <Check size={15} color={colors.primary} strokeWidth={2.5} />
                    )}
                  </Pressable>
                ))}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}
