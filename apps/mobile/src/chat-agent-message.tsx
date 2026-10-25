import { Square } from "lucide-react-native";
import { Text, View } from "react-native";
import type { PromptChoice } from "../../../packages/domain/src/chat-agent";
import { AssistantResponse } from "./assistant-response";
import type { AgentView } from "./chat-agent-extra";
import { ChatAgentPrompt } from "./chat-agent-prompt";
import { RunProgress } from "./progress-steps";
import { Button, colors, s, TypingDots } from "./ui";

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
 * says, what it is waiting for people to decide, and how it ended when that was not well. While it is
 * going, whoever may stop it can.
 */
export function ChatAgentBody({
  view,
  body,
  canAnswer,
  canStop,
  onAnswer,
  onStop,
}: {
  view: AgentView;
  body: string;
  /** A teammate (not a guest) in the channel. */
  canAnswer: boolean;
  /** Who asked, a manager, an admin or the owner. */
  canStop: boolean;
  onAnswer: (promptId: string, choice: PromptChoice) => Promise<void>;
  onStop: () => void;
}) {
  const text = body.trim();
  const going = view.queued || view.working;
  // A refusal says why in the words of the reply itself; saying it again below would be the same twice.
  const endedLine = view.ended && view.ended.text !== text ? view.ended.text : "";
  return (
    <View style={{ gap: 2 }}>
      {view.queued && <Waiting text="Waiting for the agent to start…" />}
      {!!view.steps.length && <RunProgress steps={view.steps} />}
      {going && !view.queued && !text && !view.stepMoving && !view.waiting && (
        <Waiting text="Thinking" />
      )}
      {!!text && (
        <View style={{ maxWidth: 720 }}>
          <AssistantResponse content={text} />
        </View>
      )}
      {view.prompts.map((state) => (
        <ChatAgentPrompt
          key={state.prompt.id}
          state={state}
          canAnswer={canAnswer && going}
          onAnswer={(choice) => onAnswer(state.prompt.id, choice)}
        />
      ))}
      {!!endedLine && <Text style={[s.small, { color: colors.muted }]}>{endedLine}</Text>}
      {going && canStop && (
        <View style={{ alignSelf: "flex-start", paddingTop: 4 }}>
          <Button small icon={Square} onPress={onStop} accessibilityLabel="Stop the agent">
            Stop
          </Button>
        </View>
      )}
    </View>
  );
}
