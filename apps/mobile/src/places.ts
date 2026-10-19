import {
  CalendarDays,
  FileText,
  type LucideIcon,
  MessageCircle,
  PanelsTopLeft,
  Shapes,
  SquareCheck,
} from "lucide-react-native";
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
  { id: "calendar", label: "Calendar", icon: CalendarDays, bar: false },
  { id: "files", label: "Files", icon: FileText, bar: false },
];
