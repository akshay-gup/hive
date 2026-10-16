import type { ReactNode } from "react";
import { ActivityIndicator, Text } from "react-native";
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
  return (
    <Frame>
      {moving && !error ? <AnimatedBee loop={2} size={pageBee} /> : <Mascot size={pageBee} />}
      {error ? <ErrorNotice error={error} /> : <ActivityIndicator color={colors.primary} />}
      <Text style={[s.title, { textAlign: "center" }]}>{title}</Text>
      {!!detail && <Text style={[s.muted, { textAlign: "center" }]}>{detail}</Text>}
      {children}
    </Frame>
  );
}
