import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  type AgentTask,
  GENERAL_PROJECT_ID,
  type Project,
  type TaskPriority,
  type TaskStatus,
  taskPriorities,
} from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import DateOnlyField from "./DateOnlyField";
import { PickMenu } from "./pick-menu";
import { canChangeTask, canWorkIn } from "./project-text";
import { TaskAttention } from "./task-attention";
import { priorityColors } from "./task-board";
import { TaskBrief } from "./task-brief";
import { TaskRunView } from "./task-run";
import { Button, Card, CheckRow, colors, ErrorNotice, Field, Segmented, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

const manualTransitions: TaskStatus[] = ["queued", "running", "succeeded", "failed"];
const workerTransitions: TaskStatus[] = ["queued", "paused", "cancelled"];

function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "queued":
      return "To Do";
    case "running":
      return "In Progress";
    case "succeeded":
      return "Done";
    case "failed":
      return "Failed";
    case "paused":
      return "Paused";
    case "cancelled":
      return "Cancelled";
    case "in_review":
      return "In Review";
    default:
      return status
        .split("_")
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join(" ");
  }
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

/** Full sheet for a task: what it needs from you, its run, quick changes, then editable details. */
export function TaskDetail({
  task,
  tasks,
  projects,
  onClose,
}: {
  task: AgentTask;
  tasks: AgentTask[];
  projects: Project[];
  onClose: () => void;
}) {
  const { api } = useWorkspace();
  const { refresh } = useAgentWorkspace();
  const [title, setTitle] = useState(task.title);
  const [startAt, setStartAt] = useState(task.startAt ?? "");
  const [dueAt, setDueAt] = useState(task.dueAt ?? "");
  const [labels, setLabels] = useState(task.labels.join(", "));
  const [description, setDescription] = useState(task.prompt);
  const [handing, setHanding] = useState(false);
  const [includeDiscussion, setIncludeDiscussion] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [people, setPeople] = useState<{ email: string; name: string; role: string }[]>([]);

  const manual = task.kind === "manual";
  // In a project the person may only look at, the task is shown and not changed.
  const locked = !canChangeTask(task, projects);
  // Issues have a description; agent tasks have the instructions they were given.
  const hasDescription = manual || task.kind === "agent" || task.kind === "plan";
  // Who the task can be given to: those on the team who may work in its project. A guest is not
  // told who is here, so the picker is not shown to them.
  const project = projects.find((p) => p.id === (task.projectId ?? GENERAL_PROJECT_ID));
  useEffect(() => {
    let live = true;
    api
      .request<{ email: string; name: string; role: string }[]>("/api/agent/projects/people")
      .then((found) => live && setPeople(found))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api]);
  const assignable = people.filter((who) => {
    if (who.email === task.assigneeEmail) return true;
    const role = project?.members?.find((m) => m.email === who.email)?.role;
    if (role === "admin" || role === "member") return true;
    return who.role !== "guest" && (project?.access ?? "open") === "open";
  });
  const channelName = task.channelId && task.channelId !== "orchestrator" ? task.channelId : null;
  const transitions = manual ? manualTransitions : workerTransitions;
  const blockers = task.blockedBy
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is AgentTask => !!t);

  /** Save a change to the task. Resolves to whether it was saved; the error is shown above. */
  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setError("");
    setBusy(true);
    try {
      await api.request(`/api/agent/tasks/${task.id}`, body, "PATCH");
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function saveFields() {
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    for (const [label, value] of [
      ["Start", startAt],
      ["Due", dueAt],
    ] as const) {
      if (value.trim() && !datePattern.test(value.trim())) {
        setError(`${label} date must be yyyy-mm-dd.`);
        return;
      }
    }
    if (hasDescription && !manual && !description.trim()) {
      setError("Instructions are required for an agent task.");
      return;
    }
    void patch({
      title: title.trim(),
      ...(hasDescription && description.trim() !== task.prompt.trim()
        ? { prompt: description.trim() }
        : {}),
      startAt: startAt.trim() || null,
      dueAt: dueAt.trim() || null,
      labels: labels
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    });
  }

  async function remove() {
    setError("");
    setBusy(true);
    try {
      await api.request(`/api/agent/tasks/${task.id}`, undefined, "DELETE");
      await refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={task.title}
      subtitle={`${manual ? "Issue" : "Agent task"} · ${statusLabel(task.status)}`}
      onClose={onClose}
    >
      <View style={{ gap: 20 }}>
        <ErrorNotice error={error} />
        {locked && (
          <Text style={s.muted}>
            You can look at this task but not change it: its project is view-only for you.
          </Text>
        )}
        {!manual && !locked && <TaskAttention task={task} onBeforeOpen={onClose} />}
        {hasDescription && !!task.prompt.trim() && (
          <View style={{ gap: 6 }}>
            <Text style={s.label}>{manual ? "Description" : "Instructions"}</Text>
            <Text selectable numberOfLines={8} style={s.text}>
              {task.prompt}
            </Text>
          </View>
        )}
        {(!manual || task.attempts > 0) && <TaskRunView task={task} />}
        <TaskBrief task={task} readOnly={locked} />
        {locked ? (
          <View style={{ gap: 4 }}>
            <Text style={s.small}>
              {[
                task.createdByName ? `Reporter: ${task.createdByName}` : "",
                task.assigneeName
                  ? `Assignee: ${task.assigneeName}`
                  : task.assignee === "agent"
                    ? "Assignee: Agent"
                    : "",
                `Priority: ${task.priority}`,
                task.startAt ? `Start ${task.startAt}` : "",
                task.dueAt ? `Due ${task.dueAt}` : "",
                task.labels.length ? task.labels.join(", ") : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
        ) : (
          <>
            <View style={{ gap: 6 }}>
              <Text style={s.label}>Status</Text>
              <Segmented
                label="Move to"
                value={task.status}
                disabled={busy}
                onChange={(status) => void patch({ status })}
                options={transitions.map((status) => ({ id: status, label: statusLabel(status) }))}
              />
              {!manual && (
                <Text style={s.small}>
                  Worker tasks can only be queued, paused, or cancelled by hand.
                </Text>
              )}
            </View>

            <View style={{ gap: 6 }}>
              <Text style={s.label}>Priority</Text>
              <Segmented<TaskPriority>
                label="Priority"
                value={task.priority}
                disabled={busy}
                onChange={(priority) => void patch({ priority })}
                options={taskPriorities.map((priority) => ({
                  id: priority,
                  label: priority[0].toUpperCase() + priority.slice(1),
                  dot: priorityColors[priority],
                }))}
              />
            </View>

            <View style={{ gap: 6 }}>
              <Text style={s.label}>Reporter</Text>
              <Text style={s.text}>{task.createdByName ?? "Not recorded"}</Text>
              <Text style={[s.label, { marginTop: 8 }]}>Assignee</Text>
              {assignable.length > 0 && task.assignee !== "agent" && !handing && (
                <PickMenu
                  label="Person"
                  value={task.assigneeEmail ?? ""}
                  disabled={busy}
                  onChange={(email) => void patch({ assigneeEmail: email || null })}
                  options={[
                    { id: "", label: "Nobody" },
                    ...assignable.map((who) => ({
                      id: who.email,
                      label: who.name || who.email,
                      detail: who.name ? who.email : undefined,
                    })),
                  ]}
                />
              )}
              <Segmented<"none" | "agent">
                label="Assignee"
                value={handing || task.assignee === "agent" ? "agent" : "none"}
                disabled={busy}
                onChange={(assignee) => {
                  if (assignee === "agent") {
                    // Handing a ticket over is a step of its own: say what the agent needs first.
                    if (task.assignee !== "agent") setHanding(true);
                    return;
                  }
                  setHanding(false);
                  if (task.assignee === "agent") void patch({ assignee: null });
                }}
                options={[
                  { id: "none", label: "Not the agent" },
                  { id: "agent", label: "Agent" },
                ]}
              />
              {manual && !task.assignee && !handing && (
                <Text style={s.small}>
                  Give it to a person, or to the agent to have it run this issue.
                </Text>
              )}
              {task.assignee === "agent" && (
                <Text style={s.small}>
                  The agent runs this ticket and hands it back to you to check. Only you mark it
                  done.
                </Text>
              )}
              {handing && (
                <Card style={{ backgroundColor: colors.primarySoft, gap: 12 }}>
                  <Text style={s.heading}>Hand this to the agent</Text>
                  <Text style={s.muted}>
                    It reads the description, notes and files above, and starts as soon as you
                    confirm. When it finishes it comes back to you to check, and you decide whether
                    it is done.
                  </Text>
                  {channelName && !task.input?.privateConversation && (
                    <CheckRow
                      label={`Include the recent discussion in #${channelName}`}
                      checked={includeDiscussion}
                      onPress={() => setIncludeDiscussion(!includeDiscussion)}
                    />
                  )}
                  <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                    <Button
                      primary
                      busy={busy}
                      onPress={() => {
                        void patch({
                          assignee: "agent",
                          ...(channelName && !task.input?.privateConversation
                            ? { channelContext: includeDiscussion }
                            : {}),
                        }).then((saved) => saved && setHanding(false));
                      }}
                    >
                      Hand to agent
                    </Button>
                    <Button disabled={busy} onPress={() => setHanding(false)}>
                      Cancel
                    </Button>
                  </View>
                </Card>
              )}
            </View>

            <View style={{ gap: 6 }}>
              <Text style={s.label}>Project</Text>
              <PickMenu
                label="Project"
                value={task.projectId ?? GENERAL_PROJECT_ID}
                disabled={busy}
                onChange={(projectId) => void patch({ projectId })}
                options={
                  // Only where the person may put work, and the one the task is in.
                  projects
                    .filter((project) => canWorkIn(project) || project.id === task.projectId)
                    .map((project) => ({ id: project.id, label: project.name }))
                }
              />
            </View>

            <View style={{ height: 1, backgroundColor: colors.line }} />

            <View style={{ gap: 4 }}>
              <Text style={s.label}>Details</Text>
              <Text style={s.small}>Changes here are saved with the button below.</Text>
            </View>
            <View>
              <Field label="Title" value={title} onChangeText={setTitle} />
              {hasDescription && (
                <Field
                  label={manual ? "Description" : "Instructions"}
                  value={description}
                  onChangeText={setDescription}
                  multiline
                  placeholder={
                    manual ? "What is this about, and what does done look like?" : undefined
                  }
                  style={{ minHeight: 96 }}
                />
              )}
              <View style={[s.row, { gap: 10, alignItems: "flex-start" }]}>
                <View style={{ flex: 1 }}>
                  <DateOnlyField label="Start date" value={startAt} onChange={setStartAt} />
                </View>
                <View style={{ flex: 1 }}>
                  <DateOnlyField label="Due date" value={dueAt} onChange={setDueAt} />
                </View>
              </View>
              <Field
                label="Labels (comma-separated)"
                value={labels}
                onChangeText={setLabels}
                placeholder="errands, trip"
              />
              <Button primary disabled={busy} onPress={saveFields}>
                Save details
              </Button>
            </View>
          </>
        )}
        {!!blockers.length && (
          <View style={{ gap: 8 }}>
            <Text style={s.label}>Blocked by</Text>
            {blockers.map((blocker) => (
              <Text key={blocker.id} style={s.muted} numberOfLines={1}>
                · {blocker.title}
              </Text>
            ))}
          </View>
        )}
        {!locked && (
          <Button
            danger
            disabled={busy}
            onPress={() => {
              if (armed) void remove();
              else {
                setArmed(true);
                setTimeout(() => setArmed(false), 4000);
              }
            }}
          >
            {armed ? "Press again to confirm delete" : "Delete"}
          </Button>
        )}
      </View>
    </Sheet>
  );
}
