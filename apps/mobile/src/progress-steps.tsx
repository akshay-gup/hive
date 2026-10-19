import { Check, ChevronDown, ChevronRight, Minus, X } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { type ProgressStep, summarizeSteps } from "./run-progress";
import { colors, IconSlot, radius, s, type WebPressState } from "./ui";

function StepIcon({ state }: { state: ProgressStep["state"] }) {
  // The line above already has the spinner; a second one on the step would be two things moving.
  if (state === "running")
    return (
      <View
        style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.muted }}
        accessibilityLabel="In progress"
      />
    );
  const Icon = state === "done" ? Check : state === "failed" ? X : Minus;
  return (
    <Icon
      size={14}
      strokeWidth={2}
      color={state === "done" ? colors.success : state === "failed" ? colors.danger : colors.muted}
    />
  );
}

/**
 * What the agent did while it worked, in the thread where it did it: one quiet line that says what is
 * happening now or how the work went, and the steps behind it when it is opened. This is for work
 * done in the conversation itself; a task that was saved has its own page and card.
 */
export function RunProgress({ steps, elapsedMs }: { steps: ProgressStep[]; elapsedMs?: number }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeSteps(steps, elapsedMs);
  const running = steps.some((step) => step.state === "running");
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View style={{ gap: 4, alignSelf: "flex-start", maxWidth: "100%", paddingBottom: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${summary}. ${open ? "Hide" : "Show"} the steps`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={({ pressed, hovered }: WebPressState) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          alignSelf: "flex-start",
          paddingVertical: 4,
          paddingHorizontal: 8,
          borderRadius: radius.md,
          backgroundColor: pressed || hovered ? colors.surfaceHover : "transparent",
        })}
      >
        <IconSlot>
          {running ? (
            <ActivityIndicator size="small" color={colors.muted} />
          ) : (
            <Chevron size={14} strokeWidth={2} color={colors.muted} />
          )}
        </IconSlot>
        <Text style={[s.small, { color: colors.muted, flexShrink: 1 }]} numberOfLines={1}>
          {summary}
        </Text>
        {running && <Chevron size={14} strokeWidth={2} color={colors.muted} />}
      </Pressable>
      {open && (
        <View
          style={{
            gap: 7,
            marginLeft: 12,
            paddingLeft: 12,
            paddingVertical: 2,
            borderLeftWidth: 2,
            borderLeftColor: colors.line,
          }}
        >
          {steps.map((step) => (
            <View key={step.id} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
              <View
                style={{ width: 16, height: 20, alignItems: "center", justifyContent: "center" }}
              >
                <StepIcon state={step.state} />
              </View>
              <View style={{ flexShrink: 1, gap: 1 }}>
                <Text style={[s.small, { color: colors.text }]}>{step.label}</Text>
                {!!step.detail && (
                  <Text style={[s.small, { color: colors.muted }]} numberOfLines={3}>
                    {step.detail}
                  </Text>
                )}
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
