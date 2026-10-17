import { Text, View } from "react-native";
import { colors, radius, s } from "../ui";

/** One line of good news or plain fact: a workspace was deleted, an account is gone. */
export function Notice({ text }: { text?: string }) {
  return text ? (
    <View
      accessibilityRole="alert"
      style={{
        alignSelf: "stretch",
        borderRadius: radius.md,
        paddingVertical: 10,
        paddingHorizontal: 14,
        backgroundColor: colors.successBg,
      }}
    >
      <Text style={[s.text, { color: colors.successText }]}>{text}</Text>
    </View>
  ) : null;
}
