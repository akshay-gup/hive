import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/** True when the system asks for less motion, so what would move holds still. */
export function useStill(): boolean {
  const [still, setStill] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((reduce) => {
        if (active) setStill(reduce);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return still;
}
