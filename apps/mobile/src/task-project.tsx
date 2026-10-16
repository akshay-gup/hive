import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Project } from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
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

/** null = All projects, "none" = No project, otherwise a project id. */
export type ProjectSelection = string | null | "none";

/** Horizontal pill switcher for filtering the board by project. */
export function ProjectSwitcher({
  projects,
  selected,
  onSelect,
  onNew,
  onManage,
}: {
  projects: Project[];
  selected: ProjectSelection;
  onSelect: (selection: ProjectSelection) => void;
  onNew: () => void;
  onManage: (project: Project) => void;
}) {
  const dense = useDense();
  // The tabs are keyed by project id; "all" stands for no filter and "none" for no project.
  const options: SegmentedOption<string>[] = [
    { id: "all", label: "All" },
    ...projects.map((project) => ({
      id: project.id,
      label: project.name,
      accessibilityLabel: `Project: ${project.name}`,
      onLongPress: () => onManage(project),
    })),
    { id: "none", label: "No project" },
  ];
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
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
    </ScrollView>
  );
}

/** Create a project. */
export function ProjectCreate({ onClose }: { onClose: () => void }) {
  const { mutate } = useAgentWorkspace();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
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
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Sheet title="New project" subtitle="Group tasks on the board" onClose={onClose}>
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
        <Button primary busy={busy} onPress={() => void create()}>
          Create project
        </Button>
      </View>
    </Sheet>
  );
}

/** Rename or delete a project. Deleting keeps its tasks in "No project". */
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
  const { refresh } = useAgentWorkspace();
  const [name, setName] = useState(project.name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api.request(`/api/agent/projects/${project.id}`, { name: trimmed }, "PATCH");
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
      await api.request(`/api/agent/projects/${project.id}`, undefined, "DELETE");
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
    >
      <View style={{ gap: 16 }}>
        <ErrorNotice error={error} />
        <Field label="Name" value={name} onChangeText={setName} />
        <Button primary busy={busy} onPress={() => void save()}>
          Save changes
        </Button>
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
          {armed ? "Tap again to confirm delete" : "Delete project"}
        </Button>
        <Text style={s.small}>Deleting keeps its tasks — they move to No project.</Text>
      </View>
    </Sheet>
  );
}
