import type { LucideIcon } from "lucide-react-native";
import FileText from "lucide-react-native/dist/esm/icons/file-text";
import MessageCircle from "lucide-react-native/dist/esm/icons/message-circle";
import PanelsTopLeft from "lucide-react-native/dist/esm/icons/panels-top-left";
import Shapes from "lucide-react-native/dist/esm/icons/shapes";
import SquareCheck from "lucide-react-native/dist/esm/icons/square-check";
import type { Section } from "../../../packages/domain/src";

/**
 * The places in a workspace, in the order they are shown. On a wide window all of them are in the
 * strip of icons beside the conversations; on a phone the strip is the bar along the bottom, which
 * has room for the ones marked `bar`, and the others are in the drawer with the conversations.
 */
export const places: { id: Section; label: string; icon: LucideIcon; bar: boolean }[] = [
  { id: "chat", label: "Chat", icon: MessageCircle, bar: true },
  { id: "activity", label: "Activity", icon: PanelsTopLeft, bar: true },
  { id: "goals", label: "Goals", icon: SquareCheck, bar: true },
  { id: "apps", label: "Apps", icon: Shapes, bar: true },
  { id: "files", label: "Files", icon: FileText, bar: false },
];

/** A guest has the conversations in their channels and nowhere else to go. */
export const guestPlaces = places.filter((place) => place.id === "chat");
