import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/** Smaller than any on-screen keyboard, bigger than a browser's address bar growing or shrinking. */
const KEYBOARD_MIN = 150;

/**
 * True while the on-screen keyboard is up, so what sits along the bottom of the screen can step
 * aside and leave the room to what is being typed. The browser does not say so: the part of the page
 * that can be seen is what shrinks, against the tallest the window has been.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "web") {
      const show = Keyboard.addListener("keyboardDidShow", () => setOpen(true));
      const hide = Keyboard.addListener("keyboardDidHide", () => setOpen(false));
      return () => {
        show.remove();
        hide.remove();
      };
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    let tallest = Math.max(window.innerHeight, viewport.height);
    const measure = () => {
      tallest = Math.max(tallest, window.innerHeight, viewport.height);
      setOpen(tallest - viewport.height > KEYBOARD_MIN);
    };
    // Turning the phone changes how tall the window is without a keyboard being involved.
    const turned = () => {
      tallest = 0;
      setTimeout(measure, 300);
    };
    viewport.addEventListener("resize", measure);
    window.addEventListener("orientationchange", turned);
    return () => {
      viewport.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", turned);
    };
  }, []);
  return open;
}
