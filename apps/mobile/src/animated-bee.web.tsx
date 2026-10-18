import { useState } from "react";
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
 * Fetches a loop in the browser ahead of the screen that shows it, so the file (a megabyte or so)
 * is already there. It is the picture itself, a pixel big, unseen and out of the layout, so it asks
 * for the file the way the screen will and can fail only as that picture could. (Asking for the
 * file's address instead takes an API this platform's `Image` does not have, which once left the
 * screen after sign-in blank.)
 */
export function WarmBee({ loop }: { loop: BeeLoop }) {
  return (
    <Image
      source={loops[loop]}
      accessible={false}
      style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
    />
  );
}

/**
 * The bee, looking around and blinking, in one of three loops (a different one for each kind of
 * screen, so they do not repeat). It is the `Mascot` at the same `size`, in the same box and with
 * the same bee under it, so a screen with this and one with the plain bee look the same size. The
 * plain bee stays until the moving one has loaded, then the moving one takes over in its place. It
 * holds still, as the plain bee, when the system asks for less motion.
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
          resizeMode="contain"
          accessible={false}
          onLoad={() => setReady(true)}
          onError={() => setReady(true)}
          style={{ position: "absolute", width, height, left, top, opacity: ready ? 1 : 0 }}
        />
      }
    />
  );
}
