import { Fragment } from "react";
import { Text, View } from "react-native";
import type { PromptChoice } from "../../../packages/domain/src/chat-agent";
import { AssistantResponse } from "./assistant-response";
import { ChannelCards } from "./channel-cards";
import type { AgentView } from "./chat-agent-extra";
import { ChatAgentPrompt } from "./chat-agent-prompt";
import { RunProgress } from "./progress-steps";
import { colors, s, TypingDots } from "./ui";

/** The agent is going but nothing says so yet: dots and a word. */
function Waiting({ text }: { text: string }) {
  return (
    <View
      accessibilityLabel={text}
      style={[s.row, { alignSelf: "flex-start", gap: 6, paddingVertical: 6 }]}
    >
      <TypingDots />
      <Text style={[s.small, { color: colors.muted }]}>{text}</Text>
    </View>
  );
}

/**
 * The agent's reply to a mention, in its place in the conversation: what it did (the steps), what it
 * asked people to decide (where it came up, between its steps and words), what it says, and how it ended when
 * that was not well. Stopping it is done from the box a reply is written in (`ChatComposer`), as in any
 * other chat.
 */
export function ChatAgentBody({
  view,
  body,
  canAnswer,
  onAnswer,
  viewerId,
  messageId,
}: {
  view: AgentView;
  /** The message the reply is, which a request for files is answered after. */
  messageId: string;
  body: string;
  /** A teammate (not a guest) in the channel. */
  canAnswer: boolean;
  onAnswer: (promptId: string, choice: PromptChoice) => Promise<void>;
  viewerId?: string;
}) {
  const text = body.trim();
  const going = view.queued || view.working;
  // A refusal says why in the words of the reply itself; saying it again below would be the same twice.
  const endedLine = view.ended && view.ended.text !== text ? view.ended.text : "";
  let from = 0;
  return (
    <View style={{ gap: 2 }}>
      {view.queued && <Waiting text="Starting up the workspace…" />}
      {view.segments.map((segment, at) => {
        const to = Math.max(from, segment.endsAt ?? body.length);
        const words = body.slice(from, to).trim();
        from = to;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the stretches are in a fixed order, split where it asked
          <Fragment key={at}>
            {!!segment.steps.length && <RunProgress steps={segment.steps} />}
            {!!words && (
              <View style={{ maxWidth: 720 }}>
                <AssistantResponse content={words} />
              </View>
            )}
            {!!segment.cards.length && <ChannelCards cards={segment.cards} messageId={messageId} />}
            {segment.prompts.map((state) => (
              <ChatAgentPrompt
                key={state.prompt.id}
                state={state}
                viewerId={viewerId}
                canAnswer={canAnswer && going}
                onAnswer={(choice) => onAnswer(state.prompt.id, choice)}
              />
            ))}
          </Fragment>
        );
      })}
      {going && !view.queued && !text && !view.stepMoving && !view.waiting && (
        <Waiting text="Thinking" />
      )}
      {!!endedLine && <Text style={[s.small, { color: colors.muted }]}>{endedLine}</Text>}
    </View>
  );
}
