import type { Channel } from "../../domain/src/agent.ts";
import type { RunReason } from "../../domain/src/chat-agent.ts";
import { mentionsIn } from "../../domain/src/mentions.ts";
import { isDm, isPublic } from "./access.ts";

/** What the agent is mentioned by. The name it is shown under is its own business; this does not change. */
export const AGENT_HANDLE = "hive";

/** Whether a message asks for the agent: it names it, as `@hive`. */
export const wantsAgent = (text: string) => mentionsIn(text).includes(AGENT_HANDLE);

/**
 * Whether the agent may be brought into the channel. A public channel has it unless a manager said no; a
 * private one only if a manager said yes, since what it is shown there is kept on the machine it runs on.
 * A direct message never has it.
 */
export function agentOn(channel: Channel): boolean {
  if (isDm(channel)) return false;
  return isPublic(channel) ? channel.agent !== false : channel.agent === true;
}

/** Why a mention of the agent in this channel cannot start a run, if it cannot. */
export function agentRefusal(channel: Channel): RunReason | null {
  if (isDm(channel)) return "dm";
  if (channel.status === "archived") return "archived";
  if (!agentOn(channel)) return "disabled";
  return null;
}
