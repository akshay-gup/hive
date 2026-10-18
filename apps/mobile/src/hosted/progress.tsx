import type { ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { AnimatedBee } from "../animated-bee";
import { colors, ErrorNotice, Mascot, pageBee, s } from "../ui";
import { Frame } from "./frame";

/** One thing happening, or one thing that went wrong, with what the person can do about it. */
export function ProgressScreen({
  title,
  detail,
  error,
  moving,
  children,
}: {
  title: string;
  detail?: string;
  error?: string;
  /** Show the bee moving, for a wait that can run on (a workspace waking up); the plain bee when it is brief. */
  moving?: boolean;
  /** The buttons that go with it, once there is something to do. */
  children?: ReactNode;
}) {
  // A wait is a screen whose parts do not change size: the block is centred, so a text of one line
  // where there was two, or a different screen laid out a little differently after it, would move
  // the bee and everything under it. The text gets room for two lines whether it has them or not.
  const waiting = !error && !children;
  return (
    <Frame>
      {moving && !error ? <AnimatedBee loop={2} size={pageBee} /> : <Mascot size={pageBee} />}
      {error ? <ErrorNotice error={error} /> : <ActivityIndicator color={colors.primary} />}
      <Text style={[s.title, { textAlign: "center" }]}>{title}</Text>
      {waiting ? (
        <View style={{ minHeight: DETAIL_LINES * DETAIL_LINE_HEIGHT, alignItems: "center" }}>
          <Text style={[s.muted, { textAlign: "center" }]}>{detail ?? ""}</Text>
        </View>
      ) : (
        !!detail && <Text style={[s.muted, { textAlign: "center" }]}>{detail}</Text>
      )}
      {children}
    </Frame>
  );
}
/** The text under a waiting screen's title has room for two lines of `s.muted` (line height 21). */
const DETAIL_LINES = 2;
const DETAIL_LINE_HEIGHT = 21;
