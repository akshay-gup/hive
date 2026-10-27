import Check from "lucide-react-native/dist/esm/icons/check";
import ChevronDown from "lucide-react-native/dist/esm/icons/chevron-down";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { colors, fontSize, radius, shadow } from "./theme";

/**
 * One choice out of a few, as a button that shows the choice and opens a short list beneath it. For a
 * phone, where a row of tabs has no room beside the buttons.
 */
export function ViewMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = options.find((option) => option.id === value);
  return (
    // Above what follows it on the page, so the list is not drawn under the work.
    <View style={{ zIndex: 20 }}>
      {open && (
        <Pressable
          accessibilityLabel={`Close ${label}`}
          onPress={() => setOpen(false)}
          style={{ position: "absolute", top: -400, left: -400, width: 1600, height: 2400 }}
        />
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${chosen?.label ?? ""}. Choose another`}
        accessibilityState={{ expanded: open }}
        hitSlop={{ top: 4, bottom: 4 }}
        onPress={() => setOpen(!open)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          height: 36,
          paddingLeft: 16,
          paddingRight: 12,
          borderRadius: radius.pill,
          backgroundColor: colors.tile,
        }}
      >
        <Text style={{ fontSize: fontSize.body, fontWeight: "700", color: colors.text }}>
          {chosen?.label}
        </Text>
        <ChevronDown size={14} color={colors.muted} strokeWidth={2.5} />
      </Pressable>
      {open && (
        <View
          accessibilityRole="menu"
          style={{
            position: "absolute",
            top: 42,
            left: 0,
            minWidth: 170,
            padding: 6,
            borderRadius: 14,
            backgroundColor: colors.paper,
            borderWidth: 1,
            borderColor: colors.line,
            boxShadow: shadow.popover,
          }}
        >
          {options.map((option) => (
            <Pressable
              key={option.id}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: option.id === value }}
              onPress={() => {
                setOpen(false);
                onChange(option.id);
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
                style={{
                  fontSize: fontSize.body,
                  fontWeight: option.id === value ? "700" : "500",
                  color: option.id === value ? colors.text : colors.muted,
                }}
              >
                {option.label}
              </Text>
              {option.id === value && <Check size={15} color={colors.primary} strokeWidth={2.5} />}
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
