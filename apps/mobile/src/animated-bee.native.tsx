import { Image } from "expo-image";
import { View } from "react-native";
import { Mascot } from "./ui";
import { useStill } from "./use-still";

const loops = {
  1: require("../assets/bee-idle-1.webp"),
  2: require("../assets/bee-idle-2.webp"),
  3: require("../assets/bee-idle-3.webp"),
} as const;
export type BeeLoop = keyof typeof loops;
/** The frames are 352 by 288, with room around the bee for its wings. */
const RATIO = 352 / 288;

/**
 * The bee, looking around and blinking, in one of three loops (a different one for each kind of
 * screen, so they do not repeat). `expo-image` plays animated WebP on the phone and the Mac app,
 * which React Native's own image does not do reliably. It holds still, as the plain bee, when the
 * system asks for less motion.
 */
export function AnimatedBee({ loop, height = 120 }: { loop: BeeLoop; height?: number }) {
  const still = useStill();
  const width = Math.round(height * RATIO);
  return (
    <View style={{ width, height, alignItems: "center", justifyContent: "center" }}>
      {still ? (
        <Mascot size={Math.round(height * 0.95)} />
      ) : (
        <Image
          source={loops[loop]}
          contentFit="contain"
          accessible
          accessibilityLabel="Hive bee"
          style={{ width, height }}
        />
      )}
    </View>
  );
}
