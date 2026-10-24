import { MessageCircleQuestion } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useGuest } from "./access";
import { Button, colors, ErrorNotice, fontSize, radius, s, selectedCard } from "./ui";
import { useWorkspace } from "./workspace";

interface AskedQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
}

interface PendingQuestion {
  requestId: string;
  questions: AskedQuestion[];
  askedAt: number;
  channelId: string;
}

/** What the person has picked or written for one question. */
interface Pick {
  chosen: string[];
  own: string;
}

const none: Pick = { chosen: [], own: "" };

/** The words that answer a question: what was picked, and what was written beside it. */
function answerOf(pick: Pick): string[] {
  const own = pick.own.trim();
  return own ? [...pick.chosen, own] : pick.chosen;
}

/**
 * The agent's own questions, as a card in the conversation. The agent is paused until the person
 * answers or skips; a skip lets it go on without the answer. Polls like the approvals above it.
 */
export function PendingQuestions({ threadId }: { threadId: string }) {
  const { api } = useWorkspace();
  const guest = useGuest();
  const [pending, setPending] = useState<PendingQuestion[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setPending(
        await api.request<PendingQuestion[]>(
          `/api/agent/opencode/threads/${threadId}/questions/pending`,
        ),
      );
    } catch {
      // A 404 means there is nothing to ask about here; any other failure is tried again in a moment.
      setPending(null);
    }
  }, [api, threadId]);

  useEffect(() => {
    setPending(null);
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [load]);

  if (!pending?.length) return null;
  return (
    <View style={{ gap: 10, marginBottom: 10 }}>
      <ErrorNotice error={error} />
      {pending.map((request) => (
        <QuestionCard
          key={request.requestId}
          request={request}
          guest={guest}
          onError={setError}
          onDone={() => {
            setError("");
            void load();
          }}
        />
      ))}
    </View>
  );
}

function QuestionCard({
  request,
  guest,
  onError,
  onDone,
}: {
  request: PendingQuestion;
  guest: boolean;
  onError: (message: string) => void;
  onDone: () => void;
}) {
  const { api } = useWorkspace();
  const { height } = useWindowDimensions();
  const [picks, setPicks] = useState<Pick[]>(() => request.questions.map(() => none));
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const answers = request.questions.map((_, i) => answerOf(picks[i] ?? none));
  const total = request.questions.length;
  const last = step >= total - 1;
  const asked = request.questions[step];
  const pick = picks[step] ?? none;

  const change = (next: (pick: Pick) => Pick) =>
    setPicks((all) => all.map((one, i) => (i === step ? next(one) : one)));

  async function send(body: { answers: string[][] } | { dismiss: true }) {
    setBusy(true);
    onError("");
    try {
      await api.request(`/api/agent/opencode/questions/${request.requestId}/reply`, body);
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!asked) return null;
  return (
    <View
      accessibilityRole="alert"
      style={{
        gap: 10,
        padding: 12,
        backgroundColor: colors.surface,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.lineStrong,
      }}
    >
      <View style={[s.row, { gap: 8, alignItems: "center" }]}>
        <MessageCircleQuestion size={16} color={colors.text} />
        <Text style={[s.small, { flex: 1, fontWeight: "600", color: colors.text }]}>
          {asked.header || "Question"}
        </Text>
        {total > 1 && (
          <Text style={s.small}>
            {step + 1} of {total}
          </Text>
        )}
      </View>
      {/* Only this part scrolls, so a long list of options never pushes the conversation off screen. */}
      <ScrollView
        style={{ maxHeight: Math.max(150, Math.min(300, height * 0.34)) }}
        contentContainerStyle={{ gap: 6 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
      >
        <Text selectable style={[s.text, { fontSize: fontSize.ui, marginBottom: 2 }]}>
          {asked.question}
        </Text>
        {asked.options.map((option) => {
          const on = pick.chosen.includes(option.label);
          return (
            <Pressable
              key={option.label}
              accessibilityRole={asked.multiple ? "checkbox" : "radio"}
              accessibilityState={{ checked: on, disabled: guest }}
              accessibilityLabel={option.label}
              disabled={guest || busy}
              onPress={() =>
                change((current) => ({
                  // Picking one thing replaces another and what was written, unless more than one may be picked.
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
        {asked.custom !== false && !guest && (
          <TextInput
            accessibilityLabel={`Your own answer to: ${asked.question}`}
            placeholder={asked.options.length ? "Something else…" : "Your answer…"}
            placeholderTextColor={colors.muted}
            value={pick.own}
            editable={!busy}
            onChangeText={(own) =>
              change((current) => ({
                chosen: asked.multiple ? current.chosen : [],
                own,
              }))
            }
            style={[s.input, { paddingVertical: 8, minHeight: 36 }]}
          />
        )}
      </ScrollView>
      {guest ? (
        <Text style={s.small}>The agent is paused until a teammate answers.</Text>
      ) : (
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          {last ? (
            <Button
              small
              primary
              busy={busy}
              disabled={!answers.every((answer) => answer.length > 0)}
              onPress={() => void send({ answers })}
            >
              Send answer
            </Button>
          ) : (
            <Button
              small
              primary
              disabled={!answers[step]?.length}
              onPress={() => setStep((n) => n + 1)}
            >
              Next
            </Button>
          )}
          {step > 0 && (
            <Button small disabled={busy} onPress={() => setStep((n) => n - 1)}>
              Back
            </Button>
          )}
          <Button small disabled={busy} onPress={() => void send({ dismiss: true })}>
            Skip
          </Button>
        </View>
      )}
    </View>
  );
}
