import { Text, View } from "react-native";
import type { TaskPriority } from "../../../packages/domain/src/agent";
import { authorTint } from "./theme";
import { colors } from "./ui";

const priorityLevel: Record<TaskPriority, number> = { low: 1, medium: 2, high: 3, urgent: 3 };
const priorityColor: Record<TaskPriority, string> = {
  low: colors.neutral,
  medium: colors.primary,
  high: colors.warning,
  urgent: colors.danger,
};

/** Three small bars, as many filled as the priority has levels. */
export function PriorityMark({ priority }: { priority: TaskPriority }) {
  return (
    <View
      accessibilityLabel={`Priority: ${priority}`}
      style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 12 }}
    >
      {[1, 2, 3].map((level) => (
        <View
          key={level}
          style={{
            width: 3,
            height: 4 + level * 3,
            borderRadius: 1,
            backgroundColor:
              level <= priorityLevel[priority] ? priorityColor[priority] : colors.line,
          }}
        />
      ))}
    </View>
  );
}

/** The person who asked for the work, as an initial in their own tint. */
export function Initial({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: authorTint(name),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{ fontSize: size * 0.5, fontWeight: "700", color: colors.text, lineHeight: size }}
      >
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}
