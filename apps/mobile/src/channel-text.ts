import {
  type Channel,
  type ChannelVisibility,
  ORCHESTRATOR_CHANNEL_ID,
} from "../../../packages/domain/src/agent";

/** What a channel being public or private comes to, said wherever someone chooses it. */
export const visibilityHint: Record<ChannelVisibility, string> = {
  public: "Anyone in the workspace can find it and join.",
  private: "Only the people in it can find it. Anyone in it can add others.",
};

/** Whether everyone in the workspace is in the channel without being named. */
export const isEveryones = (channel: Pick<Channel, "visibility" | "everyone">) =>
  channel.visibility !== "private" && channel.everyone !== false;

/** How many people are in a channel, in words. */
export function peopleIn(channel: Pick<Channel, "visibility" | "everyone" | "members">): string {
  if (isEveryones(channel)) return "Everyone";
  const count = (channel.members ?? []).length;
  return count === 1 ? "1 person" : `${count} people`;
}

/** The channels a guest has, by the address they were added by. */
export function channelsOfGuest(channels: Channel[], email: string): Channel[] {
  const address = email.trim().toLowerCase();
  return channels
    .filter(
      (channel) =>
        channel.id !== ORCHESTRATOR_CHANNEL_ID &&
        channel.status !== "archived" &&
        (channel.members ?? []).includes(address),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Which channels a guest can open, as a line under their name. */
export function guestChannelsLine(inChannels: Pick<Channel, "name">[]): string {
  if (inChannels.length === 0) return "In no channel yet, so there is nothing for them to open";
  const names = inChannels.map((channel) => `# ${channel.name}`);
  if (names.length <= 3) return `Can open ${names.join(", ")}`;
  return `Can open ${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}
