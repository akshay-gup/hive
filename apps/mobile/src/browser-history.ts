import { useEffect, useRef } from "react";
import { Platform } from "react-native";

interface Entry {
  hive: 1;
  section: string;
  detail: boolean;
}

/**
 * Makes the browser's Back button go back one screen instead of out of the app: each place the person
 * goes to, and each page they open over it, is one entry in the browser's history. Going back shuts
 * the page, or returns to the place before. (Only on the web; a phone has its own Back.)
 */
export function useBrowserBack({
  section,
  hasDetail,
  goTo,
  closeDetail,
}: {
  section: string;
  hasDetail: boolean;
  goTo: (section: string) => void;
  closeDetail: () => void;
}) {
  const now = useRef({ section, hasDetail, goTo, closeDetail });
  now.current = { section, hasDetail, goTo, closeDetail };
  // Set when this code moved the history itself, so the event that follows is not taken for a person pressing Back.
  const ignore = useRef(0);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onPop = (event: PopStateEvent) => {
      if (ignore.current > 0) {
        ignore.current -= 1;
        return;
      }
      const entry = event.state as Entry | null;
      if (!entry?.hive) return;
      if (entry.section !== now.current.section) now.current.goTo(entry.section);
      if (!entry.detail && now.current.hasDetail) now.current.closeDetail();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const top = window.history.state as Entry | null;
    const want: Entry = { hive: 1, section, detail: hasDetail };
    if (!top?.hive) {
      window.history.replaceState(want, "");
      return;
    }
    if (top.section === section && top.detail === hasDetail) return;
    if (top.section === section && top.detail && !hasDetail) {
      // The page was shut with its own button: step back over the entry it had made.
      ignore.current += 1;
      window.history.back();
      return;
    }
    window.history.pushState(want, "");
  }, [section, hasDetail]);
}
