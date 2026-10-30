import { useMemo } from "react";
import type { ChannelCardActions } from "./channel-cards";
import { answeredSince, choiceState } from "./channel-choices";
import type { FeedMessage } from "./chat-feed";
import { sendChatFile } from "./chat-upload";
import type { PickedFile } from "./file-upload";
import type { JevInteraction } from "./jev-tool-card";
import { useWorkspace } from "./workspace";

/**
 * What the agent's choices and requests for files do in a conversation: a pick or a file is a message
 * of the person's, which the agent reads as the answer. In a shared channel a message only reaches the
 * agent if it names it, so there it starts with the mention.
 */
export function useAgentCards(
  channelId: string,
  messages: readonly FeedMessage[],
  send: (text: string, options?: { fileIds?: string[] }) => Promise<unknown>,
  mention: boolean,
): { interaction: JevInteraction; cardActions: ChannelCardActions } {
  const { api } = useWorkspace();
  const choices = useMemo(() => choiceState(messages), [messages]);
  const said = (text: string) => (mention ? `@hive ${text}` : text);
  const interaction = useMemo<JevInteraction>(
    () => ({
      threadId: choices.threadId,
      busy: choices.busy,
      latestPanelId: choices.latestPanelId,
      latestUserText: choices.latestUserText,
      canRetry: !choices.busy,
      confirmedSelection: choices.confirmedSelection,
      send: async (text: string) => {
        await send(said(text));
      },
      retry: async (text: string) => {
        await send(said(text));
      },
    }),
    // biome-ignore lint/correctness/useExhaustiveDependencies: `said` only reads `mention`
    [choices, send, mention],
  );
  const cardActions = useMemo<ChannelCardActions>(
    () => ({
      busy: choices.busy,
      answered: (id: string) => answeredSince(messages, id),
      sendFiles: async (files: PickedFile[]) => {
        const sent = [];
        for (const file of files) sent.push(await sendChatFile(api, channelId, file));
        await send(
          said(
            sent.length === 1
              ? "Here is the file you asked for."
              : "Here are the files you asked for.",
          ),
          { fileIds: sent.map((file) => file.fileId) },
        );
      },
    }),
    // biome-ignore lint/correctness/useExhaustiveDependencies: `said` only reads `mention`
    [choices.busy, messages, send, api, channelId, mention],
  );
  return { interaction, cardActions };
}
