import { MessageCircleQuestion, ShieldCheck } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PromptChoice, PromptState, RunPrompt } from "../../../packages/domain/src/chat-agent";
import { Button, colors, ErrorNotice, fontSize, radius, s, selectedCard } from "./ui";

type Asked = Extract<RunPrompt, { kind: "question" }>["questions"][number];

/** What was picked or written for one question. */
interface Pick {
  chosen: string[];
  own: string;
}

/** The words that answer a question: what was picked, and what was written beside it. */
const answerOf = (pick: Pick): string[] => {
  const own = pick.own.trim();
  return own ? [...pick.chosen, own] : pick.chosen;
};

/** How an answered prompt reads: who decided what. */
function resolution(state: PromptState): string {
  const answered = state.answered;
  if (!answered) return "";
  const who = answered.byName || "Someone";
  if ("reply" in answered.choice)
    return answered.choice.reply === "once" ? `Allowed by ${who}` : `Turned down by ${who}`;
  if ("answers" in answered.choice) return `Answered by ${who}`;
  return answered.by === "agent" ? "No longer needed" : `Skipped by ${who}`;
}

/**
 * What the agent is waiting on, as a card in its reply: to be allowed to do something, or a question.
 * Anyone in the channel but a guest can decide (the first answer is taken); once answered it says who did.
 */
export function ChatAgentPrompt({
  state,
  canAnswer,
  onAnswer,
}: {
  state: PromptState;
  canAnswer: boolean;
  onAnswer: (choice: PromptChoice) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { prompt } = state;
  async function send(choice: PromptChoice) {
    setBusy(true);
    setError("");
    try {
      await onAnswer(choice);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const waiting = !state.answered;
  const frame = {
    gap: 8,
    padding: 12,
    marginTop: 6,
    borderRadius: radius.xl,
    borderWidth: 1,
    backgroundColor: waiting ? colors.warningBg : colors.surface,
    borderColor: waiting ? colors.warningLine : colors.line,
    alignSelf: "stretch" as const,
    maxWidth: 560,
  };
  if (prompt.kind === "approval")
    return (
      <View accessibilityRole={waiting ? "alert" : undefined} style={frame}>
        <View style={[s.row, { gap: 8, alignItems: "flex-start" }]}>
          <ShieldCheck size={16} color={colors.text} />
          <Text selectable style={[s.text, { flex: 1, fontWeight: "600" }]}>
            {prompt.title}
          </Text>
        </View>
        {!!prompt.detail && (
          <Text
            selectable
            numberOfLines={waiting ? 8 : 2}
            style={[s.small, { fontFamily: "monospace" }]}
          >
            {prompt.detail}
          </Text>
        )}
        {waiting ? (
          canAnswer ? (
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              <Button
                small
                primary
                busy={busy}
                disabled={busy}
                onPress={() => void send({ reply: "once" })}
              >
                Allow once
              </Button>
              <Button small danger disabled={busy} onPress={() => void send({ reply: "reject" })}>
                Turn down
              </Button>
            </View>
          ) : (
            <Text style={s.small}>The agent is paused until a teammate decides.</Text>
          )
        ) : (
          <Text style={s.small}>{resolution(state)}</Text>
        )}
        <ErrorNotice error={error} />
      </View>
    );
  return (
    <QuestionCard
      frame={frame}
      questions={prompt.questions}
      state={state}
      canAnswer={canAnswer}
      busy={busy}
      error={error}
      onSend={send}
    />
  );
}

function QuestionCard({
  frame,
  questions,
  state,
  canAnswer,
  busy,
  error,
  onSend,
}: {
  frame: object;
  questions: Asked[];
  state: PromptState;
  canAnswer: boolean;
  busy: boolean;
  error: string;
  onSend: (choice: PromptChoice) => Promise<void>;
}) {
  const [picks, setPicks] = useState<Pick[]>(() => questions.map(() => ({ chosen: [], own: "" })));
  const waiting = !state.answered;
  const may = waiting && canAnswer;
  const change = (at: number, next: (pick: Pick) => Pick) =>
    setPicks((all) => all.map((one, i) => (i === at ? next(one) : one)));
  const answers = questions.map((_, i) => answerOf(picks[i] ?? { chosen: [], own: "" }));
  const ready = answers.every((a) => a.length > 0);
  return (
    <View accessibilityRole={waiting ? "alert" : undefined} style={frame}>
      {questions.map((asked, at) => (
        <View key={asked.question} style={{ gap: 6 }}>
          <View style={[s.row, { gap: 8, alignItems: "center" }]}>
            <MessageCircleQuestion size={16} color={colors.text} />
            <Text style={[s.small, { flex: 1, fontWeight: "600", color: colors.text }]}>
              {asked.header || "Question"}
            </Text>
          </View>
          <Text selectable style={s.text}>
            {asked.question}
          </Text>
          {asked.options.map((option) => {
            const on = picks[at]?.chosen.includes(option.label) ?? false;
            return (
              <Pressable
                key={option.label}
                accessibilityRole={asked.multiple ? "checkbox" : "radio"}
                accessibilityState={{ checked: on, disabled: !may }}
                accessibilityLabel={option.label}
                disabled={!may || busy}
                onPress={() =>
                  change(at, (current) => ({
                    chosen: asked.multiple
                      ? on
                        ? current.chosen.filter((label) => label !== option.label)
                        : [...current.chosen, option.label]
                      : on
                        ? []
                        : [option.label],
                    own: asked.multiple ? current.own : "",
                  }))
                }
                style={[
                  { paddingVertical: 7, paddingHorizontal: 11, borderRadius: radius.lg },
                  selectedCard(on, colors.surface, colors.line),
                ]}
              >
                <Text style={s.text} numberOfLines={3}>
                  <Text style={{ fontWeight: "600" }}>{option.label}</Text>
                  {!!option.description && (
                    <Text style={{ color: colors.muted, fontSize: fontSize.caption }}>
                      {"  "}
                      {option.description}
                    </Text>
                  )}
                </Text>
              </Pressable>
            );
          })}
          {may && asked.custom !== false && (
            <TextInput
              accessibilityLabel={`Your own answer to: ${asked.question}`}
              value={picks[at]?.own ?? ""}
              onChangeText={(own) =>
                change(at, (current) => ({
                  chosen: asked.multiple ? current.chosen : [],
                  own,
                }))
              }
              editable={!busy}
              placeholder="Or write your own answer"
              placeholderTextColor={colors.muted}
              style={s.input}
            />
          )}
        </View>
      ))}
      {may ? (
        <View style={[s.row, { gap: 8 }]}>
          <Button
            small
            primary
            busy={busy}
            disabled={!ready || busy}
            onPress={() => void onSend({ answers })}
          >
            Send answer
          </Button>
          <Button small disabled={busy} onPress={() => void onSend({ dismiss: true })}>
            Skip
          </Button>
        </View>
      ) : (
        <Text style={s.small}>
          {waiting ? "The agent is paused until a teammate answers." : resolution(state)}
        </Text>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}
