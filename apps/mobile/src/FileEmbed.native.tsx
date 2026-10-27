import Play from "lucide-react-native/dist/esm/icons/play";
import { Linking } from "react-native";
import Pdf from "react-native-pdf";
import { WebView } from "react-native-webview";
import { Button, colors, radius } from "./ui";

/**
 * A web page (or an SVG) an agent made, shown in a web view. The server sends it with a sandbox
 * policy, so it can draw itself and run its own scripts but cannot reach Hive's own pages.
 */
export function HtmlFrame({ url, height }: { url: string; height: number }) {
  return (
    <WebView
      source={{ uri: url }}
      originWhitelist={["http://*", "https://*"]}
      setSupportMultipleWindows={false}
      allowFileAccess={false}
      style={{ height, borderRadius: radius.lg, backgroundColor: colors.paper }}
    />
  );
}

export function PdfFrame({ url, height }: { url: string; height: number }) {
  return (
    <Pdf
      source={{ uri: url, cache: false }}
      trustAllCerts={false}
      style={{ height, width: "100%", backgroundColor: colors.line, borderRadius: radius.lg }}
    />
  );
}

/** There is no player library in the app, so video and audio open in the phone's own player. */
export function MediaPlayer({ url, kind }: { url: string; kind: "video" | "audio"; name: string }) {
  return (
    <Button icon={Play} onPress={() => void Linking.openURL(url)}>
      {kind === "video" ? "Play video" : "Play audio"}
    </Button>
  );
}
