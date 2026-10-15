import { View } from "react-native";
import { Mascot } from "./ui";

export type BeeLoop = 1 | 2 | 3;
/** The frames of the animated bee are 352 by 288; the plain one sits in the same room. */
const RATIO = 352 / 288;

/**
 * The plain bee, in the room the animated one has on the web. The loops are animated WebP, which
 * React Native does not draw reliably on every phone (an image library that does would let this
 * play them too), so the phone and the Mac app keep the still bee for now.
 */
export function AnimatedBee({ height = 120 }: { loop: BeeLoop; height?: number }) {
  return (
    <View
      style={{
        width: Math.round(height * RATIO),
        height,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Mascot size={Math.round(height * 0.95)} />
    </View>
  );
}
