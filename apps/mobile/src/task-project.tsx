import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  GENERAL_PROJECT_ID,
  type Project,
  type ProjectAccess,
} from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { AccessChoice, ProjectPeople, RadioRows } from "./project-access";
import { accessLine, canWorkIn } from "./project-text";
import {
  Button,
  colors,
  ErrorNotice,
  Field,
  radius,
  type SegmentedOption,
  SegmentedRow,
  Sheet,
  s,
  useDense,
  type WebPressState,
} from "./ui";
import { useWorkspace } from "./workspace";

/** null = All projects, otherwise a project id. */
export type ProjectSelection = string | null;

/** Horizontal pill switcher for filtering the board by project. */
export function ProjectSwitcher({
  projects,
  selected,
  onSelect,
  onNew,
  onManage,
  inline,
}: {
  projects: Project[];
  selected: ProjectSelection;
  onSelect: (selection: ProjectSelection) => void;
  onNew: () => void;
  onManage: (project: Project) => void;
  /** Without a scroller of its own, to sit in a row that scrolls. */
  inline?: boolean;
}) {
  const dense = useDense();
  // The tabs are keyed by project id; "all" stands for no filter.
  const options: SegmentedOption<string>[] = [
    { id: "all", label: "All projects" },
    ...projects.map((project) => ({
      id: project.id,
      label: project.name,
      accessibilityLabel: `Project: ${project.name}`,
      onLongPress: () => onManage(project),
    })),
  ];
  const row = (
    <View style={[s.row, { gap: 8 }]}>
      <SegmentedRow
        label="Project"
        options={options}
        value={selected === null ? "all" : selected}
        onChange={(id) => onSelect(id === "all" ? null : id)}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="+ New"
        onPress={onNew}
        style={({ hovered }: WebPressState) => ({
          borderRadius: radius.pill,
          paddingHorizontal: 16,
          height: dense ? 32 : 38,
          justifyContent: "center",
          borderWidth: 1.5,
          borderStyle: "dashed",
          borderColor: colors.accent,
          backgroundColor: hovered ? colors.accentSoft : colors.surface,
        })}
      >
        <Text style={[s.small, { fontWeight: "600", color: colors.accentText }]}>+ New</Text>
      </Pressable>
    </View>
  );
  if (inline) return row;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      {row}
    </ScrollView>
  );
}

/** Create a project. */
export function ProjectCreate({ onClose }: { onClose: () => void }) {
  const { mutate } = useAgentWorkspace();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<ProjectAccess>("open");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await mutate("/projects", {
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        access,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Sheet title="New project" subtitle="Group tasks on the board" onClose={onClose} tall>
      <View style={{ gap: 16 }}>
        <ErrorNotice error={error} />
        <Field
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="e.g. Website relaunch"
        />
        <Field
          label="Description (optional)"
          value={description}
          onChangeText={setDescription}
          placeholder="—"
        />
        <View style={{ gap: 8 }}>
          <Text style={s.label}>Who can see it</Text>
          <AccessChoice value={access} onChange={setAccess} />
          <Text style={s.small}>
            You run it, and can change this and who is in it later. Owners and admins of the
            workspace always see every project.
          </Text>
        </View>
        <Button primary busy={busy} onPress={() => void create()}>
          Create project
        </Button>
      </View>
    </Sheet>
  );
}

const DELETE_TASKS = "__delete-tasks";

/**
 * A project's settings: its name, how open it is and who is in it, for those who run it; to everyone
 * else, who can see and work on it. Deleting keeps its tasks in General.
 */
export function ProjectManage({
  project,
  taskCount,
  onClose,
}: {
  project: Project;
  taskCount: number;
  onClose: () => void;
}) {
  const { api } = useWorkspace();
  const { data, refresh } = useAgentWorkspace();
  const [name, setName] = useState(project.name);
  const [deleting, setDeleting] = useState(false);
  // What becomes of its tasks: another project, or gone with it.
  const [fate, setFate] = useState<string>(GENERAL_PROJECT_ID);
  const [access, setAccess] = useState<ProjectAccess>(project.access ?? "open");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const canManage = !!project.you?.canManage;

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api.request(`/api/agent/projects/${project.id}`, { name: trimmed, access }, "PATCH");
      await refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function remove() {
    setError("");
    setBusy(true);
    try {
      await api.request(
        `/api/agent/projects/${project.id}`,
        taskCount === 0
          ? undefined
          : fate === DELETE_TASKS
            ? { deleteTasks: true }
            : { moveTo: fate },
        "DELETE",
      );
      await refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={project.name}
      subtitle={`${taskCount} task${taskCount === 1 ? "" : "s"}`}
      onClose={onClose}
      tall
    >
      <View style={{ gap: 20 }}>
        <ErrorNotice error={error} />
        {canManage ? (
          <>
            <Field label="Name" value={name} onChangeText={setName} />
            <View style={{ gap: 8 }}>
              <Text style={s.label}>Who can see it</Text>
              <AccessChoice value={access} onChange={setAccess} disabled={busy} />
            </View>
            <Button
              primary
              busy={busy}
              disabled={name.trim() === project.name && access === (project.access ?? "open")}
              onPress={() => void save()}
            >
              Save changes
            </Button>
          </>
        ) : (
          <View style={{ gap: 4 }}>
            <Text style={s.text}>{accessLine(project.access)}</Text>
            <Text style={s.small}>
              {project.you?.canWork
                ? "You can work on its tasks. A project admin changes who is in it."
                : "You can look at it. A project admin changes who is in it."}
            </Text>
          </View>
        )}
        <ProjectPeople project={project} />
        {canManage && project.id !== GENERAL_PROJECT_ID && (
          <View style={{ gap: 12 }}>
            {deleting && taskCount > 0 && (
              <View style={{ gap: 8 }}>
                <Text style={s.label}>
                  What should happen to its {taskCount} task{taskCount === 1 ? "" : "s"}?
                </Text>
                <RadioRows
                  label="What happens to its tasks"
                  value={fate}
                  onChange={(next) => {
                    setFate(next);
                    setArmed(false);
                  }}
                  disabled={busy}
                  options={[
                    ...(data?.projects ?? [])
                      .filter((other) => other.id !== project.id && canWorkIn(other))
                      .sort(
                        (a, b) =>
                          Number(b.id === GENERAL_PROJECT_ID) - Number(a.id === GENERAL_PROJECT_ID),
                      )
                      .map((other) => ({ id: other.id, title: `Move them to ${other.name}` })),
                    {
                      id: DELETE_TASKS,
                      title: "Delete them with the project",
                      detail: "They are removed for good, with their notes and files.",
                    },
                  ]}
                />
              </View>
            )}
            <Button
              danger
              disabled={busy}
              onPress={() => {
                // A project with nothing in it, and one whose tasks are to move, ask once; deleting tasks asks twice.
                if (!deleting && taskCount > 0) {
                  setDeleting(true);
                  return;
                }
                if (armed) void remove();
                else {
                  setArmed(true);
                  setTimeout(() => setArmed(false), 4000);
                }
              }}
            >
              {armed
                ? fate === DELETE_TASKS && taskCount > 0
                  ? `Tap again to delete the project and ${taskCount} task${taskCount === 1 ? "" : "s"}`
                  : "Tap again to confirm delete"
                : "Delete project"}
            </Button>
            {deleting && (
              <Button
                small
                disabled={busy}
                onPress={() => {
                  setDeleting(false);
                  setArmed(false);
                }}
              >
                Cancel
              </Button>
            )}
          </View>
        )}
      </View>
    </Sheet>
  );
}
