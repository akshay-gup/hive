import { Text, View } from "react-native";
import { colors, fontFamily, fontSize, radius, s } from "./ui";

interface DateOnlyFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}
/** Date without a time (yyyy-mm-dd), using the browser's own date picker. */
export default function DateOnlyField({ label, value, onChange }: DateOnlyFieldProps) {
  return (
    <View style={[s.field, { minWidth: 0 }]}>
      <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{label}</Text>
      <input
        aria-label={label}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{
          border: `1px solid ${colors.line}`,
          borderRadius: radius.xl,
          padding: "12px 16px",
          fontSize: fontSize.heading,
          color: colors.text,
          background: colors.surface,
          fontFamily: fontFamily.web,
          // iPhone's date box has a width of its own and ignores the column it is in: this holds it to it.
          display: "block",
          width: "100%",
          minWidth: 0,
          maxWidth: "100%",
          boxSizing: "border-box",
          minHeight: 48,
          WebkitAppearance: "none",
          appearance: "none",
        }}
      />
    </View>
  );
}
