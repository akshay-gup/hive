import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { AgentTask } from "../../../packages/domain/src/agent";
import { TaskBoardCard } from "./task-board";
import { chart, colors, fontSize, s } from "./ui";

const DAY_MS = 86_400_000;
const DAY_WIDTH = 26;
const LABEL_WIDTH = 168;
const WINDOW_DAYS = 28;

function parseDay(value: string): number {
  return Date.parse(`${value}T00:00:00Z`);
}
function todayStart(): number {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return Date.parse(`${y}-${m}-${d}T00:00:00Z`);
}
function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface PlacedTask {
  task: AgentTask;
  startOffset: number;
  endOffset: number;
  milestone: boolean;
}

/** Gantt view: 4-week window, bars for scheduled tasks, list for the rest. */
export function TaskTimeline({
  tasks,
  onSelect,
}: {
  tasks: AgentTask[];
  onSelect: (task: AgentTask) => void;
}) {
  const today = todayStart();
  // The chart fills a wide page; on a narrow one it keeps its scale and scrolls sideways.
  const [width, setWidth] = useState(0);
  const dayWidth = Math.max(DAY_WIDTH, Math.floor((width - LABEL_WIDTH) / WINDOW_DAYS));
  const dated: { task: AgentTask; startMs: number; dueMs: number | null; milestone: boolean }[] =
    [];
  const unscheduled: AgentTask[] = [];
  for (const task of tasks) {
    const startMs = task.startAt ? parseDay(task.startAt) : null;
    const dueMs = task.dueAt ? parseDay(task.dueAt) : null;
    if (startMs === null && dueMs === null) {
      unscheduled.push(task);
    } else if (startMs === null && dueMs !== null) {
      dated.push({ task, startMs: dueMs, dueMs, milestone: true });
    } else {
      dated.push({ task, startMs: startMs ?? today, dueMs, milestone: false });
    }
  }
  const earliest = dated.reduce((min, t) => Math.min(min, t.startMs), today);
  const windowStart = Math.min(earliest, today);
  const placed: PlacedTask[] = dated
    .map((t) => {
      const endMs = Math.max(t.dueMs ?? t.startMs, t.startMs);
      return {
        task: t.task,
        milestone: t.milestone,
        startOffset: Math.max(0, Math.round((t.startMs - windowStart) / DAY_MS)),
        endOffset: Math.min(WINDOW_DAYS - 1, Math.round((endMs - windowStart) / DAY_MS)),
      };
    })
    .filter((t) => t.startOffset < WINDOW_DAYS && t.endOffset >= 0)
    .sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);

  const weekStarts = [0, 7, 14, 21].map((offset) => windowStart + offset * DAY_MS);

  return (
    <View style={{ gap: 16 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ gap: 4 }}>
          <View style={[s.row, { height: 28 }]}>
            <View style={{ width: LABEL_WIDTH }} />
            <View style={[s.row, { width: WINDOW_DAYS * dayWidth }]}>
              {weekStarts.map((ms) => (
                <Text key={ms} style={[s.small, { width: 7 * dayWidth, fontWeight: "700" }]}>
                  {formatDay(ms)}
                </Text>
              ))}
            </View>
          </View>
          {placed.map((t) => {
            const barColor =
              t.task.status === "succeeded"
                ? chart.done
                : t.task.status === "failed"
                  ? colors.danger
                  : t.task.kind === "manual"
                    ? chart.manual
                    : chart.agent;
            return (
              <View key={t.task.id} style={[s.row, { minHeight: 48, alignItems: "center" }]}>
                <Text
                  style={[s.text, { width: LABEL_WIDTH, fontSize: fontSize.ui, lineHeight: 20 }]}
                  numberOfLines={2}
                >
                  {t.task.title}
                </Text>
                <View style={{ width: WINDOW_DAYS * dayWidth, justifyContent: "center" }}>
                  {t.milestone ? (
                    <View
                      style={{
                        marginLeft: t.startOffset * dayWidth,
                        width: 14,
                        height: 14,
                        borderRadius: 7,
                        backgroundColor: barColor,
                      }}
                    />
                  ) : (
                    <View
                      style={{
                        marginLeft: t.startOffset * dayWidth,
                        width: Math.max((t.endOffset - t.startOffset + 1) * dayWidth - 4, 14),
                        height: 16,
                        borderRadius: 8,
                        backgroundColor: barColor,
                      }}
                    />
                  )}
                  {!!t.task.blockedBy.length && (
                    <Text style={[s.small, { marginLeft: t.startOffset * dayWidth, marginTop: 2 }]}>
                      Blocked by {t.task.blockedBy.length}
                    </Text>
                  )}
                </View>
              </View>
            );
          })}
          {!placed.length && <Text style={s.muted}>No scheduled tasks in this window.</Text>}
        </View>
      </ScrollView>
      {!!unscheduled.length && (
        <View style={{ gap: 12 }}>
          <Text style={[s.text, { fontWeight: "700", fontSize: fontSize.ui }]}>
            Unscheduled ({unscheduled.length})
          </Text>
          {unscheduled.map((task) => (
            <TaskBoardCard key={task.id} task={task} onPress={() => onSelect(task)} />
          ))}
        </View>
      )}
    </View>
  );
}
