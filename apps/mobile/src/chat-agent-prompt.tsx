import Check from "lucide-react-native/dist/esm/icons/check";
import MessageCircleQuestion from "lucide-react-native/dist/esm/icons/message-circle-question";
import ShieldCheck from "lucide-react-native/dist/esm/icons/shield-check";
import X from "lucide-react-native/dist/esm/icons/x";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PromptChoice, PromptState, RunPrompt } from "../../../packages/domain/src/chat-agent";
import { TaskProjectChoice } from "./task-project-choice";
import { Button, colors, ErrorNotice, fontSize, radius, s, selectedCard } from "./ui";
import { useWorkspace } from "./workspace";

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

/** What an answered prompt leaves behind: one line with what was decided, not the card it came from. */
function settled(state: PromptState): { ok: boolean; parts: { label: string; value: string }[] } {
  const { prompt, answered } = state;
  const choice = answered?.choice;
  if (prompt.kind === "task_project")
    return {
      ok: !!choice && "reply" in choice && choice.reply === "once",
      parts: [
        {
          label: prompt.title,
          value:
            choice && "reply" in choice && choice.reply === "once"
              ? "Task created"
              : "Task not created",
        },
      ],
    };
  if (prompt.kind === "approval" && choice && "reply" in choice)
    return {
      ok: choice.reply === "once",
      parts: [{ label: prompt.title, value: choice.reply === "once" ? "Allowed" : "Turned down" }],
    };
  if (prompt.kind === "question" && choice && "answers" in choice)
    return {
      ok: true,
      parts: prompt.questions.map((asked, i) => ({
        label: asked.header || asked.question,
        value: choice.answers[i]?.join(", ") || "Skipped",
      })),
    };
  return {
    ok: false,
    parts: [{ label: "", value: answered?.by === "agent" ? "No longer needed" : "Skipped" }],
  };
}

function SettledPrompt({ state }: { state: PromptState }) {
  const { ok, parts } = settled(state);
  const Mark = ok ? Check : X;
  return (
    <View style={{ marginTop: 4, gap: 2, alignSelf: "stretch", maxWidth: 560 }}>
      {parts.map((part) => (
        <View key={`${part.label}:${part.value}`} style={[s.row, { gap: 6, alignItems: "center" }]}>
          <Mark size={14} color={colors.muted} />
          <Text numberOfLines={2} style={[s.small, { flex: 1 }]}>
            {!!part.label && `${part.label} · `}
            <Text style={{ color: colors.text, fontWeight: "600" }}>{part.value}</Text>
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * What the agent is waiting on, as a card in its reply: to be allowed to do something, or a question.
 * Anyone in the channel but a guest can decide (the first answer is taken); once answered it says who did.
 */
export function ChatAgentPrompt({
  state,
  canAnswer,
  onAnswer,
  viewerId,
}: {
  state: PromptState;
  canAnswer: boolean;
  onAnswer: (choice: PromptChoice) => Promise<void>;
  viewerId?: string;
}) {
  const { open } = useWorkspace();
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
  if (state.answered) return <SettledPrompt state={state} />;
  if (prompt.kind === "task_project")
    return (
      <View
        style={{
          padding: 14,
          marginTop: 6,
          gap: 10,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.lineStrong,
          backgroundColor: colors.paper,
          alignSelf: "stretch",
          maxWidth: 560,
        }}
      >
        <Text style={s.heading}>Choose a project for this task</Text>
        {viewerId === prompt.askedBy ? (
          <TaskProjectChoice
            requestId={prompt.id}
            onCreated={(taskId) => open({ type: "task", taskId })}
          />
        ) : (
          <Text style={s.muted}>
            The person who asked chooses the project and reviews who can see the task.
          </Text>
        )}
      </View>
    );
  const frame = {
    gap: 8,
    padding: 12,
    marginTop: 6,
    borderRadius: radius.xl,
    borderWidth: 1,
    backgroundColor: colors.warningBg,
    borderColor: colors.warningLine,
    alignSelf: "stretch" as const,
    maxWidth: 560,
  };
  if (prompt.kind === "approval")
    return (
      <View accessibilityRole="alert" style={frame}>
        <View style={[s.row, { gap: 8, alignItems: "flex-start" }]}>
          <ShieldCheck size={16} color={colors.text} />
          <Text selectable style={[s.text, { flex: 1, fontWeight: "600" }]}>
            {prompt.title}
          </Text>
        </View>
        {!!prompt.detail && (
          <Text selectable numberOfLines={8} style={[s.small, { fontFamily: "monospace" }]}>
            {prompt.detail}
          </Text>
        )}
        {canAnswer ? (
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
        )}
        <ErrorNotice error={error} />
      </View>
    );
  return (
    <QuestionCard
      frame={frame}
      questions={prompt.questions}
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
  canAnswer,
  busy,
  error,
  onSend,
}: {
  frame: object;
  questions: Asked[];
  canAnswer: boolean;
  busy: boolean;
  error: string;
  onSend: (choice: PromptChoice) => Promise<void>;
}) {
  const [picks, setPicks] = useState<Pick[]>(() => questions.map(() => ({ chosen: [], own: "" })));
  const may = canAnswer;
  const change = (at: number, next: (pick: Pick) => Pick) =>
    setPicks((all) => all.map((one, i) => (i === at ? next(one) : one)));
  const answers = questions.map((_, i) => answerOf(picks[i] ?? { chosen: [], own: "" }));
  const ready = answers.every((a) => a.length > 0);
  return (
    <View accessibilityRole="alert" style={frame}>
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
        <Text style={s.small}>The agent is paused until a teammate answers.</Text>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}
