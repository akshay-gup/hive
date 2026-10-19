import { Platform } from "react-native";
import { haze } from "./theme";

/**
 * The page behind the app on the web is light too: the scrollbars, the form controls and whatever
 * shows past the app's edges follow the app instead of flashing white. Imported once, for its
 * effect, from index.js. Native builds have no page, so this does nothing there.
 */
if (Platform.OS === "web" && typeof document !== "undefined" && !document.getElementById("page")) {
  const style = document.createElement("style");
  style.id = "page";
  style.textContent = `html{color-scheme:light;background:${haze.base}}body{background:${haze.base}}`;
  document.head.appendChild(style);
}
