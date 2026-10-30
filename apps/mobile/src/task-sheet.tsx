import BellRing from "lucide-react-native/dist/esm/icons/bell-ring";
import ChevronDown from "lucide-react-native/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react-native/dist/esm/icons/chevron-right";
import ChevronsUpDown from "lucide-react-native/dist/esm/icons/chevrons-up-down";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import type { AgentTask } from "../../../packages/domain/src/agent";
import { needsYou } from "./board-order";
import { ago, formatDue, isOverdue } from "./task-board";
import { Initial, PriorityMark } from "./task-marks";
import {
  DAY_MS,
  dependencyLinks,
  groupTasks,
  monthSpans,
  type Placement,
  placeTask,
  type TaskGroupId,
  type TimelineScale,
  timelineWindow,
  todayStart,
} from "./task-view";
import { Button, chart, colors, fontSize, radius, Segmented, s, type WebPressState } from "./ui";
import { useStill } from "./use-still";

/** A task row, and a group's heading row: fixed heights, so the table and the chart line up. */
const ROW_BASE = 38;
/** On a phone the chart's names have two lines. */
const ROW_TALL = 46;
const GROUP = 30;
const HEAD = 52;

/** The mark at the start of a row: a bell for what needs a person, a spinner while it runs, else a dot. */
function RowMark({ task }: { task: AgentTask }) {
  const still = useStill();
  const manual = task.kind === "manual";
  if (!manual && needsYou(task.status))
    return <BellRing size={14} strokeWidth={2.4} color={colors.warningText} />;
  if (!manual && task.status === "running" && !still)
    return (
      <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator
          size="small"
          color={colors.primaryText}
          style={{ transform: [{ scale: 0.7 }] }}
        />
      </View>
    );
  const dot =
    task.status === "failed"
      ? colors.danger
      : task.status === "succeeded"
        ? colors.success
        : task.status === "running"
          ? colors.success
          : colors.neutral;
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />;
}

const stepsOf = (task: AgentTask) =>
  task.plan.length
    ? `${task.plan.filter((step) => step.status === "succeeded").length}/${task.plan.length}`
    : "";

type Row =
  | { kind: "group"; id: TaskGroupId; label: string; count: number }
  | { kind: "task"; task: AgentTask };

/** What colour a bar is, and what its writing is. */
function barPaint(task: AgentTask): { fill: string; text: string } {
  if (task.status === "failed") return { fill: colors.danger, text: colors.onPrimary };
  if (task.status === "succeeded" || task.status === "cancelled")
    return { fill: chart.done, text: colors.onPrimary };
  if (task.kind !== "manual" && needsYou(task.status))
    return { fill: colors.warning, text: colors.text };
  if (task.kind === "manual") return { fill: chart.manual, text: colors.onPrimary };
  return { fill: chart.agent, text: colors.onPrimary };
}

/** The months along the top of the chart; each name keeps to the left of what is in view, so it is never cut. */
function MonthLabels({
  spans,
  dayWidth,
  listeners,
}: {
  spans: { label: string; offset: number; days: number }[];
  dayWidth: number;
  listeners: Set<(x: number) => void>;
}) {
  const [x, setX] = useState(0);
  useEffect(() => {
    listeners.add(setX);
    return () => {
      listeners.delete(setX);
    };
  }, [listeners]);
  return (
    <View style={{ height: 26, flexDirection: "row" }}>
      {spans.map((span) => {
        const left = span.offset * dayWidth;
        const room = span.days * dayWidth;
        const long = room > 90;
        const shift = Math.min(Math.max(0, x - left), Math.max(0, room - (long ? 120 : 36)));
        return (
          <View
            key={span.label + span.offset}
            style={{ width: room, justifyContent: "center", paddingLeft: 8 + shift }}
          >
            <Text style={[s.small, { fontWeight: "700", color: colors.text }]} numberOfLines={1}>
              {long ? span.label : span.label.slice(0, 3)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * The work as one sheet: a table of tasks in groups, and beside it, if asked, the chart of when
 * they are due. The two are the same rows, so a task's bar is on its own line. On a phone the table
 * narrows to the names, which stay put while the chart slides sideways.
 */
export function TaskSheet({
  tasks,
  timeline,
  onSelect,
}: {
  tasks: AgentTask[];
  timeline: boolean;
  onSelect: (task: AgentTask) => void;
}) {
  const { width: screen } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const narrow = (width || screen) < 700;
  const ROW = narrow && timeline ? ROW_TALL : ROW_BASE;
  const phoneChart = narrow && timeline;
  const [collapsed, setCollapsed] = useState<Set<TaskGroupId>>(() => new Set(["done"]));
  const [scale, setScale] = useState<TimelineScale>("weeks");
  const scroller = useRef<ScrollView>(null);
  // The month names stay in view as the chart slides, so each tells the listeners where it is.
  const scrollListeners = useRef(new Set<(x: number) => void>());
  const today = todayStart();

  const groups = useMemo(() => groupTasks(tasks), [tasks]);
  const rows: Row[] = useMemo(() => {
    const flat: Row[] = [];
    for (const group of groups) {
      flat.push({ kind: "group", id: group.id, label: group.label, count: group.tasks.length });
      if (!collapsed.has(group.id))
        for (const task of group.tasks) flat.push({ kind: "task", task });
    }
    return flat;
  }, [groups, collapsed]);
  const toggle = (id: TaskGroupId) =>
    setCollapsed((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The columns the table has: with the chart beside it, only what fits.
  const showTable = !timeline && !narrow;
  const leftWidth = timeline ? (narrow ? 150 : Math.min(360, Math.floor(width * 0.34))) : undefined;
  const dayWidth = scale === "weeks" ? (narrow ? 26 : 30) : narrow ? 8 : 9;
  const window = useMemo(() => timelineWindow(tasks, today, scale), [tasks, today, scale]);
  const chartWidth = window.days * dayWidth;

  const rowTops: number[] = [];
  let bodyHeight = 0;
  for (const row of rows) {
    rowTops.push(bodyHeight);
    bodyHeight += row.kind === "group" ? GROUP : ROW;
  }
  const placed = new Map<string, { row: number; place: Placement }>();
  rows.forEach((row, index) => {
    if (row.kind !== "task") return;
    const place = placeTask(row.task, window.start);
    if (place) placed.set(row.task.id, { row: index, place });
  });
  const links = dependencyLinks(
    rows.flatMap((row) => (row.kind === "task" ? [row.task] : [])),
    new Set(placed.keys()),
  );

  const toToday = () =>
    scroller.current?.scrollTo({ x: Math.max(0, (window.today - 2) * dayWidth), animated: true });
  // The chart opens at today, and again when its scale changes.
  useEffect(() => {
    if (!timeline) return;
    const timer = setTimeout(
      () =>
        scroller.current?.scrollTo({
          x: Math.max(0, (window.today - 2) * dayWidth),
          animated: false,
        }),
      30,
    );
    return () => clearTimeout(timer);
  }, [timeline, scale, window.start, dayWidth]);

  const tint = (task: AgentTask) =>
    task.kind !== "manual" && needsYou(task.status) ? colors.warningBg : undefined;

  const groupRow = (row: Extract<Row, { kind: "group" }>) => (
    <Pressable
      key={`g-${row.id}`}
      accessibilityRole="button"
      accessibilityState={{ expanded: !collapsed.has(row.id) }}
      accessibilityLabel={`${row.label}, ${row.count}`}
      // The row is 30 high, under the size of a thumb: the touch reaches a little beyond it.
      hitSlop={{ top: 7, bottom: 7 }}
      onPress={() => toggle(row.id)}
      style={({ hovered }: WebPressState) => ({
        height: GROUP,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 12,
        backgroundColor: hovered ? colors.surfaceHover : colors.surfaceMuted,
      })}
    >
      {collapsed.has(row.id) ? (
        <ChevronRight size={14} color={colors.muted} />
      ) : (
        <ChevronDown size={14} color={colors.muted} />
      )}
      <Text
        style={[
          s.small,
          { fontWeight: "700", color: row.id === "needs" ? colors.warningText : colors.text },
        ]}
      >
        {row.label}
      </Text>
      <Text style={s.small}>{row.count}</Text>
    </Pressable>
  );

  const taskRow = (task: AgentTask) => {
    const overdue = isOverdue(task);
    const due = formatDue(task.dueAt);
    const steps = stepsOf(task);
    const finished = task.status === "succeeded" || task.status === "cancelled";
    const from = task.createdByName ?? "";
    const to = task.assignee === "agent" ? "Agent" : (task.assigneeName ?? "");
    const title = (
      <Text
        style={[
          s.text,
          phoneChart
            ? { flex: 1, minWidth: 0, fontSize: fontSize.small, lineHeight: 15 }
            : { flex: 1, minWidth: 0, fontSize: fontSize.ui },
          finished && { color: colors.muted },
        ]}
        numberOfLines={phoneChart ? 2 : 1}
      >
        {task.title}
      </Text>
    );
    // A phone with no chart has room for two lines: the title, then what it is.
    if (narrow && !timeline)
      return (
        <Pressable
          key={task.id}
          accessibilityRole="button"
          accessibilityLabel={`Open task: ${task.title}`}
          onPress={() => onSelect(task)}
          style={({ pressed }: WebPressState) => ({
            paddingVertical: 10,
            paddingHorizontal: 16,
            gap: 3,
            borderBottomWidth: 1,
            borderBottomColor: colors.line,
            backgroundColor: tint(task) ?? (pressed ? colors.surfaceMuted : "transparent"),
          })}
        >
          <View style={[s.row, { gap: 10 }]}>
            <RowMark task={task} />
            <Text
              style={[s.text, { flex: 1, fontWeight: "500" }, finished && { color: colors.muted }]}
              numberOfLines={2}
            >
              {task.title}
            </Text>
          </View>
          <View style={[s.row, { gap: 8, paddingLeft: 24, flexWrap: "wrap" }]}>
            {!!from && <Text style={s.small}>{from}</Text>}
            {!!to && <Text style={s.small}>→ {to}</Text>}
            {!!steps && <Text style={s.small}>{steps} steps</Text>}
            {!!due && (
              <Text style={[s.small, overdue && { color: colors.danger, fontWeight: "700" }]}>
                {overdue ? `Overdue · ${due}` : `Due ${due}`}
              </Text>
            )}
            <View style={{ flex: 1 }} />
            <Text style={s.small}>{ago(task.updatedAt)}</Text>
          </View>
        </Pressable>
      );
    return (
      <Pressable
        key={task.id}
        accessibilityRole="button"
        accessibilityLabel={`Open task: ${task.title}`}
        onPress={() => onSelect(task)}
        style={({ hovered, pressed }: WebPressState) => ({
          height: ROW,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.line,
          backgroundColor: tint(task) ?? (hovered || pressed ? colors.surfaceMuted : "transparent"),
        })}
      >
        <RowMark task={task} />
        {title}
        {!!steps && !narrow && (
          <Text style={[s.small, { fontVariant: ["tabular-nums"] }]}>{steps}</Text>
        )}
        {showTable && (
          <>
            <View style={[s.row, { width: 130, gap: 8 }]}>
              {!!from && <Initial name={from} />}
              <Text style={[s.small, { flex: 1 }]} numberOfLines={1}>
                {from}
              </Text>
            </View>
            <View style={[s.row, { width: 130, gap: 8 }]}>
              {!!to && <Initial name={to} />}
              <Text
                style={[s.small, { flex: 1 }, task.assignedToMe && { fontWeight: "700" }]}
                numberOfLines={1}
              >
                {task.assignedToMe ? "You" : to}
              </Text>
            </View>
            <View style={{ width: 28 }}>
              <PriorityMark priority={task.priority} />
            </View>
            <Text
              style={[
                s.small,
                { width: 84 },
                overdue && { color: colors.danger, fontWeight: "700" },
              ]}
              numberOfLines={1}
            >
              {due ?? "—"}
            </Text>
            <Text style={[s.small, { width: 72, textAlign: "right" }]}>{ago(task.updatedAt)}</Text>
          </>
        )}
        {timeline && !narrow && (
          <Text
            style={[s.small, { width: 52 }, overdue && { color: colors.danger, fontWeight: "700" }]}
            numberOfLines={1}
          >
            {due ?? "—"}
          </Text>
        )}
      </Pressable>
    );
  };

  const head = (
    <View
      style={{
        height: timeline ? HEAD : 30,
        flexDirection: "row",
        alignItems: timeline ? "flex-end" : "center",
        gap: 10,
        paddingHorizontal: 12,
        paddingBottom: timeline ? 8 : 0,
        borderBottomWidth: 1,
        borderBottomColor: colors.line,
      }}
    >
      {phoneChart ? (
        <View style={{ flex: 1, gap: 4 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Scale: ${scale}. Tap to change`}
            onPress={() => setScale(scale === "weeks" ? "months" : "weeks")}
            style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
          >
            <Text style={[s.small, { fontWeight: "700", color: colors.text }]}>
              {scale === "weeks" ? "Weeks" : "Months"}
            </Text>
            <ChevronsUpDown size={12} color={colors.muted} />
          </Pressable>
          <Pressable accessibilityRole="button" onPress={toToday}>
            <Text style={[s.small, { fontWeight: "700", color: colors.primaryText }]}>Today</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={[s.label, { flex: 1 }]}>Task</Text>
      )}
      {showTable && (
        <>
          <Text style={[s.label, { width: 130 }]}>Reporter</Text>
          <Text style={[s.label, { width: 130 }]}>Assignee</Text>
          <Text style={[s.label, { width: 28 }]}> </Text>
          <Text style={[s.label, { width: 84 }]}>Due</Text>
          <Text style={[s.label, { width: 72, textAlign: "right" }]}>Updated</Text>
        </>
      )}
      {timeline && !narrow && <Text style={[s.label, { width: 52 }]}>Due</Text>}
    </View>
  );

  // The chart: columns for the days, today's line, a bar for each task that has dates.
  const spans = monthSpans(window);
  const weekStarts: number[] = [];
  for (let d = 0; d < window.days; d += 7) weekStarts.push(d);
  const dayOfWeek = (offset: number) =>
    (new Date(window.start + offset * DAY_MS).getUTCDay() + 6) % 7;
  const rowCentre = (index: number) => rowTops[index] + ROW / 2;
  const chartBody = (
    <View style={{ width: chartWidth, height: bodyHeight }}>
      {Array.from({ length: window.days }, (_, d) =>
        dayOfWeek(d) >= 5 ? (
          <View
            // The weekend columns are fixed by the window.
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed
            key={d}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: d * dayWidth,
              width: dayWidth,
              top: 0,
              bottom: 0,
              backgroundColor: colors.surfaceMuted,
            }}
          />
        ) : null,
      )}
      {rows.map((row, index) =>
        row.kind === "group" ? (
          <View
            key={`cg-${row.id}`}
            style={{
              position: "absolute",
              top: rowTops[index],
              left: 0,
              right: 0,
              height: GROUP,
              backgroundColor: colors.surfaceMuted,
            }}
          />
        ) : (
          <View
            key={`cr-${row.task.id}`}
            style={{
              position: "absolute",
              top: rowTops[index],
              left: 0,
              right: 0,
              height: ROW,
              borderBottomWidth: 1,
              borderBottomColor: colors.line,
              backgroundColor: tint(row.task),
            }}
          />
        ),
      )}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: window.today * dayWidth + dayWidth / 2 - 1,
          width: 2,
          top: 0,
          bottom: 0,
          backgroundColor: colors.primary,
          opacity: 0.55,
        }}
      />
      {links.length > 0 && (
        <Svg
          pointerEvents="none"
          width={chartWidth}
          height={bodyHeight}
          style={{ position: "absolute", top: 0, left: 0 }}
        >
          {links.map((link) => {
            const from = placed.get(link.from);
            const to = placed.get(link.to);
            if (!from || !to) return null;
            const x1 =
              (from.place.endOffset + 1) * dayWidth - (from.place.milestone ? dayWidth / 2 : 2);
            const x2 = to.place.startOffset * dayWidth + (to.place.milestone ? dayWidth / 2 : 2);
            const y1 = rowCentre(from.row);
            const y2 = rowCentre(to.row);
            const bend = Math.max(18, Math.abs(x2 - x1) / 2);
            return (
              <Path
                key={`${link.from}-${link.to}`}
                d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 4} ${y2} M ${x2 - 8} ${y2 - 3.5} L ${x2 - 2} ${y2} L ${x2 - 8} ${y2 + 3.5}`}
                stroke={colors.lineStrong}
                strokeWidth={1.4}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
        </Svg>
      )}
      {rows.map((row, index) => {
        if (row.kind !== "task") return null;
        const found = placed.get(row.task.id);
        if (!found) return null;
        const { place } = found;
        const paint = barPaint(row.task);
        const top = rowTops[index] + (ROW - 22) / 2;
        const done = row.task.plan.filter((step) => step.status === "succeeded").length;
        const share = row.task.plan.length ? done / row.task.plan.length : 0;
        if (place.milestone)
          return (
            <Pressable
              key={`b-${row.task.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Open task: ${row.task.title}`}
              onPress={() => onSelect(row.task)}
              style={{
                position: "absolute",
                top,
                left: place.startOffset * dayWidth + dayWidth / 2 - 8,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                height: 22,
              }}
            >
              <View
                style={{
                  width: 13,
                  height: 13,
                  backgroundColor: paint.fill,
                  transform: [{ rotate: "45deg" }],
                  borderRadius: 2,
                }}
              />
              <Text style={[s.small, { color: colors.text }]} numberOfLines={1}>
                {row.task.title}
              </Text>
            </Pressable>
          );
        const barWidth = Math.max((place.endOffset - place.startOffset + 1) * dayWidth - 3, 16);
        return (
          <Pressable
            key={`b-${row.task.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Open task: ${row.task.title}`}
            onPress={() => onSelect(row.task)}
            style={{
              position: "absolute",
              top,
              left: place.startOffset * dayWidth + 1,
              width: barWidth,
              height: 22,
              borderRadius: 6,
              backgroundColor: paint.fill,
              overflow: "hidden",
              justifyContent: "center",
            }}
          >
            {share > 0 && (
              <View
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: `${share * 100}%`,
                  backgroundColor: colors.barDone,
                }}
              />
            )}
            {barWidth > 56 && (
              <Text
                style={{
                  fontSize: fontSize.caption,
                  color: paint.text,
                  paddingHorizontal: 8,
                  fontWeight: "600",
                }}
                numberOfLines={1}
              >
                {row.task.title}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
  const chartHead = (
    <View
      style={{
        height: HEAD,
        width: chartWidth,
        borderBottomWidth: 1,
        borderBottomColor: colors.line,
      }}
    >
      <MonthLabels spans={spans} dayWidth={dayWidth} listeners={scrollListeners.current} />
      <View style={{ height: 26, flexDirection: "row" }}>
        {scale === "weeks"
          ? Array.from({ length: window.days }, (_, d) => {
              const date = new Date(window.start + d * DAY_MS);
              const isToday = d === window.today;
              return (
                <View
                  // One cell for each day of the window.
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed
                  key={d}
                  style={{ width: dayWidth, alignItems: "center", justifyContent: "center" }}
                >
                  <View
                    style={{
                      minWidth: 22,
                      height: 20,
                      borderRadius: 10,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: isToday ? colors.primary : "transparent",
                    }}
                  >
                    <Text
                      style={{
                        fontSize: fontSize.caption,
                        color: isToday
                          ? colors.onPrimary
                          : dayOfWeek(d) >= 5
                            ? colors.muted
                            : colors.text,
                        fontWeight: isToday ? "700" : "400",
                      }}
                    >
                      {date.getUTCDate()}
                    </Text>
                  </View>
                </View>
              );
            })
          : weekStarts.map((d) => (
              <View
                key={d}
                style={{ width: 7 * dayWidth, justifyContent: "center", paddingLeft: 6 }}
              >
                <Text style={[s.small, { fontSize: fontSize.micro }]} numberOfLines={1}>
                  {new Date(window.start + d * DAY_MS).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  })}
                </Text>
              </View>
            ))}
      </View>
    </View>
  );

  return (
    <View style={{ gap: 10 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {timeline && !narrow && (
        <View style={[s.row, { gap: 8, justifyContent: "flex-end" }]}>
          <Segmented
            label="Scale"
            value={scale}
            onChange={setScale}
            options={[
              { id: "weeks", label: "Weeks" },
              { id: "months", label: "Months" },
            ]}
          />
          <Button small onPress={toToday}>
            Today
          </Button>
        </View>
      )}
      <View
        style={[
          { flexDirection: "row", overflow: "hidden", backgroundColor: colors.paper },
          narrow && !timeline
            ? { marginHorizontal: -22, borderTopWidth: 1, borderTopColor: colors.line }
            : { borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg },
        ]}
      >
        <View style={timeline ? { width: leftWidth } : { flex: 1 }}>
          {!(narrow && !timeline) && head}
          {rows.map((row) => (row.kind === "group" ? groupRow(row) : taskRow(row.task)))}
        </View>
        {timeline && (
          <ScrollView
            ref={scroller}
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={32}
            onScroll={(event) => {
              for (const listener of scrollListeners.current)
                listener(event.nativeEvent.contentOffset.x);
            }}
            style={{ flex: 1, borderLeftWidth: 1, borderLeftColor: colors.line }}
          >
            <View>
              {chartHead}
              {chartBody}
            </View>
          </ScrollView>
        )}
      </View>
    </View>
  );
}
