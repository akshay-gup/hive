import ChevronRight from "lucide-react-native/dist/esm/icons/chevron-right";
import { Pressable, Text, View } from "react-native";
import { colors, s } from "./ui";

/** A row that opens a screen of its own in the sheet: a title, a line under it, and an arrow. */
export function NavRow({
  title,
  detail,
  danger,
  onPress,
}: {
  title: string;
  detail?: string;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={[
        s.row,
        { gap: 12, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.line },
      ]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.text, danger && { color: colors.danger }]}>{title}</Text>
        {!!detail && <Text style={s.small}>{detail}</Text>}
      </View>
      <ChevronRight size={18} color={colors.subtle} />
    </Pressable>
  );
}
