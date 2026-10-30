import type { ChannelView } from "../../../packages/domain/src/agent";

/**
 * The channels as last loaded, kept for the screens that show one so a name is there the moment a channel is
 * opened. They load their own copy to be sure it is current, but they need not show nothing while it comes.
 */
const known = new Map<string, ChannelView[]>();

export function rememberChannels(workspace: string, channels: ChannelView[]) {
  known.set(workspace, channels);
}

export function rememberChannel(workspace: string, channel: ChannelView) {
  const rest = (known.get(workspace) ?? []).filter((item) => item.id !== channel.id);
  known.set(workspace, [...rest, channel]);
}

export function knownChannel(workspace: string, id: string): ChannelView | null {
  return known.get(workspace)?.find((channel) => channel.id === id) ?? null;
}
