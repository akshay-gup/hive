import { useCallback, useEffect, useState } from "react";
import type { ChannelView } from "../../../packages/domain/src/agent";
import { useOnChannelsChanged } from "./channel-events";
import { useWorkspace } from "./workspace";

/** The id of the person's own conversation with the agent, a channel of one the chat service keeps, once it is known. */
export function usePersonalChannel(enabled = true): string | null {
  const { api } = useWorkspace();
  const [id, setId] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const channels = await api.request<ChannelView[]>("/api/agent/channels");
      setId(channels.find((channel) => channel.kind === "personal")?.id ?? null);
    } catch {
      // Tried again when the channels change or the app is opened again.
    }
  }, [api, enabled]);
  useEffect(() => {
    void load();
  }, [load]);
  useOnChannelsChanged(() => void load());
  return id;
}
