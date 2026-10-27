import ArrowRight from "lucide-react-native/dist/esm/icons/arrow-right";
import Bell from "lucide-react-native/dist/esm/icons/bell";
import CalendarDays from "lucide-react-native/dist/esm/icons/calendar-days";
import ChevronDown from "lucide-react-native/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react-native/dist/esm/icons/chevron-right";
import CircleCheck from "lucide-react-native/dist/esm/icons/circle-check";
import Globe2 from "lucide-react-native/dist/esm/icons/earth";
import FileText from "lucide-react-native/dist/esm/icons/file-text";
import Lightbulb from "lucide-react-native/dist/esm/icons/lightbulb";
import ListChecks from "lucide-react-native/dist/esm/icons/list-checks";
import Mail from "lucide-react-native/dist/esm/icons/mail";
import Pause from "lucide-react-native/dist/esm/icons/pause";
import Play from "lucide-react-native/dist/esm/icons/play";
import Plus from "lucide-react-native/dist/esm/icons/plus";
import RefreshCw from "lucide-react-native/dist/esm/icons/refresh-cw";
import Settings from "lucide-react-native/dist/esm/icons/settings";
import Target from "lucide-react-native/dist/esm/icons/target";
import X from "lucide-react-native/dist/esm/icons/x";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import type { Artifact, BrowserSession } from "../../../packages/domain/src";
import type {
  AgentArtifact,
  AgentMemory,
  AgentTask,
  Evidence,
  Goal,
  Idea,
  Monitor,
  RunEvent,
} from "../../../packages/domain/src/agent";
import { useGuest } from "./access";
import { useActivityProjects } from "./activity-projects";
import { useAgentWorkspace } from "./agent-workspace";
import { needsYou } from "./board-order";
import { useLineMaxWidth } from "./line-width";
import { PermissionsSettings } from "./opencode-permissions";
import { ProjectPeopleStack } from "./project-header";
import { canChangeTask } from "./project-text";
import { ActivityScreen, ConnectionsScreen } from "./screens";
import { useServerFeature } from "./server-features";
import { TaskAttention } from "./task-attention";
import {
  ago,
  attentionTint,
  formatDue,
  isOverdue,
  statusMeta,
  TaskBoard,
  TintLayer,
  taskStatusLabel,
} from "./task-board";
import { TaskCreate } from "./task-create";
import { TaskDetail as IssueDetail } from "./task-detail";
import { TaskRunView } from "./task-run";
import { TaskSheet } from "./task-sheet";
import { useMuseThread } from "./threads";
import {
  Button,
  Card,
  CheckRow,
  Chip,
  colors,
  Empty,
  ErrorNotice,
  Field,
  financeArt,
  fontSize,
  HaloDot,
  IconButton,
  LinkRow,
  Mascot,
  Pending,
  radius,
  resultSummary,
  SearchField,
  SectionHeading,
  Segmented,
  Sheet,
  s,
  type WebPressState,
} from "./ui";
import { ViewMenu } from "./view-menu";
import { useWorkspace } from "./workspace";

/** 60 -> "hour", 120 -> "2 hours", 1440 -> "day", otherwise minutes. */
function every(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "day" : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}
export function statusLabel(value: string) {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
function stamp(value?: string) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not checked yet";
}
function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
function activeTask(task: AgentTask) {
  return !["succeeded", "failed", "cancelled"].includes(task.status);
}
/** How long something has to stay wrong before it is worth saying; a blip mends itself first. */
const STATUS_GRACE_MS = 20_000;

/**
 * What is wrong with the agent, when something has been wrong for a while. The page asks every few
 * seconds and tries again by itself, so a failed ask (a phone waking up, the workspace restarting)
 * is not news and has no button to press: it only says something if it keeps going. While it is
 * still being checked it says nothing either, since a row above everything else that is taken away
 * a moment later makes the whole screen below it jump.
 */
export function AgentStatus() {
  const { data, error } = useAgentWorkspace();
  const wrong = !!error || (!!data && !data.worker.running);
  const [lasting, setLasting] = useState(false);
  useEffect(() => {
    if (!wrong) {
      setLasting(false);
      return;
    }
    const timer = setTimeout(() => setLasting(true), STATUS_GRACE_MS);
    return () => clearTimeout(timer);
  }, [wrong]);
  if (!wrong || !lasting) return null;
  return (
    <View style={{ gap: 12 }}>
      <Text style={s.small}>
        {error
          ? "Can't reach your workspace right now. Trying again."
          : "The agent is offline. Saved work will continue when it reconnects."}
      </Text>
    </View>
  );
}
/**
 * A task in the middle of a conversation: one quiet line that says what it is and where it stands,
 * and opens it. The board and the task's page carry the detail; the chat is for talking.
 */
export function TaskLine({ task }: { task: AgentTask }) {
  const { open } = useWorkspace();
  const maxWidth = useLineMaxWidth();
  const done = task.plan.filter((step) => step.status === "succeeded").length;
  const tint = attentionTint(task);
  const meta = statusMeta[task.status];
  const steps = task.plan.length ? ` · ${done}/${task.plan.length} steps` : "";
  const label = taskStatusLabel(task);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open task: ${task.title}`}
      onPress={() => open({ type: "task", taskId: task.id })}
      style={({ pressed, hovered }: WebPressState) => ({
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 10,
        maxWidth,
        paddingVertical: 9,
        paddingHorizontal: 14,
        borderRadius: radius.xl,
        borderWidth: 1,
        // What needs a person, and what failed, is tinted over the whole card.
        borderColor: tint?.line ?? colors.line,
        backgroundColor: pressed || hovered ? colors.surfaceMuted : colors.paper,
        overflow: "hidden",
      })}
    >
      <TintLayer tint={tint} />
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: meta.dot }} />
      <View style={{ flexShrink: 1 }}>
        <Text style={[s.text, { fontWeight: "600" }]} numberOfLines={1}>
          {task.title}
        </Text>
        <Text style={s.small} numberOfLines={1}>
          {label.charAt(0) + label.slice(1).toLowerCase()}
          {steps}
        </Text>
      </View>
      <ChevronRight size={16} color={colors.muted} />
    </Pressable>
  );
}

export function TaskCard({
  task,
  compact = false,
  onOpen,
  onSelect,
}: {
  task: AgentTask;
  compact?: boolean;
  onOpen?: () => void;
  onSelect?: () => void;
}) {
  const { open } = useWorkspace();
  const done = task.plan.filter((step) => step.status === "succeeded").length;
  const next = task.plan.find((step) => ["running", "waiting"].includes(step.status));
  const waiting = needsYou(task.status);
  const tint = attentionTint(task);
  const meta = statusMeta[task.status];
  const updated = ago(task.updatedAt);
  const due = formatDue(task.dueAt);
  const overdue = isOverdue(task);
  const summary = task.question || task.error || resultSummary(task.result || next?.title || "");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open task: ${task.title}`}
      onPress={() => {
        if (onSelect) onSelect();
        else {
          onOpen?.();
          open({ type: "task", taskId: task.id });
        }
      }}
      style={({ pressed, hovered }: WebPressState) => ({
        gap: 8,
        padding: compact ? 12 : 14,
        borderRadius: radius.lg,
        borderWidth: 1,
        // What needs a person, and what failed, is tinted over the whole card.
        borderColor: tint?.line ?? (hovered ? colors.lineStrong : colors.line),
        backgroundColor: pressed ? colors.surfaceMuted : colors.paper,
        overflow: "hidden",
      })}
    >
      <TintLayer tint={tint} />
      <View style={[s.row, { gap: 8 }]}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: meta.dot }} />
        <Text style={[s.small, { fontWeight: "800", letterSpacing: 0.5 }]}>
          {taskStatusLabel(task)}
        </Text>
        <Text style={s.small}>· {task.kind === "manual" ? "Manual" : "Agent"}</Text>
        {!!task.createdByName && <Text style={s.small}>· {task.createdByName}</Text>}
        <View style={{ flex: 1 }} />
        {!!updated && <Text style={s.small}>{updated}</Text>}
        <ChevronRight size={16} color={colors.muted} />
      </View>
      <Text style={s.heading} numberOfLines={compact ? 2 : 3}>
        {task.title}
      </Text>
      {!!summary && (
        <Text numberOfLines={compact ? 2 : 3} style={s.muted}>
          {summary}
        </Text>
      )}
      {!!task.plan.length && (
        <View style={{ gap: 4 }}>
          <View
            style={{ height: 6, borderRadius: 3, backgroundColor: colors.line, overflow: "hidden" }}
          >
            <View
              style={{
                height: 6,
                borderRadius: 3,
                backgroundColor: meta.dot,
                width: `${Math.round((done / task.plan.length) * 100)}%`,
              }}
            />
          </View>
          <Text style={s.small}>
            {done}/{task.plan.length} steps
          </Text>
        </View>
      )}
      {(waiting || !!due) && (
        <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
          {waiting && (
            <Chip tint={colors.warningBg} color={colors.text}>
              {task.status === "waiting_approval"
                ? "Review requested"
                : task.status === "in_review"
                  ? "Ready for your review"
                  : "Your input is needed"}
            </Chip>
          )}
          {!!due && (
            <Chip
              tint={overdue ? colors.dangerBg : colors.surfaceMuted}
              color={overdue ? colors.danger : undefined}
            >
              {overdue ? `Overdue · ${due}` : `Due ${due}`}
            </Chip>
          )}
        </View>
      )}
    </Pressable>
  );
}
export function ChatWork() {
  const { data } = useAgentWorkspace();
  const tasks = [...(data?.tasks || [])]
    .filter((task) => task.kind !== "manual" && activeTask(task))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 2);
  if (!tasks.length) return null;
  return (
    <View style={{ gap: 10 }}>
      {tasks.map((task) => (
        <TaskCard task={task} key={task.id} compact />
      ))}
    </View>
  );
}
export function AgentActivityScreen() {
  const { data, refresh } = useAgentWorkspace();
  const { api } = useWorkspace();
  const { selected: projectFilter, manage } = useActivityProjects();
  const openProject =
    typeof projectFilter === "string"
      ? (data?.projects ?? []).find((project) => project.id === projectFilter)
      : undefined;
  const [onlyNeeds, setOnlyNeeds] = useState(false);
  const [view, setView] = useState<"list" | "board" | "timeline" | "activity">("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const projects = data?.projects ?? [];
  const allTasks = [...(data?.tasks || [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const projectTasks = allTasks.filter(
    (task) => projectFilter === null || task.projectId === projectFilter,
  );
  const needsYouCount = projectTasks.filter((task) => needsYou(task.status)).length;
  const tasks = onlyNeeds ? projectTasks.filter((task) => needsYou(task.status)) : projectTasks;
  const selected = selectedId ? allTasks.find((task) => task.id === selectedId) : undefined;
  const { width } = useWindowDimensions();
  const narrow = width < 700;
  const viewOptions = [
    { id: "list", label: "List" },
    { id: "board", label: "Board" },
    { id: "timeline", label: "Timeline" },
    { id: "activity", label: "Activity" },
  ] as const;
  // A phone has no room for four tabs beside the buttons: one button names the view and opens the rest.
  const viewSwitcher = narrow ? (
    <ViewMenu label="View" value={view} onChange={setView} options={[...viewOptions]} />
  ) : (
    <Segmented label="View" value={view} onChange={setView} options={[...viewOptions]} />
  );
  const needsChip = view !== "activity" && (needsYouCount > 0 || onlyNeeds) && (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: onlyNeeds }}
      accessibilityLabel={onlyNeeds ? "Show all work" : "Show only what needs you"}
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={() => setOnlyNeeds((on) => !on)}
      style={{
        height: 28,
        paddingHorizontal: 12,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: colors.warningLine,
        backgroundColor: onlyNeeds ? colors.warningBg : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: colors.warningText }}>
        {narrow ? `${needsYouCount} need you` : `Needs you · ${needsYouCount}`}
      </Text>
    </Pressable>
  );
  // The project's own controls, on its page: who is in it, adding people, its settings.
  const projectTools = openProject && (
    <View style={[s.row, { gap: 4 }]}>
      {!narrow && <ProjectPeopleStack project={openProject} onOpen={() => manage(openProject)} />}
      <IconButton
        icon={Settings}
        label={`Settings and people of ${openProject.name}`}
        onPress={() => manage(openProject)}
      />
    </View>
  );
  const newIssue = (
    <Button
      small
      primary
      icon={Plus}
      accessibilityLabel="New issue"
      style={narrow ? { gap: 0, paddingHorizontal: 10 } : undefined}
      onPress={() => setCreating(true)}
    >
      {narrow ? "" : "New issue"}
    </Button>
  );
  return (
    <View style={{ gap: 16 }}>
      <AgentStatus />
      {/* One toolbar: how to look at the work, what to narrow it to, and the new button at the right. */}
      {/* On a phone the views are one button that opens a list, so the buttons keep their row. */}
      {/* The row is as tall as the tallest thing that can be in it (a project's people and gear), so the page below does not move when one is opened. */}
      <View style={[s.row, { gap: narrow ? 8 : 12, zIndex: 20, minHeight: narrow ? 44 : 36 }]}>
        <View>{viewSwitcher}</View>
        {!narrow && needsChip}
        <View style={{ flex: 1 }} />
        {projectTools}
        {newIssue}
      </View>
      {narrow && !!needsChip && <View style={[s.row, { marginTop: -6 }]}>{needsChip}</View>}
      {(view === "list" || view === "timeline") && tasks.length > 0 && (
        <TaskSheet
          tasks={tasks}
          timeline={view === "timeline"}
          onSelect={(task) => setSelectedId(task.id)}
        />
      )}
      {(view === "list" || view === "timeline") && !tasks.length && !data && (
        // Not read yet: the empty-board message here would say there is no work, which is not known.
        <View style={[s.centred, { paddingVertical: 40 }]}>
          <ActivityIndicator color={colors.primary} accessibilityLabel="Loading the work" />
        </View>
      )}
      {(view === "list" || view === "timeline") &&
        !tasks.length &&
        !!data &&
        (projectTasks.length ? (
          <Empty
            icon={ListChecks}
            title="Nothing needs you right now"
            detail="Reviews and questions from Hive will show up here."
          />
        ) : (
          <Empty
            icon={ListChecks}
            title="A place for the work"
            detail="Delegate a task in Chat. Its plan, progress and results stay here."
          />
        ))}
      {view === "board" && (
        <TaskBoard
          tasks={tasks}
          canControl={(task) => canChangeTask(task, projects)}
          onSelect={(task) => setSelectedId(task.id)}
          onControl={async (taskId, action) => {
            await api.request(`/api/agent/tasks/${taskId}/control`, { action }, "POST");
            await refresh();
          }}
        />
      )}
      {selected && (
        <IssueDetail
          task={selected}
          tasks={allTasks}
          projects={projects}
          onClose={() => setSelectedId(null)}
        />
      )}
      {creating && <TaskCreate onClose={() => setCreating(false)} />}
      {view === "activity" && <ActivityScreen projectId={projectFilter} />}
    </View>
  );
}
export function EvidenceList({ items }: { items: Evidence[] }) {
  const { workspace, open } = useWorkspace();
  const [error, setError] = useState("");
  return (
    <View style={{ gap: 10 }}>
      {items.map((item) => (
        <View
          key={item.id}
          style={{ borderLeftWidth: 2, borderLeftColor: colors.primary, paddingLeft: 12, gap: 4 }}
        >
          <Text style={[s.small, { color: colors.text, fontWeight: "600" }]}>{item.title}</Text>
          <Text selectable style={s.small}>
            {item.excerpt}
          </Text>
          {item.url && /^https?:\/\//i.test(item.url) && (
            <Button
              small
              onPress={() =>
                void Linking.openURL(item.url || "").catch((e) => setError(errorText(e)))
              }
            >
              Open source
            </Button>
          )}
          {item.kind === "mail" && workspace.mail.some((mail) => mail.id === item.id) && (
            <Button
              small
              onPress={() => {
                const mail = workspace.mail.find((m) => m.id === item.id);
                if (mail) open({ type: "mail", mail });
              }}
            >
              View email
            </Button>
          )}
          {item.kind === "file" && workspace.files.some((file) => file.id === item.id) && (
            <Button
              small
              onPress={() => {
                const file = workspace.files.find((f) => f.id === item.id);
                if (file) open({ type: "file", file });
              }}
            >
              View file
            </Button>
          )}
        </View>
      ))}
      <ErrorNotice error={error} />
    </View>
  );
}
export function TaskDetail({ taskId }: { taskId: string }) {
  const { api, close, open } = useWorkspace();
  const { data, mutate } = useAgentWorkspace();
  // A guest looks at what the agent is doing, and does not steer it; nor does someone who may only look at its project.
  const guestRole = useGuest();
  const [detail, setDetail] = useState<{
    task: AgentTask;
    events: RunEvent[];
    artifacts: AgentArtifact[];
    files: Artifact[];
    browsers: BrowserSession[];
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const task = data?.tasks.find((item) => item.id === taskId) || detail?.task;
  const guest = guestRole || (!!task && !canChangeTask(task, data?.projects ?? []));
  useEffect(() => {
    let active = true;
    // The task is the chat service's; what its runs did (steps, files made, browser windows) is the
    // machine's, asked for through the chat service while the machine is awake.
    type RunHistory = {
      awake: boolean;
      events?: RunEvent[];
      artifacts?: AgentArtifact[];
      files?: Artifact[];
      browsers?: BrowserSession[];
    };
    void Promise.all([
      api.request<{ task: AgentTask }>(`/api/agent/tasks/${taskId}`),
      api
        .request<RunHistory>(`/chat/v1/tasks/${taskId}/run`)
        .catch((): RunHistory => ({ awake: false })),
    ])
      .then(([board, run]) => {
        if (active) {
          setDetail({
            task: board.task,
            events: run.events ?? [],
            artifacts: run.artifacts ?? [],
            files: run.files ?? [],
            browsers: run.browsers ?? [],
          });
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [api, taskId, task?.updatedAt]);
  async function act(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/tasks/${taskId}/${path}`, body);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (task?.kind === "manual")
    return (
      <IssueDetail
        task={task}
        tasks={data?.tasks ?? [task]}
        projects={data?.projects ?? []}
        onClose={close}
      />
    );
  return (
    <Sheet
      title={task?.title || "Task"}
      subtitle={
        task ? `${statusLabel(task.status)} · ${stamp(task.updatedAt)}` : "Loading saved progress…"
      }
      onClose={close}
      tall
    >
      <ErrorNotice error={error} />
      {!task ? (
        <Pending label="Loading saved progress…" height={240} />
      ) : (
        <View style={{ gap: 24 }}>
          <Text selectable style={s.text}>
            {task.prompt}
          </Text>
          {!guest && <TaskAttention task={task} />}
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }, guest && { display: "none" }]}>
            {["queued", "running", "scheduled", "waiting_input", "waiting_approval"].includes(
              task.status,
            ) && (
              <Button
                small
                icon={Pause}
                busy={busy}
                onPress={() => void act("control", { action: "pause" })}
              >
                Pause
              </Button>
            )}
            {task.status === "paused" && (
              <Button
                small
                icon={Play}
                busy={busy}
                onPress={() => void act("control", { action: "resume" })}
              >
                Resume
              </Button>
            )}
            {task.status === "failed" && (
              <Button
                small
                icon={RefreshCw}
                busy={busy}
                onPress={() => void act("control", { action: "retry" })}
              >
                Retry task
              </Button>
            )}
            {activeTask(task) && (
              <Button
                small
                danger
                icon={X}
                busy={busy}
                onPress={() => void act("control", { action: "cancel" })}
              >
                Cancel task
              </Button>
            )}
          </View>
          <TaskRunView task={task} />
          {!!task.plan.length && (
            <Card style={{ gap: 16 }}>
              <Text style={s.heading}>Plan</Text>
              {task.plan.map((step, index) => (
                <View key={step.id} style={[s.row, { gap: 10, alignItems: "flex-start" }]}>
                  <Text
                    style={[
                      s.text,
                      { color: step.status === "succeeded" ? colors.primaryText : colors.muted },
                    ]}
                  >
                    {step.status === "succeeded" ? "✓" : `${index + 1}.`}
                  </Text>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={s.text}>{step.title}</Text>
                    <Text style={s.small}>
                      {statusLabel(step.status)}
                      {step.detail ? ` · ${step.detail}` : ""}
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          )}
          <ErrorNotice error={task.error ?? undefined} />
          {detail?.browsers?.map((browser) => (
            <Card key={browser.id} style={{ gap: 10 }}>
              <Text style={s.heading}>{browser.title || "Agent browser"}</Text>
              <Text style={s.small}>{browser.url}</Text>
              {browser.status === "active" && browser.previewUrl && (
                <Image
                  accessibilityLabel="Agent browser preview"
                  source={{ uri: api.url(browser.previewUrl) }}
                  style={{ width: "100%", aspectRatio: 1.6, borderRadius: radius.xl }}
                />
              )}
              <Button
                small
                busy={busy}
                style={guest ? { display: "none" } : undefined}
                onPress={() => {
                  setBusy(true);
                  void (async () => {
                    try {
                      if (["running", "scheduled", "queued"].includes(task.status))
                        await mutate(`/tasks/${taskId}/control`, { action: "pause" });
                      open({ type: "browser", browser });
                    } catch (error) {
                      setError(errorText(error));
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              >
                {["running", "scheduled", "queued"].includes(task.status)
                  ? "Pause and open browser"
                  : "Open browser"}
              </Button>
            </Card>
          ))}
          {detail?.files?.map((file) => (
            <LinkRow
              key={file.id}
              title={file.name}
              detail={`${file.pageCount} pages · PDF`}
              icon={FileText}
              onPress={() => open({ type: "file", file })}
            />
          ))}
          {(
            data?.artifacts.filter((artifact) => artifact.taskId === taskId) ||
            detail?.artifacts ||
            []
          ).map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
          {!!task.evidence.length && (
            <View style={{ gap: 16 }}>
              <Text style={s.heading}>Sources</Text>
              <EvidenceList items={task.evidence} />
            </View>
          )}
        </View>
      )}
    </Sheet>
  );
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function display(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : value === null
        ? "—"
        : JSON.stringify(value, null, 2) || "";
}
export function ArtifactCard({ artifact }: { artifact: AgentArtifact }) {
  const [expanded, setExpanded] = useState(false);
  if (artifact.kind === "finance") return <FinanceArtifact artifact={artifact} />;
  const rows = Object.entries(artifact.data);
  return (
    <Card style={{ gap: 13, backgroundColor: colors.surface }}>
      <View style={s.between}>
        <Text style={s.heading}>{artifact.title}</Text>
        <Chip>{statusLabel(artifact.kind)}</Chip>
      </View>
      <Text selectable style={s.muted}>
        {artifact.summary}
      </Text>
      {(expanded ? rows : rows.slice(0, 4)).map(([key, value]) => (
        <View key={key} style={{ gap: 6 }}>
          <Text style={s.label}>{key.replace(/_/g, " ")}</Text>
          {Array.isArray(value) ? (
            value.slice(0, expanded ? 100 : 5).map((item) => {
              const row = record(item);
              return (
                <View
                  key={`${key}-${display(row?.id ?? item)}`}
                  style={{
                    paddingVertical: 8,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.line,
                  }}
                >
                  <Text selectable style={s.text}>
                    {row
                      ? Object.entries(row)
                          .map(([name, val]) => `${name}: ${display(val)}`)
                          .join(" · ")
                      : display(item)}
                  </Text>
                </View>
              );
            })
          ) : record(value) ? (
            Object.entries(record(value) || {}).map(([name, val]) => (
              <View key={name} style={s.between}>
                <Text style={s.muted}>{name}</Text>
                <Text selectable style={s.text}>
                  {display(val)}
                </Text>
              </View>
            ))
          ) : (
            <Text selectable style={[s.text, { fontSize: typeof value === "number" ? 24 : 14 }]}>
              {display(value)}
            </Text>
          )}
        </View>
      ))}
      <Button small onPress={() => setExpanded(!expanded)}>
        {expanded ? "Show summary" : "Explore full result"}
      </Button>
    </Card>
  );
}
function FinanceArtifact({ artifact }: { artifact: AgentArtifact }) {
  const [details, setDetails] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { mutate } = useAgentWorkspace();
  const [goalTitle, setGoalTitle] = useState("");
  const [goalSaved, setGoalSaved] = useState(false);
  const [goalBusy, setGoalBusy] = useState(false);
  const [goalError, setGoalError] = useState("");
  const saveGoal = async () => {
    setGoalBusy(true);
    setGoalError("");
    try {
      await mutate("/goals", {
        title: goalTitle.trim(),
        category: "Finances",
        description: `Inspired by ${artifact.title}: ${artifact.summary}`,
        milestones: ["Choose a savings target", "Review spending each week"],
      });
      setGoalSaved(true);
    } catch (error) {
      setGoalError(errorText(error));
    } finally {
      setGoalBusy(false);
    }
  };
  const amount = (value: unknown) =>
    Number(value ?? 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const categories = Array.isArray(artifact.data.categories) ? artifact.data.categories : [];
  const transactions = Array.isArray(artifact.data.transactions) ? artifact.data.transactions : [];
  const spending = Number(artifact.data.spending) || 1;
  const period = record(artifact.data.period);
  return (
    <Card
      style={{
        gap: 12,
        padding: 12,
        backgroundColor: colors.surfaceMuted,
        maxWidth: 440,
        width: "100%",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open finance tracker: ${artifact.title}`}
        accessibilityState={{ expanded: details }}
        onPress={() => setDetails(!details)}
      >
        <View
          style={{
            minHeight: 200,
            borderRadius: radius.xxl,
            overflow: "hidden",
            backgroundColor: financeArt.card,
            padding: 20,
          }}
        >
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 142 }}>
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id="finance" x1="0" y1="0" x2="0.5" y2="1">
                  <Stop offset="0" stopColor={financeArt.gradient[0]} />
                  <Stop offset="0.5" stopColor={financeArt.gradient[1]} />
                  <Stop offset="1" stopColor={financeArt.gradient[2]} />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill="url(#finance)" />
            </Svg>
          </View>
          <Text
            style={{
              color: financeArt.intro,
              fontSize: fontSize.caption,
              lineHeight: 19,
              marginBottom: 20,
            }}
          >
            Read from your imported transactions.{"\n"}
            {String(period?.from ?? "")} — {String(period?.to ?? "")}
            {"\n"}
            {transactions.length} transactions, categorized and summarized.
          </Text>
          <View style={[s.row, { gap: 8 }]}>
            {(
              [
                ["Income", "income"],
                ["Spending", "spending"],
                ["Remaining", "saved"],
              ] as const
            ).map(([label, key]) => (
              <View
                key={key}
                style={{
                  flex: 1,
                  padding: 14,
                  borderRadius: radius.lg,
                  backgroundColor: financeArt.panel,
                }}
              >
                <Text style={{ color: financeArt.label, fontSize: fontSize.micro }}>{label}</Text>
                <Text
                  selectable
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.65}
                  style={{
                    fontSize: fontSize.title,
                    fontWeight: "600",
                    color: key === "saved" ? financeArt.positive : colors.onInverse,
                    marginTop: 6,
                  }}
                >
                  {amount(artifact.data[key])}
                </Text>
                <Text style={{ color: financeArt.note, fontSize: fontSize.micro, marginTop: 4 }}>
                  source currency
                </Text>
              </View>
            ))}
          </View>
        </View>
        <View style={[s.row, { gap: 12, paddingHorizontal: 12, paddingVertical: 12 }]}>
          <Text style={{ fontSize: fontSize.display }}>💸</Text>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[s.text, { fontWeight: "600" }]}>Finance tracker</Text>
            <Text style={s.small}>Spending, savings, and a plan for what’s next.</Text>
          </View>
          <ChevronRight size={17} color={colors.muted} />
        </View>
      </Pressable>
      {details && (
        <View style={{ gap: 16, padding: 12 }}>
          <Text style={s.label}>Where your money went</Text>
          {categories.map((category) => {
            const row = record(category);
            if (!row) return null;
            return (
              <View key={String(row.name)} style={{ gap: 8 }}>
                <View style={s.between}>
                  <Text style={s.text}>{String(row.name)}</Text>
                  <Text style={s.text}>{amount(row.amount)}</Text>
                </View>
                <View style={{ height: 6, backgroundColor: colors.line, borderRadius: radius.sm }}>
                  <View
                    style={{
                      width: `${Math.min(100, (Number(row.amount) / spending) * 100)}%`,
                      height: 6,
                      backgroundColor: colors.primary,
                      borderRadius: radius.sm,
                    }}
                  />
                </View>
              </View>
            );
          })}
          <Text style={s.small}>
            Amounts use your source currency. This summary covers the imported dates.
          </Text>
          {goalSaved ? (
            <Text style={s.text}>Your savings goal is saved in Goals.</Text>
          ) : (
            <View style={{ gap: 12 }}>
              <Field
                label="Turn this into a savings goal"
                value={goalTitle}
                onChangeText={setGoalTitle}
                placeholder="What would you like to save for?"
              />
              <ErrorNotice error={goalError} />
              <Button
                small
                busy={goalBusy}
                disabled={!goalTitle.trim()}
                onPress={() => void saveGoal()}
              >
                Create savings goal
              </Button>
            </View>
          )}
          <Button small onPress={() => setExpanded(!expanded)}>
            {expanded ? "Hide transactions" : "View transactions"}
          </Button>
          {expanded &&
            transactions.slice(0, 100).map((transaction) => {
              const row = record(transaction);
              return row ? (
                <View key={String(row.id ?? display(row))} style={s.between}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.text}>{String(row.description)}</Text>
                    <Text style={s.small}>
                      {String(row.date)} · {String(row.category)}
                    </Text>
                  </View>
                  <Text style={s.text}>{amount(row.amount)}</Text>
                </View>
              ) : null;
            })}
          {expanded && transactions.length > 100 && (
            <Text style={s.small}>
              Showing the first 100 transactions. The totals include every row.
            </Text>
          )}
        </View>
      )}
    </Card>
  );
}
export function DelegateSheet({ threadId }: { threadId?: string }) {
  const { workspace, close, open } = useWorkspace();
  const { delegate } = useAgentWorkspace();
  const [kind, setKind] = useState<AgentTask["kind"]>("plan");
  const [prompt, setPrompt] = useState("");
  const [messageId, setMessageId] = useState("");
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const task = await delegate({
        prompt: prompt.trim(),
        kind,
        threadId,
        input: kind === "finance" ? { csv } : kind === "document" ? { messageId } : {},
        priority: "medium",
        blockedBy: [],
        labels: [],
      });
      open({ type: "task", taskId: task.id });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Hand over an outcome"
      subtitle="Hive saves a plan and keeps working on the server."
      onClose={close}
    >
      <View style={{ marginBottom: 20 }}>
        <Segmented<AgentTask["kind"]>
          label="Kind of task"
          value={kind}
          onChange={setKind}
          options={(["plan", "document", "finance", "agent"] as const).map((item) => ({
            id: item,
            label: item === "agent" ? "General task" : statusLabel(item),
          }))}
        />
      </View>
      <Field
        label="What would you like done?"
        value={prompt}
        onChangeText={setPrompt}
        multiline
        placeholder={
          kind === "document"
            ? "Fill the attached form and prepare a reply for my review"
            : kind === "finance"
              ? "Summarize my spending and suggest a savings plan"
              : "Make a practical plan for my week"
        }
      />
      {kind === "document" && (
        <View style={{ gap: 8, marginBottom: 20 }}>
          <Text style={[s.heading, { marginBottom: 4 }]}>Choose the email with the PDF</Text>
          {workspace.mail
            .filter((mail) => mail.attachments.length)
            .map((mail) => (
              <CheckRow
                key={mail.id}
                checked={mail.id === messageId}
                label={`${mail.subject} · ${mail.sender}`}
                onPress={() => setMessageId(mail.id)}
              />
            ))}
          {!workspace.mail.some((mail) => mail.attachments.length) && (
            <Text style={s.muted}>
              Connect mail in Apps and select a message with a PDF attachment.
            </Text>
          )}
        </View>
      )}
      {kind === "finance" && (
        <>
          <Field
            label="Transaction CSV"
            value={csv}
            onChangeText={setCsv}
            multiline
            autoCapitalize="none"
            placeholder={"date,description,amount,category\n2026-09-01,Groceries,54.20,Food"}
          />
          {workspace.mode === "sample" && (
            <Button
              onPress={() =>
                setCsv(
                  "date,description,amount,category\n2026-09-01,Salary,-4200,Income\n2026-09-02,Groceries,84.50,Food\n2026-09-03,Subscription,19.99,Subscriptions\n2026-09-04,Coffee,6.50,Food",
                )
              }
            >
              Try example transactions
            </Button>
          )}
          <Text style={[s.small, { marginVertical: 16 }]}>
            Positive amounts are expenses; negative amounts are income. Imported data only. No bank
            connection is implied.
          </Text>
        </>
      )}
      <ErrorNotice error={error} />
      <Button
        primary
        busy={busy}
        disabled={
          !prompt.trim() ||
          (kind === "document" && !messageId) ||
          (kind === "finance" && !csv.trim())
        }
        onPress={() => void submit()}
      >
        Delegate task
      </Button>
    </Sheet>
  );
}
export function IdeasScreen() {
  const { data, mutate } = useAgentWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refreshIdeas() {
    setBusy(true);
    setError("");
    try {
      await mutate("/ideas/refresh", {});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const ideas = data?.ideas.filter((idea) => idea.status === "new") || [];
  const started = data?.ideas.filter((idea) => idea.status === "accepted") || [];
  return (
    <View style={{ gap: 24 }}>
      <AgentStatus />
      <View style={s.between}>
        <Text style={s.small}>Inspired by your connected apps. Tap one to see why.</Text>
        <Button small icon={RefreshCw} busy={busy} onPress={() => void refreshIdeas()}>
          Find ideas
        </Button>
      </View>
      <ErrorNotice error={error} />
      {ideas.map((idea) => (
        <IdeaCard key={idea.id} idea={idea} />
      ))}
      {!ideas.length && (
        <Empty
          icon={Lightbulb}
          title="Room for a good idea"
          detail="Find ideas from the sources you have granted access to. Each suggestion includes its evidence."
        />
      )}
      {!!started.length && (
        <View style={{ gap: 12 }}>
          <Text style={s.label}>Started</Text>
          {started.map((idea) => (
            <Card key={idea.id} style={{ gap: 10 }}>
              <Text style={s.heading}>{idea.title}</Text>
              <Chip tint={colors.successBg}>Started</Chip>
              {!!idea.taskId && <TaskLink taskId={idea.taskId} />}
            </Card>
          ))}
        </View>
      )}
    </View>
  );
}
function TaskLink({ taskId, onOpen }: { taskId: string; onOpen?: () => void }) {
  const { open } = useWorkspace();
  return (
    <Button
      small
      icon={ArrowRight}
      style={{ alignSelf: "flex-start" }}
      onPress={() => {
        onOpen?.();
        open({ type: "task", taskId });
      }}
    >
      View task
    </Button>
  );
}
function IdeaCard({ idea }: { idea: Idea }) {
  const { mutate } = useAgentWorkspace();
  const { open } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(idea.prompt);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(action: "accept" | "dismiss") {
    setBusy(true);
    setError("");
    try {
      const result = await mutate<Idea>(`/ideas/${idea.id}`, { action, prompt });
      if (result.taskId && action === "accept") open({ type: "task", taskId: result.taskId });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: colors.line }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`View idea: ${idea.title}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={({ hovered }: WebPressState) => ({
          flexDirection: "row",
          gap: 14,
          borderRadius: radius.lg,
          backgroundColor: hovered ? colors.surfaceMuted : "transparent",
        })}
      >
        <Text style={{ fontSize: fontSize.display, width: 34, paddingTop: 3 }}>
          {/document|permission|form/i.test(idea.title)
            ? "📋"
            : /money|spend|saving/i.test(idea.title)
              ? "💸"
              : /goal|plan|training/i.test(idea.title)
                ? "👟"
                : /dinner|table/i.test(idea.title)
                  ? "🍽️"
                  : "💡"}
        </Text>
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={[s.heading, { fontSize: fontSize.heading, lineHeight: 23 }]}>
            {idea.title}
          </Text>
          <Text style={s.muted}>{idea.reason}</Text>
          {!expanded && idea.evidence.length > 0 && (
            <Text style={s.small}>
              {idea.evidence.length} {idea.evidence.length === 1 ? "source" : "sources"}
            </Text>
          )}
        </View>
        <ChevronDown
          size={18}
          color={colors.muted}
          style={{ marginTop: 5, transform: [{ rotate: expanded ? "180deg" : "0deg" }] }}
        />
      </Pressable>
      {expanded && (
        <View style={{ gap: 16, marginTop: 16, paddingLeft: 48 }}>
          <EvidenceList items={idea.evidence} />
          {editing && (
            <Field label="What should Hive do?" value={prompt} onChangeText={setPrompt} multiline />
          )}
          <ErrorNotice error={error} />
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              primary
              busy={busy}
              disabled={!prompt.trim()}
              onPress={() => void act("accept")}
            >
              Start this
            </Button>
            <Button disabled={busy} onPress={() => setEditing(!editing)}>
              {editing ? "Keep edits" : "Edit"}
            </Button>
            <Button disabled={busy} onPress={() => void act("dismiss")}>
              Dismiss
            </Button>
          </View>
        </View>
      )}
    </View>
  );
}
export function GoalsScreen() {
  const { data } = useAgentWorkspace();
  const [adding, setAdding] = useState<string>();
  const [selectedGoal, setSelectedGoal] = useState<string>();
  const [selectedMonitor, setSelectedMonitor] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const goal = data?.goals.find((item) => item.id === selectedGoal);
  const monitor = data?.monitors.find((item) => item.id === selectedMonitor);
  const monitors = data?.monitors || [];
  return (
    <View style={{ gap: 24 }}>
      <AgentStatus />
      <View style={{ gap: 12 }}>
        <View style={[s.between, { marginBottom: 4 }]}>
          <View style={[s.row, { gap: 10 }]}>
            <HaloDot color={colors.success} halo={colors.successBg} />
            <Text style={s.heading}>Tracking</Text>
          </View>
          <Button small icon={Plus} onPress={() => setAdding("Tracking")}>
            Track
          </Button>
        </View>
        {(showAll ? monitors : monitors.slice(0, 3)).map((item) => {
          const failing = !!item.error && item.status === "active";
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`Open tracking: ${item.title}`}
              onPress={() => setSelectedMonitor(item.id)}
              style={({ hovered }: WebPressState) => [
                s.row,
                {
                  gap: 12,
                  paddingVertical: 12,
                  paddingHorizontal: 8,
                  borderRadius: radius.lg,
                  backgroundColor: hovered ? colors.surfaceMuted : "transparent",
                },
              ]}
            >
              <View
                style={[
                  s.iconBox,
                  {
                    backgroundColor: failing
                      ? colors.dangerBg
                      : item.status === "active"
                        ? colors.successBg
                        : colors.surfaceMuted,
                  },
                ]}
              >
                <Globe2 size={19} color={failing ? colors.danger : colors.text} />
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={s.text} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text numberOfLines={1} style={s.muted}>
                  {item.status === "active"
                    ? `Checking every ${every(item.intervalMinutes)}`
                    : statusLabel(item.status)}
                  {item.lastValue ? ` · Last: ${item.lastValue}` : ""}
                </Text>
                {failing && (
                  <Text numberOfLines={1} style={[s.small, { color: colors.danger }]}>
                    Needs attention: {item.error}
                  </Text>
                )}
              </View>
              <ChevronRight size={18} color={colors.muted} />
            </Pressable>
          );
        })}
        {!monitors.length && (
          <Text style={[s.muted, { paddingVertical: 12 }]}>
            Ticket prices, a reservation, a page you’re watching.
          </Text>
        )}
        {monitors.length > 3 && (
          <Button small onPress={() => setShowAll(!showAll)}>
            {showAll ? "Show less" : `Show ${monitors.length - 3} more`}
          </Button>
        )}
      </View>
      <View style={{ height: 1, backgroundColor: colors.line }} />
      <View style={{ gap: 12 }}>
        <View style={[s.between, { marginBottom: 4 }]}>
          <View style={[s.row, { gap: 10 }]}>
            <HaloDot color={colors.primary} halo={colors.primarySoftStrong} />
            <Text style={s.heading}>Goals</Text>
          </View>
          <Button small icon={Plus} onPress={() => setAdding("Goal")}>
            New goal
          </Button>
        </View>
        {data?.goals.map((item) => {
          const total = item.milestones.length;
          const reached = item.milestones.filter((milestone) => milestone.done).length;
          const completed = item.status === "completed";
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`Open goal: ${item.title}`}
              onPress={() => setSelectedGoal(item.id)}
              style={({ hovered }: WebPressState) => [
                s.row,
                {
                  gap: 12,
                  paddingVertical: 12,
                  paddingHorizontal: 8,
                  borderRadius: radius.lg,
                  backgroundColor: hovered ? colors.surfaceMuted : "transparent",
                },
              ]}
            >
              <View
                style={[
                  s.iconBox,
                  { backgroundColor: completed ? colors.successBg : colors.primarySoft },
                ]}
              >
                {completed ? (
                  <CircleCheck size={19} color={colors.successText} />
                ) : (
                  <Target size={19} color={colors.primary} />
                )}
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={s.text} numberOfLines={2}>
                  {item.title}
                </Text>
                {total > 0 ? (
                  <View style={{ gap: 4 }}>
                    <View
                      style={{
                        height: 5,
                        borderRadius: radius.sm,
                        backgroundColor: colors.line,
                        overflow: "hidden",
                      }}
                    >
                      <View
                        style={{
                          height: 5,
                          borderRadius: radius.sm,
                          width: `${Math.round((reached / total) * 100)}%`,
                          backgroundColor: completed ? colors.success : colors.primary,
                        }}
                      />
                    </View>
                    <Text style={s.small}>
                      {reached} of {total} milestones{completed ? " · Completed" : ""}
                    </Text>
                  </View>
                ) : (
                  <Text numberOfLines={2} style={s.muted}>
                    {item.description || statusLabel(item.status)}
                  </Text>
                )}
              </View>
              <ChevronRight size={18} color={colors.muted} />
            </Pressable>
          );
        })}
        {!data?.goals.length && (
          <Text style={[s.muted, { paddingVertical: 12 }]}>
            Big plans start with one small step.
          </Text>
        )}
      </View>
      {adding && (
        <Sheet
          title={adding === "Tracking" ? "Track something" : "Create a goal"}
          onClose={() => setAdding(undefined)}
        >
          {adding === "Tracking" ? (
            <MonitorForm onDone={() => setAdding(undefined)} />
          ) : (
            <GoalForm onDone={() => setAdding(undefined)} />
          )}
        </Sheet>
      )}
      {goal && (
        <Sheet title={goal.title} onClose={() => setSelectedGoal(undefined)}>
          <GoalCard goal={goal} onOpenTask={() => setSelectedGoal(undefined)} />
        </Sheet>
      )}
      {monitor && (
        <Sheet title={monitor.title} onClose={() => setSelectedMonitor(undefined)}>
          <MonitorCard monitor={monitor} onOpenTask={() => setSelectedMonitor(undefined)} />
        </Sheet>
      )}
    </View>
  );
}
function GoalForm({ onDone }: { onDone: () => void }) {
  const { mutate } = useAgentWorkspace();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [milestones, setMilestones] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await mutate("/goals", {
        title: title.trim(),
        description,
        milestones: milestones
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <Field
        label="Your goal"
        value={title}
        onChangeText={setTitle}
        placeholder="Build a three-month emergency fund"
      />
      <Field
        label="What does success look like?"
        value={description}
        onChangeText={setDescription}
        multiline
      />
      <Field
        label="Milestones (one per line)"
        value={milestones}
        onChangeText={setMilestones}
        multiline
      />
      <ErrorNotice error={error} />
      <Button primary disabled={!title.trim()} busy={busy} onPress={() => void save()}>
        Create goal
      </Button>
    </Card>
  );
}
function GoalCard({ goal, onOpenTask }: { goal: Goal; onOpenTask?: () => void }) {
  const { data, mutate, delegate } = useAgentWorkspace();
  const { open } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const done = goal.milestones.filter((item) => item.done).length;
  async function update(body: unknown) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/goals/${goal.id}`, body);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function plan() {
    setBusy(true);
    setError("");
    try {
      const task = await delegate({
        title: `Plan: ${goal.title}`,
        prompt: `Create a practical plan for this goal: ${goal.title}. ${goal.description}`,
        kind: "plan",
        goalId: goal.id,
        input: {},
        priority: "medium",
        blockedBy: [],
        labels: [],
      });
      onOpenTask?.();
      open({ type: "task", taskId: task.id });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={{ gap: 12 }}>
      <View style={s.between}>
        <Text style={[s.heading, { flex: 1 }]}>{goal.title}</Text>
        <Chip tint={goal.status === "completed" ? colors.successBg : colors.primarySoft}>
          {statusLabel(goal.status)}
        </Chip>
      </View>
      <Text style={s.muted}>{goal.description}</Text>
      <Text style={s.small}>
        {done} of {goal.milestones.length} milestones
      </Text>
      {goal.milestones.map((milestone) => (
        <CheckRow
          key={milestone.id}
          checked={milestone.done}
          label={milestone.title}
          onPress={() => {
            if (!busy)
              void update({
                milestones: goal.milestones.map((item) =>
                  item.id === milestone.id ? { ...item, done: !item.done } : item,
                ),
              });
          }}
        />
      ))}
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button
          small
          busy={busy}
          onPress={() => void update({ status: goal.status === "active" ? "paused" : "active" })}
        >
          {goal.status === "active" ? "Pause" : "Resume"}
        </Button>
        {goal.status !== "completed" && (
          <Button small busy={busy} onPress={() => void update({ status: "completed" })}>
            Complete goal
          </Button>
        )}
        <Button small primary busy={busy} onPress={() => void plan()}>
          Plan next steps
        </Button>
      </View>
      {data?.tasks
        .filter((task) => task.goalId === goal.id)
        .map((task) => (
          <TaskCard key={task.id} task={task} compact onOpen={onOpenTask} />
        ))}
    </Card>
  );
}
function MonitorForm({ onDone }: { onDone: () => void }) {
  const { workspace } = useWorkspace();
  const { mutate } = useAgentWorkspace();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [condition, setCondition] = useState<Monitor["condition"]>("change");
  const [value, setValue] = useState("");
  const [interval, setInterval] = useState("15");
  const [sample, setSample] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError("");
    try {
      const minutes = Number(interval);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080)
        throw new Error("Use a check interval from 1 to 10080 minutes.");
      if (!sample && !/^https?:\/\//i.test(url.trim()))
        throw new Error("Enter an http or https address for a public page.");
      await mutate("/monitors", {
        title: title.trim(),
        url: sample ? "sample://availability" : url.trim(),
        condition,
        value,
        intervalMinutes: minutes,
      });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <Field
        label="What are you watching?"
        value={title}
        onChangeText={setTitle}
        placeholder="A table at my favorite restaurant"
      />
      {workspace.mode === "sample" && (
        <CheckRow
          checked={sample}
          label="Try the built-in availability page"
          onPress={() => setSample(!sample)}
        />
      )}
      {!sample && (
        <Field
          label="Public page URL"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          placeholder="https://example.com/product"
        />
      )}
      <Text style={[s.small, { marginBottom: 10 }]}>Notify me when</Text>
      <View style={[s.row, { gap: 7, flexWrap: "wrap", marginBottom: 16 }]}>
        {(["change", "contains", "price_below"] as const).map((item) => (
          <Button small primary={condition === item} key={item} onPress={() => setCondition(item)}>
            {item === "change"
              ? "Page changes"
              : item === "contains"
                ? "Text appears"
                : "Price drops below"}
          </Button>
        ))}
      </View>
      {condition !== "change" && (
        <Field
          label={condition === "contains" ? "Text to look for" : "Target price"}
          value={value}
          onChangeText={setValue}
        />
      )}
      <Field
        label="Check every (minutes)"
        value={interval}
        onChangeText={setInterval}
        keyboardType="number-pad"
      />
      <Text style={[s.small, { marginBottom: 14 }]}>
        {sample
          ? "Changes to this built-in page stay in your workspace."
          : "Hive checks this public page on the server and saves meaningful changes in Notifications."}
      </Text>
      <ErrorNotice error={error} />
      <Button
        primary
        busy={busy}
        disabled={
          !title.trim() || (!sample && !url.trim()) || (condition !== "change" && !value.trim())
        }
        onPress={() => void save()}
      >
        Start tracking
      </Button>
    </Card>
  );
}
function MonitorCard({ monitor, onOpenTask }: { monitor: Monitor; onOpenTask?: () => void }) {
  const { mutate } = useAgentWorkspace();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(action: string) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/monitors/${monitor.id}/control`, { action });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function changeSample() {
    setBusy(true);
    setError("");
    try {
      await mutate("/sample-page", {
        text: `Availability: a table is available. Updated ${new Date().toISOString()}`,
      });
      await mutate(`/monitors/${monitor.id}/control`, { action: "check" });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={{ gap: 12 }}>
      <View style={s.between}>
        <Text style={[s.heading, { flex: 1 }]}>{monitor.title}</Text>
        <Chip tint={colors.primarySoft}>{statusLabel(monitor.status)}</Chip>
      </View>
      <Text selectable style={s.small}>
        {monitor.url.startsWith("sample:") ? "Built-in availability page" : monitor.url}
      </Text>
      <Text style={s.text}>
        {monitor.condition === "change"
          ? "Watch for a page change"
          : monitor.condition === "contains"
            ? `Watch for “${monitor.value}”`
            : `Price below ${monitor.value}`}
      </Text>
      <Text style={s.small}>
        Every {monitor.intervalMinutes} min · {monitor.checks} checks
      </Text>
      <Text style={s.small}>
        Last check: {stamp(monitor.lastCheckedAt)}
        {monitor.status === "active" ? `\nNext check: ${stamp(monitor.nextCheckAt)}` : ""}
      </Text>
      {!!monitor.lastValue && (
        <Text selectable numberOfLines={5} style={s.muted}>
          {monitor.lastValue}
        </Text>
      )}
      <ErrorNotice error={error || monitor.error} />
      {monitor.status !== "stopped" && (
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button
            small
            busy={busy}
            onPress={() => void act(monitor.status === "active" ? "pause" : "resume")}
          >
            {monitor.status === "active" ? "Pause" : "Resume"}
          </Button>
          <Button small busy={busy} onPress={() => void act("check")}>
            Check now
          </Button>
          <Button small danger busy={busy} onPress={() => void act("stop")}>
            Stop tracking
          </Button>
        </View>
      )}
      {monitor.url.startsWith("sample:") && monitor.status !== "stopped" && (
        <Button small busy={busy} onPress={() => void changeSample()}>
          Change availability
        </Button>
      )}
      <TaskLink taskId={monitor.taskId} onOpen={onOpenTask} />
    </Card>
  );
}
export function NotificationsSheet() {
  const { data, mutate } = useAgentWorkspace();
  const { close, open } = useWorkspace();
  const { select } = useMuseThread();
  const canDismiss = useServerFeature("notifications-dismiss");
  const [error, setError] = useState("");
  async function read(id: string, taskId?: string, channelId?: string) {
    try {
      await mutate(`/notifications/${id}/read`, {});
      if (taskId) open({ type: "task", taskId });
      else if (channelId) {
        close();
        select({ id: `channel:${channelId}`, existing: true });
      }
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function dismiss(path: string) {
    try {
      await mutate(path, {});
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <Sheet
      title="Notifications"
      subtitle="Your agents' results, decisions for you, and where you were mentioned."
      onClose={close}
    >
      <View style={{ gap: 16 }}>
        <ErrorNotice error={error} />
        {canDismiss && !!data?.notifications.length && (
          <Button
            small
            style={{ alignSelf: "flex-end" }}
            onPress={() => void dismiss("/notifications/dismiss-all")}
          >
            Clear all
          </Button>
        )}
        {data?.notifications.map((item) => (
          <Card
            key={item.id}
            style={{ gap: 10, backgroundColor: item.read ? colors.surface : colors.primarySoft }}
          >
            <View style={s.between}>
              <Text style={s.heading}>{item.title}</Text>
              {!item.read && <Chip>New</Chip>}
            </View>
            <Text style={s.muted}>{item.body}</Text>
            <Text style={s.small}>{stamp(item.createdAt)}</Text>
            <View style={[s.row, { gap: 8 }]}>
              <Button small onPress={() => void read(item.id, item.taskId, item.channelId)}>
                {item.taskId
                  ? "View task"
                  : item.channelId
                    ? "Open channel"
                    : item.read
                      ? "Read"
                      : "Mark read"}
              </Button>
              {canDismiss && (
                <Button small onPress={() => void dismiss(`/notifications/${item.id}/dismiss`)}>
                  Dismiss
                </Button>
              )}
            </View>
          </Card>
        ))}
        {!data?.notifications.length && (
          <Empty
            icon={Bell}
            title="You're all caught up"
            detail="Results, meaningful changes and requests for your input will appear here."
          />
        )}
      </View>
    </Sheet>
  );
}
export function AppsScreen() {
  const { navigate, open } = useWorkspace();
  const { data, mutate } = useAgentWorkspace();
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(false);
  const [name, setName] = useState(data?.identity.name || "Hive");
  const [tone, setTone] = useState(data?.identity.tone || "warm");
  const [avatar, setAvatar] = useState(data?.identity.avatar || "sky");
  const [showChatUpdates, setShowChatUpdates] = useState(data?.identity.showChatUpdates !== false);
  const [memory, setMemory] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data?.identity) {
      setName(data.identity.name);
      setTone(data.identity.tone);
      setAvatar(data.identity.avatar || "sky");
      setShowChatUpdates(data.identity.showChatUpdates !== false);
    }
  }, [
    data?.identity.name,
    data?.identity.tone,
    data?.identity.avatar,
    data?.identity.showChatUpdates,
  ]);
  async function save(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await mutate(path, body);
      if (path === "/memories") setMemory("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const shortcuts = [
    {
      section: "mail" as const,
      title: "Mail",
      detail: "Read messages and prepare replies",
      icon: Mail,
    },
    {
      section: "calendar" as const,
      title: "Calendar",
      detail: "Events and reviewed invitations",
      icon: CalendarDays,
    },
    {
      section: "browser" as const,
      title: "Agent computer",
      detail: "Persistent browser sessions",
      icon: Globe2,
    },
    {
      section: "files" as const,
      title: "Files",
      detail: "PDFs, forms and filled copies",
      icon: FileText,
    },
  ];
  return (
    <View style={{ gap: 24 }}>
      <AgentStatus />
      <SearchField
        label="Search apps"
        placeholder="Search apps and connectors"
        value={query}
        onChangeText={setQuery}
      />
      <ConnectionsScreen query={query} />
      <View style={{ gap: 10 }}>
        <Text style={[s.label, { marginLeft: 16 }]}>On your computer</Text>
        <Card
          style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            backgroundColor: colors.surfaceMuted,
          }}
        >
          {shortcuts
            .filter((item) =>
              `${item.title} ${item.detail}`.toLowerCase().includes(query.toLowerCase()),
            )
            .map((item) => (
              <LinkRow
                key={item.section}
                icon={item.icon}
                title={item.title}
                detail={item.detail}
                onPress={() =>
                  item.section === "browser" ? open({ type: "computer" }) : navigate(item.section)
                }
              />
            ))}
        </Card>
      </View>
      <Button onPress={() => setSettings(!settings)}>
        {settings ? "Close agent settings" : "Personality & memory"}
      </Button>
      {settings && (
        <>
          <Card style={{ gap: 12 }}>
            <SectionHeading title="Your team's agent" />
            <View style={[s.row, { gap: 16, justifyContent: "center", marginBottom: 12 }]}>
              {(["sky", "sand", "lilac"] as const).map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="radio"
                  accessibilityLabel={`${statusLabel(item)} avatar`}
                  accessibilityState={{ checked: avatar === item }}
                  onPress={() => setAvatar(item)}
                  style={{
                    padding: 10,
                    borderRadius: radius.xl,
                    backgroundColor: avatar === item ? colors.primarySoft : colors.canvas,
                  }}
                >
                  <Mascot size={62} variant={item} />
                </Pressable>
              ))}
            </View>
            <Field label="Name" value={name} onChangeText={setName} />
            <View style={[s.row, { gap: 8 }]}>
              {(["warm", "concise", "thoughtful"] as const).map((item) => (
                <Button key={item} small primary={tone === item} onPress={() => setTone(item)}>
                  {statusLabel(item)}
                </Button>
              ))}
            </View>
            <Text style={s.small}>
              Activity and notifications keep the full record, including requests for approval.
            </Text>
            <Button
              busy={busy}
              disabled={!name.trim()}
              onPress={() =>
                void save("/identity", { name: name.trim(), tone, avatar, showChatUpdates })
              }
            >
              Save preferences
            </Button>
          </Card>
          <Card style={{ gap: 12 }}>
            <SectionHeading title="Memory" />
            <Text style={s.muted}>Context your whole team can inspect, correct or forget.</Text>
            {data?.memories.map((item) => (
              <MemoryRow key={item.id} memory={item} />
            ))}
            <Field
              label="Remember something for the team"
              value={memory}
              onChangeText={setMemory}
              placeholder="We ship on Fridays"
            />
            <Button
              busy={busy}
              disabled={!memory.trim()}
              onPress={() =>
                void save("/memories", { text: memory.trim(), source: "User added in Apps" })
              }
            >
              Remember
            </Button>
          </Card>
          <PermissionsSettings />
        </>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}
function MemoryRow({ memory }: { memory: AgentMemory }) {
  const { mutate } = useAgentWorkspace();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(forget: boolean) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/memories/${memory.id}${forget ? "/forget" : ""}`, forget ? {} : { text });
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View
      style={{ gap: 10, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.line }}
    >
      {editing ? (
        <Field label="Memory" value={text} onChangeText={setText} />
      ) : (
        <Text style={s.text}>{memory.text}</Text>
      )}
      <Text style={s.small}>
        {memory.source} · {stamp(memory.createdAt)}
      </Text>
      <View style={[s.row, { gap: 8 }]}>
        {editing ? (
          <Button small busy={busy} disabled={!text.trim()} onPress={() => void act(false)}>
            Save correction
          </Button>
        ) : (
          <Button small onPress={() => setEditing(true)}>
            Edit
          </Button>
        )}
        <Button small danger busy={busy} onPress={() => void act(true)}>
          Forget
        </Button>
      </View>
      <ErrorNotice error={error} />
    </View>
  );
}
