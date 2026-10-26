import { BellRing, Link2, MessageSquare, Paperclip, Pause } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import {
  type AgentTask,
  type TaskColumn,
  type TaskPriority,
  type TaskStatus,
  taskColumn,
} from "../../../packages/domain/src/agent";
import { elapsedLabel, needsYou, orderColumn, runStartedAt, watchRuns } from "./board-order";
import { Initial, PriorityMark } from "./task-marks";
import { Button, colors, fontSize, radius, s, type WebPressState } from "./ui";
import { useStill } from "./use-still";

const columns: { id: TaskColumn; title: string }[] = [
  { id: "todo", title: "To Do" },
  { id: "doing", title: "In Progress" },
  { id: "done", title: "Done" },
  { id: "failed", title: "Failed" },
];

export const priorityColors: Record<TaskPriority, string> = {
  low: colors.neutral,
  medium: colors.primary,
  high: colors.warning,
  urgent: colors.danger,
};

/**
 * The tint a card takes when it needs a person, or has failed, over the whole card rather than along
 * one edge of it. On the board the Failed column already says so, so only a card that waits for a
 * person is tinted there: no column holds those apart from the rest.
 */
export function attentionTint(
  task: Pick<AgentTask, "status" | "kind">,
  columns = false,
): { bg: string; line: string } | undefined {
  if (task.kind !== "manual" && needsYou(task.status))
    return { bg: colors.warningBg, line: colors.warningLine };
  if (task.status === "failed" && !columns) return { bg: colors.dangerBg, line: colors.dangerLine };
  return undefined;
}

/** The tint, laid over a card's paper and under what is written on it, so every card shows the same colour. */
export function TintLayer({ tint }: { tint?: { bg: string } }) {
  if (!tint) return null;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        backgroundColor: tint.bg,
      }}
    />
  );
}

export const statusMeta: Record<TaskStatus, { label: string; dot: string }> = {
  queued: { label: "QUEUED", dot: colors.neutral },
  running: { label: "RUNNING", dot: colors.success },
  waiting_approval: { label: "NEEDS REVIEW", dot: colors.warning },
  waiting_input: { label: "NEEDS YOU", dot: colors.warning },
  in_review: { label: "IN REVIEW", dot: colors.warning },
  scheduled: { label: "SCHEDULED", dot: colors.neutral },
  paused: { label: "PAUSED", dot: colors.neutral },
  succeeded: { label: "DONE", dot: colors.success },
  failed: { label: "FAILED", dot: colors.danger },
  cancelled: { label: "CANCELLED", dot: colors.neutral },
};

/** Manual issues read as a to-do list; agent tasks use the worker's own vocabulary. */
export function taskStatusLabel(task: Pick<AgentTask, "kind" | "status">): string {
  if (task.kind === "manual") {
    if (task.status === "queued") return "TO DO";
    if (task.status === "running") return "IN PROGRESS";
  }
  return statusMeta[task.status].label;
}

export function formatDue(dueAt: string | null | undefined): string | null {
  if (!dueAt) return null;
  const date = new Date(`${dueAt}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dueAt;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Past its due date and still open. Due dates are whole days, so a task due today is not overdue. */
export function isOverdue(task: Pick<AgentTask, "dueAt" | "status">): boolean {
  if (!task.dueAt || task.status === "succeeded" || task.status === "cancelled") return false;
  const end = new Date(`${task.dueAt}T23:59:59`);
  return !Number.isNaN(end.getTime()) && end.getTime() < Date.now();
}

export function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function excerpt(text: string | undefined | null, max = 140): string | null {
  const clean = (text ?? "").trim().replace(/\s+/g, " ");
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Counts up from `since`, once a second. Alone in its own component so only this text redraws. */
function RunClock({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text style={[s.small, { fontWeight: "700", fontVariant: ["tabular-nums"] }]}>
      {elapsedLabel(now - since)}
    </Text>
  );
}

/** The mark at the start of a card's first line: a bell when it needs a person, a spinner while it runs. */
function StatusMark({
  attention,
  running,
  dot,
}: {
  attention: boolean;
  running: boolean;
  dot: string;
}) {
  const still = useStill();
  if (attention) return <BellRing size={14} strokeWidth={2.4} color={colors.warningText} />;
  if (running && !still)
    return (
      <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator
          size="small"
          color={colors.primaryText}
          style={{ transform: [{ scale: 0.7 }] }}
        />
      </View>
    );
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />;
}

/**
 * Rich worker card: status, current activity, plan progress, and quick actions. A card that needs a
 * person is amber and has a bell, a running one has a spinner and a clock, a failed one has a red edge.
 * `seenRunning` is when the board watched the task start, for a workspace that does not record it.
 */
export function TaskBoardCard({
  task,
  onPress,
  onControl,
  seenRunning,
}: {
  task: AgentTask;
  onPress: () => void;
  onControl?: (taskId: string, action: "pause" | "resume" | "retry") => Promise<void>;
  seenRunning?: number;
}) {
  const [busy, setBusy] = useState(false);
  const manual = task.kind === "manual";
  const due = formatDue(task.dueAt);
  const meta = statusMeta[task.status];
  const runningStep = task.plan.find((step) => step.status === "running");
  const doneSteps = task.plan.filter((step) => step.status === "succeeded").length;
  const updated = ago(task.updatedAt);
  const overdue = isOverdue(task);
  const noteCount = task.notes?.length ?? 0;
  const fileCount = task.attachments?.length ?? 0;
  const attention = !manual && needsYou(task.status);
  const running = !manual && task.status === "running";
  const finished = task.status === "succeeded" || task.status === "cancelled";
  const since = running ? runStartedAt(task, seenRunning) : undefined;
  const tint = attentionTint(task, true);

  // What the card leads with under the title: the live step, a question or
  // error needing attention, or the task's own description.
  const activity =
    runningStep?.title ??
    (task.status === "waiting_input" ? task.question : null) ??
    (task.status === "failed" ? task.error : null) ??
    excerpt(
      task.status === "succeeded" || task.status === "in_review" ? task.result : task.prompt,
      120,
    );

  async function control(action: "pause" | "resume" | "retry") {
    if (!onControl || busy) return;
    setBusy(true);
    try {
      await onControl(task.id, action);
    } finally {
      setBusy(false);
    }
  }
  const pausable = ["running", "waiting_approval", "waiting_input", "scheduled"].includes(
    task.status,
  );

  return (
    <View
      style={{
        flexShrink: 0,
        backgroundColor: colors.paper,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: tint?.line ?? colors.line,
        overflow: "hidden",
      }}
    >
      {/* Under the card's buttons too, so the tint reaches its whole face. */}
      <TintLayer tint={tint} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${manual ? "issue" : "task"}: ${task.title}, ${taskStatusLabel(task).toLowerCase()}`}
        onPress={onPress}
        style={({ pressed, hovered }: WebPressState) => ({
          padding: 14,
          gap: 10,
          backgroundColor: pressed || hovered ? colors.surfaceMuted : "transparent",
        })}
      >
        <View style={[s.row, { gap: 8 }]}>
          <StatusMark attention={attention} running={running} dot={meta.dot} />
          <Text
            style={[
              s.small,
              { fontWeight: "800", letterSpacing: 0.5 },
              attention && { color: colors.warningText },
            ]}
          >
            {taskStatusLabel(task)}
          </Text>
          <View style={{ flex: 1 }} />
          {since !== undefined ? (
            <RunClock since={since} />
          ) : (
            !!updated && <Text style={s.small}>{attention ? `waiting ${updated}` : updated}</Text>
          )}
          {!manual && onControl && pausable && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Pause"
              disabled={busy}
              onPress={() => void control("pause")}
              hitSlop={8}
              style={({ hovered }: WebPressState) => ({
                width: 22,
                height: 22,
                borderRadius: 11,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: hovered ? colors.surfaceHover : "transparent",
              })}
            >
              <Pause size={13} color={colors.muted} />
            </Pressable>
          )}
        </View>
        <Text
          style={[
            s.text,
            { fontSize: fontSize.ui, lineHeight: 20, fontWeight: "600" },
            finished && { color: colors.muted },
          ]}
          numberOfLines={3}
        >
          {task.title}
        </Text>
        {!!activity && activity.trim() !== task.title.trim() && (
          <Text style={s.muted} numberOfLines={3}>
            {activity}
          </Text>
        )}
        {!manual && task.plan.length > 0 && (
          <View style={[s.row, { gap: 8 }]}>
            <View
              style={{
                flex: 1,
                height: 4,
                borderRadius: 2,
                backgroundColor: colors.line,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: meta.dot,
                  width: `${Math.round((doneSteps / task.plan.length) * 100)}%`,
                }}
              />
            </View>
            <Text style={[s.small, { fontVariant: ["tabular-nums"] }]}>
              {doneSteps}/{task.plan.length}
              {task.attempts > 1 ? ` · attempt ${task.attempts}` : ""}
            </Text>
          </View>
        )}
        <View style={[s.row, { gap: 10 }]}>
          <PriorityMark priority={task.priority} />
          {manual && <Text style={s.small}>Manual</Text>}
          {!!due && (
            <Text style={[s.small, overdue && { color: colors.danger, fontWeight: "700" }]}>
              {overdue ? `Overdue · ${due}` : due}
            </Text>
          )}
          {noteCount > 0 && (
            <View style={[s.row, { gap: 3 }]}>
              <MessageSquare size={12} color={colors.muted} />
              <Text style={s.small}>{noteCount}</Text>
            </View>
          )}
          {fileCount > 0 && (
            <View style={[s.row, { gap: 3 }]}>
              <Paperclip size={12} color={colors.muted} />
              <Text style={s.small}>{fileCount}</Text>
            </View>
          )}
          {!!task.blockedBy.length && (
            <View style={[s.row, { gap: 3 }]}>
              <Link2 size={12} color={colors.muted} />
              <Text style={s.small}>{task.blockedBy.length}</Text>
            </View>
          )}
          <View style={{ flex: 1 }} />
          {!!task.createdByName && <Initial name={task.createdByName} size={20} />}
        </View>
      </Pressable>
      {!manual && onControl && (task.status === "paused" || task.status === "failed") && (
        <View style={[s.row, { gap: 8, paddingHorizontal: 14, paddingBottom: 12 }]}>
          {task.status === "paused" && (
            <Button small disabled={busy} onPress={() => void control("resume")}>
              Resume
            </Button>
          )}
          {task.status === "failed" && (
            <Button small disabled={busy} onPress={() => void control("retry")}>
              Retry
            </Button>
          )}
        </View>
      )}
    </View>
  );
}

/** Columns grow with their cards; narrow containers scroll sideways inside the page. */
export function TaskBoard({
  tasks,
  onSelect,
  onControl,
  canControl,
}: {
  tasks: AgentTask[];
  onSelect: (task: AgentTask) => void;
  onControl?: (taskId: string, action: "pause" | "resume" | "retry") => Promise<void>;
  /** Whether the person may pause, resume or retry this task: not where its project lets them only look. */
  canControl?: (task: AgentTask) => boolean;
}) {
  const [width, setWidth] = useState(0);
  const [watch] = useState(watchRuns);
  const wide = width >= 4 * 260 + 3 * 12;
  // Measured, not flexed: a flexible column inside a sideways scroller is as wide as its widest
  // card, so on a wide page the columns ran off the edge instead of sharing it.
  const columnWidth = wide ? Math.floor(width / columns.length) : 260;
  const byColumn = (column: TaskColumn) =>
    orderColumn(tasks.filter((t) => taskColumn(t.status) === column));
  const seen = watch(tasks, Date.now());
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ minWidth: 0 }}>
      <ScrollView
        horizontal
        accessibilityLabel="Task board"
        style={{ flexGrow: 0, flexShrink: 0 }}
        showsHorizontalScrollIndicator={!wide}
        contentContainerStyle={{
          flexDirection: "row",
          alignItems: "stretch",
          flexGrow: 1,
        }}
      >
        {columns.map((column, index) => {
          const items = byColumn(column.id);
          const waiting = items.filter((task) => task.kind !== "manual" && needsYou(task.status));
          return (
            <View
              key={column.id}
              style={{
                width: columnWidth,
                minWidth: 260,
                flexShrink: 0,
                gap: 10,
                padding: 12,
                ...(index > 0 ? { borderLeftWidth: 1, borderLeftColor: colors.line } : null),
              }}
            >
              <View style={[s.row, { gap: 8, alignItems: "center", paddingHorizontal: 4 }]}>
                <Text style={[s.text, { fontWeight: "700", fontSize: fontSize.ui }]}>
                  {column.title}
                </Text>
                <View
                  style={{
                    backgroundColor: colors.surface,
                    borderRadius: radius.md,
                    paddingHorizontal: 9,
                    paddingVertical: 3,
                  }}
                >
                  <Text style={[s.small, { fontWeight: "700" }]}>{items.length}</Text>
                </View>
                {waiting.length > 0 && (
                  <View
                    style={{
                      backgroundColor: colors.warningBg,
                      borderRadius: radius.md,
                      paddingHorizontal: 9,
                      paddingVertical: 3,
                    }}
                  >
                    <Text style={[s.small, { fontWeight: "700", color: colors.warningText }]}>
                      {waiting.length} {waiting.length === 1 ? "needs" : "need"} you
                    </Text>
                  </View>
                )}
              </View>
              {items.map((task) => (
                <TaskBoardCard
                  key={task.id}
                  task={task}
                  onPress={() => onSelect(task)}
                  onControl={canControl?.(task) === false ? undefined : onControl}
                  seenRunning={seen.get(task.id)}
                />
              ))}
              {!items.length && <Text style={[s.small, { padding: 8 }]}>Nothing here.</Text>}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
