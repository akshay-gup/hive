import { Check } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, Text, View } from "react-native";
import { AnimatedBee } from "../animated-bee";
import { colors, pageBee, radius, s } from "../ui";
import { useStill } from "../use-still";
import { Frame } from "./frame";
import { advanceBar, type BarState, flavorAt, type MakingStep, stepList } from "./making-steps";

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
 * What a workspace being made shows: the four steps it goes through, ticked off as the control
 * plane says where it is, a bar that keeps creeping and never goes back, and a line or two of
 * company. The steps are there from the first frame, waiting, so only their marks change.
 */
export function MakingScreen({ name, step }: { name: string; step?: string }) {
  const still = useStill();
  const began = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  const [bar, setBar] = useState<BarState>(() =>
    advanceBar({ step, since: now, fill: 0 }, step, now),
  );
  useEffect(() => {
    const tick = () => {
      const at = Date.now();
      setNow(at);
      setBar((before) => advanceBar(before, step, at));
    };
    // A new step is timed from here, at once, not at the next beat.
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [step]);

  const list = stepList(step);
  const fill = bar.fill;
  const width = useRef(new Animated.Value(fill)).current;
  const previous = useRef(fill);
  useEffect(() => {
    // The beat-to-beat creep is a few percent: linear, so one beat runs into the next. A jump to
    // a new step eases out.
    const jump = fill - previous.current > 0.05;
    previous.current = fill;
    if (still) {
      width.setValue(fill);
      return;
    }
    Animated.timing(width, {
      toValue: fill,
      duration: jump ? 800 : 600,
      easing: jump ? Easing.out(Easing.quad) : Easing.linear,
      useNativeDriver: false,
    }).start();
  }, [fill, still, width]);

  return (
    <Frame>
      <AnimatedBee loop={1} size={pageBee} />
      <Text style={[s.title, { textAlign: "center" }]}>{`Setting up ${name}…`}</Text>
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
      <Text style={[s.muted, { textAlign: "center" }]}>
        {flavorAt((now - began.current) / 1000)}
      </Text>
      <Text style={[s.small, { textAlign: "center" }]}>
        About a minute the first time. You will be taken in when it is ready.
      </Text>
    </Frame>
  );
}
