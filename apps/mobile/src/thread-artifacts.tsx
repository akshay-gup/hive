import ChevronRight from "lucide-react-native/dist/esm/icons/chevron-right";
import FileText from "lucide-react-native/dist/esm/icons/file-text";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Artifact, BrowserSession } from "../../../packages/domain/src";
import type { AgentArtifact, AgentTask } from "../../../packages/domain/src/agent";
import { ArtifactCard, TaskLine } from "./agent-ui";
import { BrowserThreadCard } from "./computer";
import { brand, Card, colors, fontSize, radius, s } from "./ui";
import { useWorkspace } from "./workspace";

export function FileThreadCard({ file }: { file: Artifact }) {
  const { open } = useWorkspace();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open PDF: ${file.name}`}
      onPress={() => open({ type: "file", file })}
      style={{ width: "100%", maxWidth: 440 }}
    >
      <Card style={{ padding: 18, backgroundColor: colors.surfaceMuted, gap: 18 }}>
        <View
          style={{ borderRadius: radius.lg, padding: 22, backgroundColor: colors.surface, gap: 14 }}
        >
          <Text style={[s.heading, { fontSize: fontSize.title }]}>
            {file.name.replace(/\.pdf$/i, "")}
          </Text>
          {file.fields?.length ? (
            file.fields.slice(0, 4).map((field) => (
              <View
                key={field.name}
                style={{
                  gap: 5,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.line,
                  paddingBottom: 9,
                }}
              >
                <Text style={s.label}>{field.name.replace(/_/g, " ").toUpperCase()}</Text>
                <Text style={[s.text, { fontSize: fontSize.small }]}>{field.value || "—"}</Text>
              </View>
            ))
          ) : (
            <Text style={s.muted}>
              {file.pageCount} {file.pageCount === 1 ? "page" : "pages"} · Tap to read the document
            </Text>
          )}
        </View>
        <View style={[s.row, { gap: 13 }]}>
          <View style={{ backgroundColor: brand.pdf, padding: 9, borderRadius: radius.md }}>
            <FileText size={23} color={colors.onPrimary} />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text numberOfLines={2} style={s.heading}>
              {file.name}
            </Text>
            <Text style={s.muted}>PDF</Text>
          </View>
          <ChevronRight size={18} color={colors.muted} />
        </View>
      </Card>
    </Pressable>
  );
}
/** Hydrates task-linked artifacts by ID on replay; signed URLs are never stored in messages. */
export function TaskThreadCard({ task }: { task: AgentTask }) {
  const { api } = useWorkspace();
  const [detail, setDetail] = useState<{
    artifacts: AgentArtifact[];
    files: Artifact[];
    browsers: BrowserSession[];
  }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    // What the task made is the machine's, asked for through the chat service while the machine is awake.
    void api
      .request<{
        artifacts?: AgentArtifact[];
        files?: Artifact[];
        browsers?: BrowserSession[];
      }>(`/chat/v1/tasks/${task.id}/run`)
      .then((result) => {
        if (active) {
          setDetail({
            artifacts: result.artifacts ?? [],
            files: result.files ?? [],
            browsers: result.browsers ?? [],
          });
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, task.id, task.updatedAt, attempt]);
  return (
    <View style={{ gap: 12 }}>
      <TaskLine task={task} />
      {detail?.browsers.map((browser) => (
        <BrowserThreadCard key={browser.id} browser={browser} />
      ))}
      {[...(detail?.files || [])]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 1)
        .map((file) => (
          <FileThreadCard key={file.id} file={file} />
        ))}
      {detail?.artifacts.map((artifact) => (
        <ArtifactCard key={artifact.id} artifact={artifact} />
      ))}
      {!!error && (
        <View style={[s.row, { gap: 10, paddingHorizontal: 4 }]}>
          <Text style={[s.small, { color: colors.danger, flexShrink: 1 }]}>{error}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reload task results"
            onPress={() => setAttempt((value) => value + 1)}
          >
            <Text style={[s.small, { fontWeight: "700", color: colors.primaryText }]}>
              Try again
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
