import Check from "lucide-react-native/dist/esm/icons/check";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  type FlagRow,
  flagCount,
  flagDetail,
  flagOrder,
  flagWhat,
  flagWhere,
  SEVERITY_WORD,
} from "./agent-flag-text";
import { useChat } from "./chat-context";
import { ago } from "./task-board";
import { Button, Chip, colors, ErrorNotice, Pending, SectionHeading, s } from "./ui";
import { useWorkspace } from "./workspace";

/** How long ago, in words: "3m ago", or "just now". */
const when = (at: string) => {
  const how = ago(at);
  return how && how !== "just now" ? `${how} ago` : how;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Answer {
  mode: "audit" | "enforce";
  unreviewed: number;
  flags: FlagRow[];
}

/**
 * What the agent was seen to open of the workspace's own data (its database, keys, files kept for everyone,
 * other channels' folders), for an owner or admin. It is a watch and not a lock: the agent has the machine,
 * so this marks what it can see, and says who asked and where.
 */
export function AgentFlags({ owner, heading = true }: { owner: boolean; heading?: boolean }) {
  const { api } = useWorkspace();
  const { subscribe } = useChat();
  const version = useRef(0);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const request = ++version.current;
    try {
      const value = await api.request<Answer>("/chat/v1/agent-flags");
      if (request !== version.current) return;
      setAnswer(value);
      setError("");
    } catch (e) {
      if (request === version.current) setError(message(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.t === "resync" || (frame.t === "event" && frame.type === "agent-flags.changed"))
          void load();
      }),
    [subscribe, load],
  );

  async function look(id?: string) {
    setBusy(id ?? "all");
    setError("");
    try {
      await api.request(
        id
          ? `/chat/v1/agent-flags/${encodeURIComponent(id)}/review`
          : "/chat/v1/agent-flags/review",
        {},
      );
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }

  async function setMode(mode: "audit" | "enforce") {
    setBusy("mode");
    setError("");
    try {
      await api.request("/chat/v1/agent-watch", { mode }, "PUT");
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }

  const rows = [...(answer?.flags ?? [])].sort(flagOrder);
  return (
    <View style={{ gap: 12 }}>
      {heading && <SectionHeading title="Agent security alerts" />}
      <Text style={s.muted}>
        When the agent opens the workspace's own data (its database, keys, other channels' folders),
        it is marked here. The agent runs on the workspace's machine and can reach all of it, so
        this shows what was seen. Where the machine has a kernel watch, it sees reads however they
        are made.
      </Text>
      <ErrorNotice error={error} />
      {answer && (
        <View style={{ gap: 8 }}>
          <Text style={s.text}>
            {answer.mode === "enforce"
              ? "Refusing is on: a run that reaches this data is stopped on the spot, and what it read is not shown."
              : "Refusing is off: it is only marked."}
          </Text>
          <Text style={s.small}>
            What the agent asks leave for is turned down before it happens, and the rest is stopped
            as soon as it is seen. The agent has root, so it can still go around this, and one read
            can slip through before it is seen. If the kernel watch stops working, the agent is
            paused.
          </Text>
          {owner && (
            <View style={s.row}>
              <Button
                small
                busy={busy === "mode"}
                onPress={() => void setMode(answer.mode === "enforce" ? "audit" : "enforce")}
              >
                {answer.mode === "enforce" ? "Turn refusing off" : "Turn refusing on"}
              </Button>
            </View>
          )}
        </View>
      )}
      {!answer ? (
        <Pending height={72} />
      ) : (
        <View style={{ gap: 14 }}>
          <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
            <Text style={s.text}>{flagCount(answer.unreviewed)}</Text>
            {answer.unreviewed > 0 && (
              <Button small icon={Check} busy={busy === "all"} onPress={() => void look()}>
                Mark all looked at
              </Button>
            )}
          </View>
          {rows.map((flag) => (
            <View key={flag.id} style={{ gap: 6, opacity: flag.reviewedAt ? 0.6 : 1 }}>
              <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                <Chip
                  tint={flag.severity === "high" ? colors.dangerBg : colors.warningBg}
                  color={flag.severity === "high" ? colors.danger : colors.warningText}
                >
                  {SEVERITY_WORD[flag.severity]}
                </Chip>
                <Text style={s.small}>{when(flag.at)}</Text>
              </View>
              <Text style={s.text}>
                {flagWhere(flag)}. {flagWhat(flag)}.
              </Text>
              <Text style={[s.small, { fontFamily: "monospace" }]} numberOfLines={3} selectable>
                {flagDetail(flag)}
              </Text>
              {!flag.reviewedAt && (
                <View style={[s.row, { paddingTop: 2 }]}>
                  <Button small busy={busy === flag.id} onPress={() => void look(flag.id)}>
                    Looked at
                  </Button>
                </View>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
