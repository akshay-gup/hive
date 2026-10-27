import Paperclip from "lucide-react-native/dist/esm/icons/paperclip";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Workspace } from "../../../packages/domain/src";
import { type AgentTask, taskBriefLimits } from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { attachFile } from "./task-brief";
import { Button, Card, CheckRow, colors, ErrorNotice, Field, s } from "./ui";
import { useWorkspace } from "./workspace";

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * What a task needs from a person: review of a prepared action, missing details, or a decision on
 * the agent's finished work (mark it done, or send it back with changes). Every task sheet shows
 * this first, so a waiting task can be acted on wherever it was opened.
 */
export function TaskAttention({
  task,
  onBeforeOpen,
}: {
  task: AgentTask;
  /** Called before another sheet opens (for example the action review), so sheets never stack. */
  onBeforeOpen?: () => void;
}) {
  const { api, open, refresh: refreshWorkspace } = useWorkspace();
  const { mutate, refresh: refreshAgent } = useAgentWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [fieldJson, setFieldJson] = useState("");
  const [showFieldJson, setShowFieldJson] = useState(false);
  const [fields, setFields] = useState<Record<string, string | boolean>>({});
  const [changes, setChanges] = useState("");
  if (
    task.status !== "waiting_approval" &&
    task.status !== "waiting_input" &&
    task.status !== "in_review"
  )
    return null;

  const missing = Array.isArray(task.state.missingFields) ? task.state.missingFields : [];
  const fieldNames = missing
    .map((field) =>
      typeof field === "string"
        ? field
        : typeof field === "object" && field && "name" in field
          ? String(field.name)
          : "",
    )
    .filter(Boolean);

  async function submitInput() {
    setBusy(true);
    setError("");
    try {
      let parsed: Record<string, string | boolean> = fields;
      if (fieldJson.trim()) {
        const raw: unknown = JSON.parse(fieldJson);
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.values(raw).some(
            (value) => typeof value !== "string" && typeof value !== "boolean",
          )
        )
          throw new Error("Form fields must be a JSON object with text or true/false values.");
        parsed = raw as Record<string, string | boolean>;
      }
      await mutate(`/tasks/${task.id}/input`, {
        answer: answer.trim() || "Provided the requested fields.",
        fields: parsed,
      });
      setAnswer("");
      setFields({});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  /** The agent may be waiting for a file: it is added to the task, and the agent reads it on its next run. */
  async function attach() {
    setBusy(true);
    setError("");
    try {
      if (await attachFile(api, task.id)) await refreshAgent();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function review() {
    setBusy(true);
    setError("");
    try {
      await refreshWorkspace();
      const snapshot = await api.request<Workspace>("/api/workspace");
      const action = snapshot.actions.find((item) => item.id === task.actionId);
      if (!action) throw new Error("This review is not available yet. Refresh and try again.");
      onBeforeOpen?.();
      open({ type: "review", action });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  /** Run one of the decisions below, and show what went wrong if it fails. */
  async function decide(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      setChanges("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (task.status === "in_review") {
    const unread = (task.notes ?? []).filter((note) => !note.delivered).length;
    const unconfirmed = task.state.unconfirmed === true;
    const asking = changes.trim().length > 0;
    return (
      <Card style={{ backgroundColor: colors.primarySoft, gap: 12 }}>
        <Text style={s.heading}>
          {unconfirmed ? "The agent stopped without saying it was done" : "Ready for your review"}
        </Text>
        <Text style={s.muted}>
          {unconfirmed
            ? "Read what it did below. If the work is finished, mark it done. If not, say what is missing and it will carry on."
            : "Check the agent's result below. Mark it done, or say what to change and it will pick up where it left off."}
        </Text>
        {unread > 0 && (
          <Text style={s.small}>
            {unread === 1 ? "1 note has" : `${unread} notes have`} not been read by the agent yet.
          </Text>
        )}
        <Field
          label="What should change?"
          value={changes}
          onChangeText={setChanges}
          multiline
          placeholder="Leave this empty if you are happy with it…"
          style={{ minHeight: 76 }}
        />
        <ErrorNotice error={error} />
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button
            primary
            busy={busy}
            onPress={() => void decide(() => mutate(`/tasks/${task.id}/accept`, {}))}
          >
            Mark done
          </Button>
          <Button
            busy={busy}
            disabled={!asking && !unread}
            onPress={() =>
              void decide(() =>
                asking
                  ? mutate(`/tasks/${task.id}/notes`, { text: changes.trim(), run: true })
                  : api
                      .request(`/api/agent/tasks/${task.id}`, { status: "queued" }, "PATCH")
                      .then(() => refreshAgent()),
              )
            }
          >
            {asking ? "Send back with changes" : "Send notes to the agent"}
          </Button>
        </View>
      </Card>
    );
  }
  if (task.status === "waiting_approval")
    return (
      <Card style={{ backgroundColor: colors.primarySoft, gap: 12 }}>
        <Text style={s.heading}>Ready for your review</Text>
        <Text style={s.muted}>Review the exact action and account before it proceeds.</Text>
        <ErrorNotice error={error} />
        <Button primary busy={busy} onPress={() => void review()}>
          Review action
        </Button>
      </Card>
    );
  return (
    <Card style={{ backgroundColor: colors.primarySoft, gap: 12 }}>
      <Text style={s.heading}>{task.question || "A detail from you will help"}</Text>
      {fieldNames.map((name) =>
        missing.some(
          (f) => typeof f === "object" && f && f.name === name && f.type === "checkbox",
        ) ? (
          <CheckRow
            key={name}
            label={name.replace(/_/g, " ")}
            checked={Boolean(fields[name])}
            onPress={() => setFields((current) => ({ ...current, [name]: !current[name] }))}
          />
        ) : (
          <Field
            key={name}
            label={name.replace(/_/g, " ")}
            value={String(fields[name] ?? "")}
            onChangeText={(value) => setFields((current) => ({ ...current, [name]: value }))}
          />
        ),
      )}
      {!fieldNames.length && (
        <Field
          label="Your answer"
          value={answer}
          onChangeText={setAnswer}
          multiline
          placeholder="Add the missing details…"
        />
      )}
      {task.kind === "document" && !fieldNames.length && (
        <>
          <Button small onPress={() => setShowFieldJson(!showFieldJson)}>
            Form field values
          </Button>
          {showFieldJson && (
            <Field
              label="Fields (JSON: field name to value)"
              value={fieldJson}
              onChangeText={setFieldJson}
              multiline
              autoCapitalize="none"
              placeholder={'{"full_name":"Your name","consent":true}'}
            />
          )}
        </>
      )}
      <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
        <Button
          small
          icon={Paperclip}
          busy={busy}
          disabled={(task.attachments ?? []).length >= taskBriefLimits.attachments}
          onPress={() => void attach()}
        >
          Attach a file
        </Button>
        {!!task.attachments?.length && (
          <Text style={[s.small, { flex: 1 }]} numberOfLines={2}>
            {task.attachments.length === 1
              ? "1 file on this task"
              : `${task.attachments.length} files on this task`}
            : {task.attachments.map((file) => file.name).join(", ")}
          </Text>
        )}
      </View>
      <ErrorNotice error={error} />
      <Button
        primary
        busy={busy}
        disabled={!answer.trim() && !Object.keys(fields).length && !fieldJson.trim()}
        onPress={() => void submitInput()}
      >
        Continue task
      </Button>
    </Card>
  );
}
