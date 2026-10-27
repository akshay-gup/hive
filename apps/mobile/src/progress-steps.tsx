import Check from "lucide-react-native/dist/esm/icons/check";
import ChevronDown from "lucide-react-native/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react-native/dist/esm/icons/chevron-right";
import ExternalLink from "lucide-react-native/dist/esm/icons/external-link";
import Minus from "lucide-react-native/dist/esm/icons/minus";
import X from "lucide-react-native/dist/esm/icons/x";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import type { BrowserSession } from "../../../packages/domain/src";
import { type ProgressStep, summarizeSteps } from "./run-progress";
import { colors, IconSlot, radius, s, type WebPressState } from "./ui";
import { useWorkspace } from "./workspace";

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
            <StepRow key={step.id} step={step} />
          ))}
        </View>
      )}
    </View>
  );
}

/** One step. When it brought something back it opens to show it, and a page can be taken over. */
function StepRow({ step }: { step: ProgressStep }) {
  const { api, open: show } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const more = !!step.output || !!step.browserId || !!step.shot;
  const [picture, setPicture] = useState("");
  // The picture's link is short-lived, so it is asked for when the step is opened, not kept.
  useEffect(() => {
    if (!open || !step.shot || picture) return;
    let live = true;
    api
      .request<{ url: string }>(`/api/browser-shots/${encodeURIComponent(step.shot)}/link`)
      .then((link) => live && setPicture(link.url))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, step.shot, picture, api]);
  async function takeOver() {
    setError("");
    try {
      const browser = await api.request<BrowserSession>(
        `/api/browsers/${encodeURIComponent(step.browserId || "")}`,
      );
      show({ type: "browser", browser });
    } catch {
      setError("That browser window is closed now.");
    }
  }
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole={more ? "button" : undefined}
        accessibilityState={more ? { expanded: open } : undefined}
        disabled={!more}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}
      >
        <View style={{ width: 16, height: 20, alignItems: "center", justifyContent: "center" }}>
          <StepIcon state={step.state} />
        </View>
        <View style={{ flexShrink: 1, gap: 1 }}>
          <Text style={[s.small, { color: colors.text }]} numberOfLines={open ? undefined : 2}>
            {step.label}
          </Text>
          {!!step.detail && (
            <Text style={[s.small, { color: colors.muted }]} numberOfLines={open ? undefined : 1}>
              {step.detail}
            </Text>
          )}
        </View>
        {more && (
          <View style={{ height: 20, justifyContent: "center" }}>
            <Chevron size={14} strokeWidth={2} color={colors.muted} />
          </View>
        )}
      </Pressable>
      {open && (
        <View
          style={{
            marginLeft: 24,
            gap: 8,
            padding: 10,
            borderRadius: radius.md,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.line,
          }}
        >
          {!!step.shot && (
            <Image
              accessibilityLabel="What the page looked like"
              source={picture ? { uri: api.url(picture) } : undefined}
              resizeMode="cover"
              style={{
                width: "100%",
                aspectRatio: 1.6,
                borderRadius: radius.md,
                backgroundColor: colors.surfaceMuted,
              }}
            />
          )}
          {!!step.output && (
            <Text
              style={[s.small, { color: colors.text }]}
              numberOfLines={step.shot ? 4 : undefined}
              selectable
            >
              {step.output}
            </Text>
          )}
          {!!step.browserId && (
            <Pressable
              accessibilityRole="button"
              onPress={() => void takeOver()}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                alignSelf: "flex-start",
              }}
            >
              <ExternalLink size={14} color={colors.primaryText} />
              <Text style={[s.small, { fontWeight: "700", color: colors.primaryText }]}>
                Open in the browser
              </Text>
            </Pressable>
          )}
          {!!error && <Text style={[s.small, { color: colors.danger }]}>{error}</Text>}
        </View>
      )}
    </View>
  );
}
