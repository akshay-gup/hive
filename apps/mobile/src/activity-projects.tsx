import { Eye, ListChecks, Lock, Plus } from "lucide-react-native";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Project } from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { needsYou } from "./board-order";
import { ProjectCreate, ProjectManage, type ProjectSelection } from "./task-project";
import { authorTint } from "./theme";
import { colors, fontSize, radius, s, useDense, type WebPressState } from "./ui";

interface ActivityProjects {
  /** Which work the Activity page shows: all of it (null), one project, or the work with none. */
  selected: ProjectSelection;
  select: (selection: ProjectSelection) => void;
  newProject: () => void;
  manage: (project: Project) => void;
}

const Context = createContext<ActivityProjects | null>(null);

export function useActivityProjects(): ActivityProjects {
  const value = useContext(Context);
  if (!value) throw new Error("Activity projects are unavailable");
  return value;
}

/**
 * Which project the Activity page is on, kept above both the list of projects beside the page and the
 * page itself, so the one picks and the other follows. It also holds the windows for making a
 * project and for changing one.
 */
export function ActivityProjectsProvider({ children }: { children: ReactNode }) {
  const { data } = useAgentWorkspace();
  const [selected, setSelected] = useState<ProjectSelection>(null);
  const [creating, setCreating] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);
  const projects = data?.projects ?? [];
  const managing = managingId ? projects.find((project) => project.id === managingId) : undefined;
  const newProject = useCallback(() => setCreating(true), []);
  const manage = useCallback((project: Project) => setManagingId(project.id), []);
  const value = useMemo(
    () => ({ selected, select: setSelected, newProject, manage }),
    [selected, newProject, manage],
  );
  return (
    <Context.Provider value={value}>
      {children}
      {creating && <ProjectCreate onClose={() => setCreating(false)} />}
      {managing && (
        <ProjectManage
          project={managing}
          taskCount={(data?.tasks ?? []).filter((task) => task.projectId === managing.id).length}
          onClose={() => {
            setManagingId(null);
            // A project that was deleted is no longer one to be on.
            if (selected === managing.id) setSelected(null);
          }}
        />
      )}
    </Context.Provider>
  );
}

/** What the page is called, and what it says under that, for the project it is on. */
export function useActivityTitle(): { title: string; subtitle: string } {
  const { selected } = useActivityProjects();
  const { data } = useAgentWorkspace();
  const tasks = data?.tasks ?? [];
  const mine = tasks.filter((task) =>
    selected === null ? true : selected === "none" ? !task.projectId : task.projectId === selected,
  );
  const waiting = mine.filter((task) => task.kind !== "manual" && needsYou(task.status)).length;
  const project =
    typeof selected === "string" && selected !== "none"
      ? data?.projects.find((item) => item.id === selected)
      : undefined;
  const counts = `${mine.length} ${mine.length === 1 ? "task" : "tasks"}${waiting ? ` · ${waiting} need you` : ""}`;
  return {
    title: project ? project.name : selected === "none" ? "No project" : "All work",
    subtitle: [project?.description, counts].filter(Boolean).join(" · "),
  };
}

/** The list of projects: all the work, each project, the work that has none, and a way to make one. */
export function ProjectsList({ onPick }: { onPick?: () => void }) {
  const { data } = useAgentWorkspace();
  const { selected, select, newProject, manage } = useActivityProjects();
  const dense = useDense();
  const projects = [...(data?.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const tasks = data?.tasks ?? [];
  const waiting = (id: ProjectSelection) =>
    tasks.filter(
      (task) =>
        task.kind !== "manual" &&
        needsYou(task.status) &&
        (id === null ? true : id === "none" ? !task.projectId : task.projectId === id),
    ).length;
  const height = dense ? 32 : 40;
  const tile = dense ? 20 : 24;

  const row = (
    id: ProjectSelection,
    label: string,
    mark: ReactNode,
    extra?: { lock?: boolean; project?: Project },
  ) => {
    const on = selected === id;
    const count = waiting(id);
    return (
      <Pressable
        key={id ?? "all"}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        accessibilityLabel={id === null ? "All work" : `Project: ${label}`}
        onPress={() => {
          select(id);
          onPick?.();
        }}
        onLongPress={extra?.project ? () => manage(extra.project as Project) : undefined}
        delayLongPress={500}
        style={({ pressed, hovered }: WebPressState) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          height,
          paddingHorizontal: 8,
          borderRadius: radius.md,
          backgroundColor: on
            ? colors.primarySoft
            : pressed || hovered
              ? colors.surfaceHover
              : "transparent",
        })}
      >
        {mark}
        <Text style={[s.text, { flex: 1, fontSize: fontSize.ui }]} numberOfLines={1}>
          {label}
        </Text>
        {extra?.lock && <Lock size={13} color={colors.muted} />}
        {extra?.project?.access === "limited" && <Eye size={13} color={colors.muted} />}
        {count > 0 && (
          <View
            accessibilityLabel={`${count} need you`}
            style={{
              minWidth: 20,
              height: 18,
              paddingHorizontal: 6,
              borderRadius: 9,
              backgroundColor: colors.warningBg,
              borderWidth: 1,
              borderColor: colors.warningLine,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              style={{ fontSize: fontSize.caption, fontWeight: "700", color: colors.warningText }}
            >
              {count}
            </Text>
          </View>
        )}
      </Pressable>
    );
  };
  const letter = (name: string) => (
    <View
      style={{
        width: tile,
        height: tile,
        borderRadius: 6,
        backgroundColor: authorTint(name),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: tile * 0.5, fontWeight: "700", color: colors.text }}>
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );

  return (
    <View style={{ gap: 1 }}>
      {row(
        null,
        "All work",
        <View
          style={{
            width: tile,
            height: tile,
            borderRadius: 6,
            backgroundColor: colors.surfaceMuted,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ListChecks size={tile * 0.65} color={colors.text} />
        </View>,
      )}
      <View style={[s.between, { paddingHorizontal: 8, paddingTop: 14, paddingBottom: 4 }]}>
        <Text style={[s.text, { fontSize: fontSize.ui, fontWeight: "500", color: colors.muted }]}>
          Projects
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New project"
          hitSlop={8}
          onPress={newProject}
        >
          <Plus size={16} strokeWidth={1.75} color={colors.muted} />
        </Pressable>
      </View>
      {projects.map((project) =>
        row(project.id, project.name, letter(project.name), {
          lock: !!project.channelId || project.access === "private",
          project,
        }),
      )}
      {row(
        "none",
        "No project",
        <View
          style={{
            width: tile,
            height: tile,
            borderRadius: 6,
            borderWidth: 1.5,
            borderStyle: "dashed",
            borderColor: colors.lineStrong,
          }}
        />,
      )}
      <Pressable
        accessibilityRole="button"
        onPress={newProject}
        style={({ hovered }: WebPressState) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          height,
          marginTop: 6,
          paddingHorizontal: 8,
          borderRadius: radius.md,
          backgroundColor: hovered ? colors.surfaceHover : "transparent",
        })}
      >
        <View style={{ width: tile, alignItems: "center" }}>
          <Plus size={15} color={colors.muted} />
        </View>
        <Text style={[s.text, { fontSize: fontSize.ui, color: colors.muted }]}>New project</Text>
      </Pressable>
    </View>
  );
}
