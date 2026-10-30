import Check from "lucide-react-native/dist/esm/icons/check";
import ChevronDown from "lucide-react-native/dist/esm/icons/chevron-down";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { colors, fontSize, radius, SearchField } from "./ui";

export interface PickOption {
  id: string;
  label: string;
  /** Shown after the label, and searched with it: an address beside a name. */
  detail?: string;
}

/**
 * One choice out of many, as a button that shows the choice and opens a searchable list under it. The
 * list is part of the page, not drawn over it, so it works inside a sheet that scrolls.
 */
export function PickMenu({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: PickOption[];
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const chosen = options.find((option) => option.id === value);
  const wanted = query.trim().toLowerCase();
  const shown = options.filter((option) =>
    `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(wanted),
  );
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${chosen?.label ?? ""}. Choose another`}
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={() => {
          setQuery("");
          setOpen(!open);
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
        <Text
          numberOfLines={1}
          style={{ flex: 1, fontSize: fontSize.body, fontWeight: "600", color: colors.text }}
        >
          {chosen?.label ?? ""}
        </Text>
        <ChevronDown size={16} color={colors.muted} strokeWidth={2.5} />
      </Pressable>
      {open && (
        <View
          style={{
            gap: 6,
            padding: 6,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.line,
            backgroundColor: colors.paper,
          }}
        >
          <SearchField
            label={`Search ${label}`}
            placeholder="Search"
            value={query}
            onChangeText={setQuery}
          />
          <ScrollView
            style={{ maxHeight: 220 }}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
          >
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
                  setOpen(false);
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
                  {option.detail ? `  ${option.detail}` : ""}
                </Text>
                {option.id === value && (
                  <Check size={15} color={colors.primary} strokeWidth={2.5} />
                )}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}
