import { Linking, Text, View } from "react-native";
import type { ChannelFile } from "../../../packages/domain/src/workspace-files";
import { Button, s } from "./ui";

/** On a phone these open in the app that made them; the preview is in the web app. */
export function OfficeBody({ file }: { file: ChannelFile }) {
  const url = file.url;
  return (
    <View style={{ gap: 12, alignItems: "flex-start" }}>
      <Text style={s.muted}>Open this file in the app that made it.</Text>
      {url ? (
        <Button
          onPress={() => void Linking.openURL(`${url}${url.includes("?") ? "&" : "?"}download=1`)}
        >
          Open
        </Button>
      ) : null}
    </View>
  );
}
