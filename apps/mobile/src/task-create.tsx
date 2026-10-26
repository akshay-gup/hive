import { useState } from "react";
import { Text, View } from "react-native";
import {
  GENERAL_PROJECT_ID,
  type TaskPriority,
  taskPriorities,
} from "../../../packages/domain/src/agent";
import { useActivityProjects } from "./activity-projects";
import { useAgentWorkspace } from "./agent-workspace";
import { canWorkIn } from "./project-text";
import { priorityColors } from "./task-board";
import { Button, ErrorNotice, Field, fontSize, Segmented, Sheet, s } from "./ui";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

/** Create a manual issue (human task). New issues go in the project the page is on, or General. */
export function TaskCreate({ onClose }: { onClose: () => void }) {
  const { data, refresh, mutate } = useAgentWorkspace();
  const { selected } = useActivityProjects();
  // Where it goes: the project the page is on, if work may be put there, otherwise General.
  const places = (data?.projects ?? []).filter(canWorkIn);
  const [projectId, setProjectId] = useState(
    places.some((project) => project.id === selected) && selected ? selected : GENERAL_PROJECT_ID,
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [startAt, setStartAt] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [labels, setLabels] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    const trimmed = title.trim();
    if (!trimmed) {
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
    setError("");
    setBusy(true);
    try {
      await mutate("/tasks", {
        title: trimmed,
        ...(description.trim() ? { prompt: description.trim() } : {}),
        kind: "manual",
        projectId,
        priority,
        startAt: startAt.trim() || null,
        dueAt: dueAt.trim() || null,
        labels: labels
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      });
      await refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Sheet title="New issue" subtitle="A human task on the board" onClose={onClose}>
      <View style={{ gap: 16 }}>
        <ErrorNotice error={error} />
        <Field
          label="Title"
          value={title}
          onChangeText={setTitle}
          placeholder="What needs doing?"
        />
        <Field
          label="Description"
          value={description}
          onChangeText={setDescription}
          multiline
          placeholder="Details, links, what done looks like. Optional."
          style={{ minHeight: 96 }}
        />
        <View style={{ gap: 6 }}>
          <Text style={s.label}>Project</Text>
          <Segmented<string>
            label="Project"
            value={projectId}
            disabled={busy}
            onChange={setProjectId}
            options={places.map((project) => ({ id: project.id, label: project.name }))}
          />
        </View>
        <View style={{ gap: 6 }}>
          <Text style={s.label}>Priority</Text>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {taskPriorities.map((item: TaskPriority) => (
              <Button
                key={item}
                small
                primary={priority === item}
                disabled={busy}
                onPress={() => setPriority(item)}
              >
                <View style={[s.row, { gap: 6 }]}>
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: priorityColors[item],
                    }}
                  />
                  <Text style={[s.text, { fontSize: fontSize.ui }]}>
                    {item[0].toUpperCase() + item.slice(1)}
                  </Text>
                </View>
              </Button>
            ))}
          </View>
        </View>
        <View style={[s.row, { gap: 10 }]}>
          <View style={{ flex: 1 }}>
            <Field
              label="Start (yyyy-mm-dd)"
              value={startAt}
              onChangeText={setStartAt}
              placeholder="—"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Due (yyyy-mm-dd)" value={dueAt} onChangeText={setDueAt} placeholder="—" />
          </View>
        </View>
        <Field
          label="Labels (comma-separated)"
          value={labels}
          onChangeText={setLabels}
          placeholder="—"
        />
        <Button primary busy={busy} onPress={() => void create()}>
          Create issue
        </Button>
      </View>
    </Sheet>
  );
}
