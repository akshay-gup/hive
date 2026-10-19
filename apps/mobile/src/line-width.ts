import { useWindowDimensions } from "react-native";

/**
 * How wide a one-line row in the conversation (a task, a page the agent read, an email) may be: wide
 * enough for a title on a desktop, never wider than the screen on a phone, where the message around
 * it is as wide as the screen and a fixed width would run off the edge.
 */
export function useLineMaxWidth(): number {
  const { width } = useWindowDimensions();
  return Math.min(480, Math.max(200, width - 56));
}
