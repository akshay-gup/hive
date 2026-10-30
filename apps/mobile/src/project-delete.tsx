import { useState } from "react";
import { Text, View } from "react-native";
import { GENERAL_PROJECT_ID, type Project } from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { PickMenu } from "./pick-menu";
import { accessWord, destinations, nameMatches } from "./project-text";
import { Button, colors, ErrorNotice, Field, Segmented, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

/** Past this many projects, the list can be searched. */
const _SEARCHABLE = 6;

/** One project out of however many there are: a field that opens a short list, which scrolls and, when long, searches. */
function ProjectPicker({
  projects,
  value,
  onChange,
  disabled,
}: {
  projects: Project[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const shown = destinations(projects, "");
  return (
    <PickMenu
      label="Move them to"
      caption="Move them to"
      placeholder="Choose a project"
      value={value}
      disabled={disabled}
      onChange={onChange}
      options={shown.map((project) => ({
        id: project.id,
        label: project.name,
        detail: accessWord(project.access),
      }))}
    />
  );
}

/**
 * Deleting a project, on a page of its own: what becomes of its tasks (to another project, picked from
 * a list that copes with many, or deleted with it), the goals and routines that go with it, and then the
 * deleting, which is done by typing the project's name.
 */
export function DeleteProject({
  project,
  taskCount,
  onBack,
  onDone,
}: {
  project: Project;
  taskCount: number;
  onBack: () => void;
  onDone: () => void;
}) {
  const { api } = useWorkspace();
  const { data, refresh } = useAgentWorkspace();
  const places = destinations(data?.projects ?? [], project.id);
  const goalCount =
    data?.goals.filter((goal) => goal.scope?.type === "project" && goal.scope.id === project.id)
      .length ?? 0;
  const routineCount =
    data?.routines.filter(
      (routine) => routine.scope.type === "project" && routine.scope.id === project.id,
    ).length ?? 0;
  const [fate, setFate] = useState<"move" | "delete">("move");
  const ideaCount =
    data?.ideas?.filter((idea) => idea.scope?.type === "project" && idea.scope.id === project.id)
      .length ?? 0;
  const [target, setTarget] = useState(GENERAL_PROJECT_ID);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const losing = fate === "delete" && taskCount > 0;

  async function remove() {
    setError("");
    setBusy(true);
    try {
      await api.request(
        `/api/agent/projects/${project.id}`,
        taskCount === 0 ? undefined : losing ? { deleteTasks: true } : { moveTo: target },
        "DELETE",
      );
      await refresh();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={`Delete ${project.name}?`}
      subtitle={
        taskCount === 0
          ? "It has no tasks."
          : `It has ${taskCount} task${taskCount === 1 ? "" : "s"}.`
      }
      onClose={onBack}
      narrow
    >
      <View style={{ gap: 16 }}>
        <ErrorNotice error={error} />
        {taskCount > 0 && (
          <View style={{ gap: 12 }}>
            <Text style={s.label}>What should happen to its tasks?</Text>
            <Segmented<"move" | "delete">
              label="What happens to its tasks"
              value={fate}
              disabled={busy}
              onChange={setFate}
              options={[
                { id: "move", label: "Move them" },
                { id: "delete", label: "Delete them" },
              ]}
            />
            {fate === "move" ? (
              <ProjectPicker
                projects={places}
                value={target}
                onChange={setTarget}
                disabled={busy}
              />
            ) : (
              <Text style={s.small}>
                They are removed for good, with their notes and files. The project goes too.
              </Text>
            )}
          </View>
        )}
        <View
          style={{
            gap: 8,
            padding: 14,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.dangerLine,
            backgroundColor: colors.dangerBg,
          }}
        >
          <Text style={[s.label, { color: colors.danger }]}>Deleted with this project</Text>
          <Text style={s.text}>
            {goalCount} goal{goalCount === 1 ? "" : "s"}, {routineCount} routine
            {routineCount === 1 ? "" : "s"} and {ideaCount} idea{ideaCount === 1 ? "" : "s"}
          </Text>
          <Text style={s.small}>
            {taskCount > 0
              ? "These are deleted even if you move the tasks to another project. This cannot be undone."
              : "Deleting this project and its contents cannot be undone."}
          </Text>
        </View>
        <Field
          label={`Type ${project.name} to confirm`}
          value={typed}
          onChangeText={setTyped}
          placeholder={project.name}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button
          danger
          busy={busy}
          disabled={
            busy ||
            !nameMatches(typed, project.name) ||
            (fate === "move" && taskCount > 0 && !places.some((p) => p.id === target))
          }
          onPress={() => void remove()}
        >
          {losing
            ? `Delete the project and ${taskCount} task${taskCount === 1 ? "" : "s"}`
            : "Delete project"}
        </Button>
        <Button disabled={busy} onPress={onBack}>
          Cancel
        </Button>
      </View>
    </Sheet>
  );
}
