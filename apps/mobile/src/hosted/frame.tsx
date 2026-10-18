import type { ReactNode } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Backdrop, haze } from "../ui";

/**
 * The page the hosted app's own screens (before a workspace is open) are drawn on: the haze, and a
 * column that hangs from a line a little above the middle of the screen.
 *
 * The column is not centred. These screens follow one another (signing in, the list of workspaces,
 * opening one, setting it up), each a different height, and a centred column puts the bee at a new
 * height on each, and moves it again whenever a line of text grows or a spinner gives way to a card.
 * Hung from one line, the bee stays where it is and only what is below it changes.
 */
export function Frame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const { height } = useWindowDimensions();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: haze.base }}>
      <Backdrop />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: "center",
          paddingHorizontal: 24,
          paddingBottom: 24,
          paddingTop: Math.min(200, Math.max(24, Math.round(height * 0.18))),
        }}
      >
        <View style={{ width: "100%", maxWidth: wide ? 560 : 420, gap: 22, alignItems: "center" }}>
          {children}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
