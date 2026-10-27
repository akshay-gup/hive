import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { AgentTask, RunEvent } from "../../../packages/domain/src/agent";
import { AssistantResponse } from "./assistant-response";
import { ChannelFileCard } from "./file-card";
import { parseSharedFile } from "./tool-results";
import { colors, ErrorNotice, fontSize, IconSlot, monoProps, radius, s } from "./ui";
import { useWorkspace } from "./workspace";

function publicText(text: string) {
  return text.replace(/^TASK_(?:COMPLETE|BLOCKED):\s*/gm, "");
}
function ToolActivity({ event }: { event: RunEvent }) {
  const [expanded, setExpanded] = useState(false);
  const running = ["pending", "running"].includes(event.toolState ?? "");
  // A file the agent shared is shown as it is in a chat, not as the JSON it came back as.
  const sent = event.toolName === "send_file" ? parseSharedFile(event.detail) : null;
  const shared = sent && "channelId" in sent ? <ChannelFileCard sent={sent} /> : null;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.line,
        borderRadius: radius.lg,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Tool activity: ${event.toolName ?? event.title}`}
        onPress={() => setExpanded(!expanded)}
        style={[s.row, { gap: 10, padding: 12 }]}
      >
        <IconSlot>
          {running ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={s.small}>{event.toolState === "error" ? "!" : "✓"}</Text>
          )}
        </IconSlot>
        <Text style={[s.text, { flex: 1, fontSize: fontSize.ui }]}>
          {event.toolName ?? event.title}
        </Text>
        <Text style={s.small}>
          {event.toolState ?? "completed"} · {expanded ? "Hide" : "Details"}
        </Text>
      </Pressable>
      {shared && <View style={{ padding: 12, paddingTop: 0 }}>{shared}</View>}
      {expanded && (
        <View
          style={{
            gap: 8,
            padding: 12,
            borderTopWidth: 1,
            borderTopColor: colors.line,
            backgroundColor: colors.surfaceMuted,
          }}
        >
          {event.toolInput !== undefined && (
            <Text
              selectable
              {...monoProps}
              style={[s.small, { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }]}
            >
              {JSON.stringify(event.toolInput, null, 2)}
            </Text>
          )}
          {!!event.detail && (
            <Text
              selectable
              {...monoProps}
              style={[
                s.text,
                {
                  fontSize: fontSize.small,
                  lineHeight: 19,
                  fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                },
              ]}
            >
              {event.detail}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

/** A durable transcript of the delegated run, independent of the ticket editor. */
export function TaskRunView({ task }: { task: AgentTask }) {
  const { api } = useWorkspace();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [savedTask, setSavedTask] = useState(task);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    let active = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        // The task is the chat service's; the steps of its runs are the machine's, asked for through it.
        const [board, run] = await Promise.all([
          api.request<{ task: AgentTask }>(`/api/agent/tasks/${task.id}`),
          api
            .request<{ events?: RunEvent[] }>(`/chat/v1/tasks/${task.id}/run`)
            .catch((): { events?: RunEvent[] } => ({})),
        ]);
        if (active) {
          // While the machine sleeps its steps are not there; what was shown stays.
          if (run.events) setEvents(run.events);
          setSavedTask(board.task);
          setError("");
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, task.id]);
  const current = savedTask.updatedAt >= task.updatedAt ? savedTask : task;
  const live = ["queued", "running", "scheduled"].includes(current.status);
  const transcript = events.filter((e) => e.kind === "message" || e.kind === "tool");
  const entries = transcript.length
    ? events.filter((e) => !(e.kind === "step" && e.title === "Agent update"))
    : events;
  return (
    <View style={{ gap: 16 }}>
      <View style={[s.row, { gap: 10 }]}>
        <Text style={[s.heading, { flex: 1 }]}>Agent run</Text>
        {live && (
          <>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={s.small}>
              {current.status === "running" ? "Live" : "Waiting to start"}
            </Text>
          </>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={collapsed ? "Expand agent output" : "Collapse agent output"}
          accessibilityState={{ expanded: !collapsed }}
          onPress={() => setCollapsed(!collapsed)}
          style={{ paddingVertical: 8, paddingHorizontal: 6 }}
        >
          <Text style={[s.small, { color: colors.primaryText }]}>
            {collapsed ? "Show output" : "Hide output"}
          </Text>
        </Pressable>
      </View>
      <ErrorNotice error={error} />
      <ScrollView
        accessibilityLabel="Agent run output"
        nestedScrollEnabled
        style={{
          display: collapsed ? "none" : "flex",
          maxHeight: 360,
          flexGrow: 0,
          borderWidth: 1,
          borderColor: colors.line,
          borderRadius: radius.lg,
        }}
        contentContainerStyle={{ gap: 16, padding: 12 }}
      >
        {entries.map((event) =>
          event.kind === "tool" ? (
            <ToolActivity key={event.id} event={event} />
          ) : event.kind === "message" ? (
            <View key={event.id} style={{ gap: 6 }}>
              <Text style={[s.small, { fontWeight: "600" }]}>
                Hive ·{" "}
                {new Date(event.date).toLocaleTimeString(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </Text>
              <AssistantResponse content={publicText(event.detail)} />
            </View>
          ) : (
            <View
              key={event.id}
              style={{ gap: 4, borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: 12 }}
            >
              <Text style={[s.small, { fontWeight: "600" }]}>{event.title}</Text>
              {!!event.detail && (
                <Text selectable style={s.muted}>
                  {event.detail}
                </Text>
              )}
            </View>
          ),
        )}
        {!entries.length && (
          <Text style={s.muted}>
            {live
              ? "Agent messages and tool activity will appear here as the run progresses."
              : "No run messages were recorded for this task."}
          </Text>
        )}
      </ScrollView>
      {!!current.result && (
        <View
          style={{
            gap: 8,
            padding: 16,
            borderRadius: radius.lg,
            backgroundColor: colors.successBg,
          }}
        >
          <Text style={s.heading}>Final response</Text>
          <AssistantResponse content={publicText(current.result)} />
        </View>
      )}
      {!!current.error && <ErrorNotice error={current.error} />}
    </View>
  );
}
