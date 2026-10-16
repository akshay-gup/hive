import { Image } from "react-native";
import { beeFrame } from "./bee-frame";
import { Mascot } from "./ui";
import { useStill } from "./use-still";

const loops = {
  1: require("../assets/bee-idle-1.webp"),
  2: require("../assets/bee-idle-2.webp"),
  3: require("../assets/bee-idle-3.webp"),
} as const;
export type BeeLoop = keyof typeof loops;

/**
 * The bee, looking around and blinking, in one of three loops (a different one for each kind of
 * screen, so they do not repeat). It is the `Mascot` at the same `size`, in the same box and with
 * the same bee under it, so a screen with this and one with the plain bee look the same size. It
 * holds still, as the plain bee, when the system asks for less motion.
 */
export function AnimatedBee({ loop, size }: { loop: BeeLoop; size: number }) {
  const still = useStill();
  if (still) return <Mascot size={size} />;
  const { width, height, left, top } = beeFrame(size);
  return (
    <Mascot
      size={size}
      art={
        <Image
          source={loops[loop]}
          resizeMode="contain"
          accessible={false}
          style={{ position: "absolute", width, height, left, top }}
        />
      }
    />
  );
}
