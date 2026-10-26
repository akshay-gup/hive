import type { ChannelFootprint } from "../../../packages/domain/src/agent";
import { fileSize } from "./file-format";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What deleting a channel takes, one line each, in the words the person reads before they agree. */
export function footprintLines(footprint: ChannelFootprint): string[] {
  return [
    footprint.messages
      ? `${count(footprint.messages, "message")}, including ${count(footprint.threads, "conversation")} in threads`
      : "No messages",
    footprint.files
      ? `${count(footprint.files, "file")} (${fileSize(footprint.fileBytes)}), for good`
      : "No files",
    footprint.agentRuns
      ? `What the agent did here (${count(footprint.agentRuns, "request")}): its working folder, the tasks it made, and what it learned, on the workspace machine`
      : "Anything the agent kept for it on the workspace machine",
    `${count(footprint.people, "person", "people")} ${footprint.people === 1 ? "loses" : "lose"} it`,
  ];
}
