import ChevronDown from "lucide-react-native/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react-native/dist/esm/icons/chevron-right";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { colors, s } from "./ui";

/**
 * A row that opens to show more: a title, a line under it, and an arrow. What is in it is out of the
 * way until it is wanted, so a long sheet stays short.
 */
export function Disclosure({
  title,
  detail,
  danger,
  children,
}: {
  title: string;
  detail?: string;
  danger?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Arrow = open ? ChevronDown : ChevronRight;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.line }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        onPress={() => setOpen((now) => !now)}
        style={[s.row, { gap: 12, paddingVertical: 14 }]}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.text, danger && { color: colors.danger }]}>{title}</Text>
          {!!detail && <Text style={s.small}>{detail}</Text>}
        </View>
        <Arrow size={18} color={colors.subtle} />
      </Pressable>
      {open && <View style={{ paddingBottom: 16, gap: 12 }}>{children}</View>}
    </View>
  );
}
