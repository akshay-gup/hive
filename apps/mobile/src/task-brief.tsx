import * as DocumentPicker from "expo-document-picker";
import FileText from "lucide-react-native/dist/esm/icons/file-text";
import ImageIcon from "lucide-react-native/dist/esm/icons/image";
import Paperclip from "lucide-react-native/dist/esm/icons/paperclip";
import { useState } from "react";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import {
  type AgentTask,
  attachmentTypes,
  type TaskAttachment,
  type TaskNote,
  taskBriefLimits,
} from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import type { MuseApi } from "./api";
import { put } from "./chat-upload";
import { fileSize } from "./file-format";
import { ago } from "./task-board";
import { Button, Chip, colors, ErrorNotice, Field, radius, s } from "./ui";
import { useWorkspace } from "./workspace";

const megabytes = (bytes: number) => bytes / (1024 * 1024);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Web pickers take extensions; native pickers take MIME types. */
const pickerTypes =
  Platform.OS === "web"
    ? Object.keys(attachmentTypes)
    : [...new Set(Object.values(attachmentTypes))].map((type) =>
        type.startsWith("image/") ? "image/*" : type,
      );

/**
 * Choose a file and attach it to the task. Resolves to false when the person backs out; throws a
 * message they can read when the file cannot be attached.
 */
export async function attachFile(api: MuseApi, taskId: string): Promise<boolean> {
  const result = await DocumentPicker.getDocumentAsync({
    type: pickerTypes,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return false;
  const file = result.assets[0];
  if (file.size !== undefined && file.size > taskBriefLimits.attachmentBytes)
    throw new Error(`Files must be ${megabytes(taskBriefLimits.attachmentBytes)} MB or smaller.`);
  const size = file.size ?? file.file?.size ?? 0;
  if (!size) throw new Error("The selected file could not be read. Please choose it again.");
  if (Platform.OS === "web" && !file.file)
    throw new Error("The selected file could not be read. Please choose it again.");
  // The chat service keeps the task's files: ask it for room, send the bytes to where it says, and put the
  // file on the task.
  const mime = file.mimeType ?? file.file?.type ?? "application/octet-stream";
  const begun = await api.request<{ fileId: string; upload: string }>(
    `/chat/v1/tasks/${taskId}/attachments/begin`,
    { name: file.name, bytes: size },
  );
  await put(api, begun.upload, { size, mime, blob: file.file, uri: file.uri }, file.name);
  await api.request(`/chat/v1/tasks/${taskId}/attachments`, { fileId: begun.fileId });
  return true;
}

const noteAbout: Record<TaskNote["kind"], string> = {
  note: "",
  answer: " · answered a question",
  feedback: " · asked for changes",
};

function NoteRow({
  note,
  agentTask,
  onRemove,
}: {
  note: TaskNote;
  agentTask: boolean;
  /** Absent when the person may only look. */
  onRemove?: () => void;
}) {
  return (
    <View
      style={{
        gap: 4,
        paddingLeft: 12,
        borderLeftWidth: 2,
        borderLeftColor:
          note.kind === "feedback"
            ? colors.warning
            : note.kind === "answer"
              ? colors.primary
              : colors.line,
      }}
    >
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>
          {note.mine ? "You" : (note.createdByName ?? "A teammate")}
        </Text>
        <Text style={s.small}>
          {ago(note.createdAt)}
          {noteAbout[note.kind]}
        </Text>
        {agentTask && !note.delivered && (
          <Chip tint={colors.warningBg} color={colors.warningText}>
            Agent hasn't read this yet
          </Chip>
        )}
      </View>
      <Text selectable style={s.text}>
        {note.text}
      </Text>
      {note.mine && !note.delivered && onRemove && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove this note"
          onPress={onRemove}
          style={{ alignSelf: "flex-start", paddingVertical: 4 }}
        >
          <Text style={[s.small, { color: colors.primaryText }]}>Remove</Text>
        </Pressable>
      )}
    </View>
  );
}

function FileRow({ file, onRemove }: { file: TaskAttachment; onRemove?: () => void }) {
  const { api } = useWorkspace();
  const Icon = file.mimeType.startsWith("image/") ? ImageIcon : FileText;
  return (
    <View
      style={[
        s.row,
        {
          gap: 12,
          padding: 12,
          borderWidth: 1,
          borderColor: colors.line,
          borderRadius: radius.lg,
          backgroundColor: colors.surface,
        },
      ]}
    >
      <Icon size={18} color={colors.muted} />
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open ${file.name}`}
        disabled={!file.url}
        onPress={() => file.url && void Linking.openURL(api.chatUrl(file.url))}
        style={{ flex: 1, minWidth: 0 }}
      >
        <Text style={[s.text, { color: colors.primaryText }]} numberOfLines={1}>
          {file.name}
        </Text>
        <Text style={s.small} numberOfLines={1}>
          {fileSize(file.size)} · {file.mine ? "you" : (file.addedByName ?? "a teammate")},{" "}
          {ago(file.addedAt)}
        </Text>
      </Pressable>
      {file.mine && onRemove && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${file.name}`}
          onPress={onRemove}
          style={{ paddingVertical: 6, paddingHorizontal: 4 }}
        >
          <Text style={[s.small, { color: colors.primaryText }]}>Remove</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * What the agent is told besides the task itself: the team's notes, in order, and the files it
 * should read. Every run reads all of it, and a note added while the agent works reaches it then.
 */
export function TaskBrief({ task, readOnly }: { task: AgentTask; readOnly?: boolean }) {
  const { api } = useWorkspace();
  const { refresh, mutate } = useAgentWorkspace();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const notes = task.notes ?? [];
  const files = task.attachments ?? [];
  const agentTask = task.kind !== "manual";

  async function run(work: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await work();
      await refresh().catch(() => {});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const addNote = () =>
    run(async () => {
      await mutate(`/tasks/${task.id}/notes`, { text: text.trim() });
      setText("");
    });
  const removeNote = (note: TaskNote) =>
    run(() => api.request(`/api/agent/tasks/${task.id}/notes/${note.id}`, undefined, "DELETE"));
  const removeFile = (file: TaskAttachment) =>
    run(() =>
      api.request(`/api/agent/tasks/${task.id}/attachments/${file.id}`, undefined, "DELETE"),
    );

  const hint = !agentTask
    ? "Context for whoever picks this up. If you hand it to the agent, it reads all of this."
    : task.status === "running"
      ? "The agent is working now and picks up a new note or file as it goes."
      : "The agent reads all of this each time it runs.";
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 4 }}>
        <Text style={s.heading}>Notes &amp; files</Text>
        <Text style={s.small}>{hint}</Text>
      </View>
      {notes.map((note) => (
        <NoteRow
          key={note.id}
          note={note}
          agentTask={agentTask}
          onRemove={readOnly ? undefined : () => void removeNote(note)}
        />
      ))}
      {files.map((file) => (
        <FileRow
          key={file.id}
          file={file}
          onRemove={readOnly ? undefined : () => void removeFile(file)}
        />
      ))}
      <ErrorNotice error={error} />
      {!readOnly && (
        <>
          <Field
            label="Add a note"
            value={text}
            onChangeText={setText}
            multiline
            maxLength={taskBriefLimits.noteChars}
            placeholder="Anything the agent should know or do differently…"
            style={{ minHeight: 76 }}
          />
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              primary
              small
              busy={busy}
              disabled={!text.trim()}
              onPress={() => void addNote()}
            >
              Add note
            </Button>
            <Button
              small
              icon={Paperclip}
              disabled={busy || files.length >= taskBriefLimits.attachments}
              onPress={() => void run(() => attachFile(api, task.id))}
            >
              Attach a file
            </Button>
          </View>
        </>
      )}
    </View>
  );
}
