import type { Trash2 } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { Button, s } from "./ui";

/** A button for something that is hard to undo: the first press asks, and the second does it. */
export function Confirm({
  label,
  confirmLabel,
  icon,
  busy,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  icon?: typeof Trash2;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed)
    return (
      <Button small icon={icon} danger onPress={() => setArmed(true)}>
        {label}
      </Button>
    );
  return (
    <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
      <Button small danger busy={busy} onPress={onConfirm}>
        {confirmLabel}
      </Button>
      <Button small disabled={busy} onPress={() => setArmed(false)}>
        Cancel
      </Button>
    </View>
  );
}
