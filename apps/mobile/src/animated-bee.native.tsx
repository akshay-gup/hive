import { Image } from "expo-image";
import { useState } from "react";
import { beeFrame } from "./bee-frame";
import { Mascot } from "./ui";
import { useStill } from "./use-still";

const loops = {
  1: require("../assets/bee-idle-1.webp"),
  2: require("../assets/bee-idle-2.webp"),
  3: require("../assets/bee-idle-3.webp"),
} as const;
export type BeeLoop = keyof typeof loops;

/** The loops are in the app already, so there is nothing to fetch ahead of the screen that shows one. */
export function warmBee(_loop: BeeLoop): void {}

/**
 * The bee, looking around and blinking, in one of three loops (a different one for each kind of
 * screen, so they do not repeat). It is the `Mascot` at the same `size`, in the same box and with
 * the same bee under it, so a screen with this and one with the plain bee look the same size.
 * `expo-image` plays animated WebP on the phone and the Mac app, which React Native's own image
 * does not do reliably. It holds still, as the plain bee, when the system asks for less motion.
 */
export function AnimatedBee({ loop, size }: { loop: BeeLoop; size: number }) {
  const still = useStill();
  const [ready, setReady] = useState(false);
  if (still) return <Mascot size={size} />;
  const { width, height, left, top } = beeFrame(size);
  return (
    <Mascot
      size={size}
      ready={ready}
      art={
        <Image
          source={loops[loop]}
          contentFit="contain"
          accessible={false}
          onLoad={() => setReady(true)}
          onError={() => setReady(true)}
          style={{ position: "absolute", width, height, left, top, opacity: ready ? 1 : 0 }}
        />
      }
    />
  );
}
