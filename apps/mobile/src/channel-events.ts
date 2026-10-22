import { useEffect } from "react";

const listeners = new Set<() => void>();

/**
 * Say that which channels there are, or who is in one, has changed, so every list of channels on
 * screen (the sidebar, the menu, a channel's header) fetches them again.
 */
export function channelsChanged() {
  for (const listener of listeners) listener();
}

/** Run `reload` whenever the channels change. */
export function useOnChannelsChanged(reload: () => void) {
  useEffect(() => {
    listeners.add(reload);
    return () => {
      listeners.delete(reload);
    };
  }, [reload]);
}
