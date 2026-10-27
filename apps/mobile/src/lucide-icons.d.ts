// Each icon is imported from its own file (see the imports), so the bundle holds the icons used and
// not all of the 1,500 in the package. The package ships no types for those files.
declare module "lucide-react-native/dist/esm/icons/*" {
  import type { LucideIcon } from "lucide-react-native";

  const icon: LucideIcon;
  export default icon;
}
