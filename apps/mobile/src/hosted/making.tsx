import { Check } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, Text, View } from "react-native";
import { AnimatedBee } from "../animated-bee";
import { colors, pageBee, radius, s } from "../ui";
import { useStill } from "../use-still";
import { Frame } from "./frame";
import { barFill, flavorAt, type MakingStep, stepList } from "./making-steps";

function StepRow({ step }: { step: MakingStep }) {
  const state = { done: "done", now: "in progress", next: "waiting" }[step.state];
  return (
    <View
      accessible
      accessibilityLabel={`${step.label}, ${state}`}
      accessibilityLiveRegion={step.state === "now" ? "polite" : "none"}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        opacity: step.state === "next" ? 0.45 : 1,
      }}
    >
      <View style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}>
        {step.state === "done" ? (
          <Check size={16} strokeWidth={2.5} color={colors.success} />
        ) : step.state === "now" ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.muted }} />
        )}
      </View>
      <Text
        style={[
          s.text,
          step.state === "now" && { fontWeight: "600" },
          step.state === "done" && { color: colors.muted },
        ]}
      >
        {step.label}
      </Text>
    </View>
  );
}

/**
 * What a workspace being made shows: the steps the control plane says it is on, ticked off as it
 * goes, a bar that keeps creeping, and a line or two of company. When the control plane does not
 * say which step, only the spinner and the lines, since a made-up list would be a guess.
 */
export function MakingScreen({ name, step }: { name: string; step?: string }) {
  const still = useStill();
  const began = useRef(Date.now());
  const stepAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    stepAt.current = Date.now();
  }, [step]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const list = stepList(step);
  const fill = barFill(step, (now - stepAt.current) / 1000);
  const width = useRef(new Animated.Value(fill)).current;
  useEffect(() => {
    if (still) {
      width.setValue(fill);
      return;
    }
    Animated.timing(width, {
      toValue: fill,
      duration: 600,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [fill, still, width]);

  return (
    <Frame>
      <AnimatedBee loop={1} size={pageBee} />
      <Text style={[s.title, { textAlign: "center" }]}>{`Setting up ${name}…`}</Text>
      {list ? (
        <View style={[s.card, { alignSelf: "stretch", gap: 14, padding: 18 }]}>
          {list.map((item) => (
            <StepRow key={item.key} step={item} />
          ))}
          <View
            accessibilityRole="progressbar"
            accessibilityLabel="Setting up"
            accessibilityValue={{ min: 0, max: 100, now: Math.round(fill * 100) }}
            style={{
              height: 4,
              borderRadius: radius.pill,
              backgroundColor: colors.primarySoft,
              overflow: "hidden",
              marginTop: 4,
            }}
          >
            <Animated.View
              style={{
                height: 4,
                borderRadius: radius.pill,
                backgroundColor: colors.primary,
                width: width.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
              }}
            />
          </View>
        </View>
      ) : (
        <ActivityIndicator color={colors.primary} />
      )}
      <Text style={[s.muted, { textAlign: "center" }]}>
        {flavorAt((now - began.current) / 1000)}
      </Text>
      <Text style={[s.small, { textAlign: "center" }]}>
        About a minute the first time. You will be taken in when it is ready.
      </Text>
    </Frame>
  );
}
