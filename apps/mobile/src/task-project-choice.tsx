import Check from "lucide-react-native/dist/esm/icons/check";
import ChevronDown from "lucide-react-native/dist/esm/icons/chevron-down";
import TriangleAlert from "lucide-react-native/dist/esm/icons/triangle-alert";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { SourceTaskAudience, SourceTaskView } from "../../../packages/domain/src/task-source";
import { useChat } from "./chat-context";
import { Button, colors, ErrorNotice, Field, radius, SearchField, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

const enc = encodeURIComponent;

/** Project names and the audience are fetched as the person using the card, never broadcast into chat. */
export function TaskProjectChoice({
  requestId,
  initial,
  editable = false,
  onCreated,
  onCancel,
}: {
  requestId: string;
  initial?: SourceTaskView;
  editable?: boolean;
  onCreated: (id: string) => void;
  onCancel?: () => void;
}) {
  const { api } = useWorkspace();
  const chat = useChat();
  const [request, setRequest] = useState(initial);
  const [projectId, setProjectId] = useState(initial?.suggestedProjectId ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [fullDescription, setFullDescription] = useState(false);
  const [audience, setAudience] = useState<SourceTaskAudience>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!initial);
  const [reviewing, setReviewing] = useState(false);
  const [reviewAttempt, setReviewAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const route = `/chat/v1/task-requests/${enc(requestId)}`;
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const value = await api.request<SourceTaskView>(route);
      setRequest(value);
      setTitle(value.title);
      setPrompt(value.prompt);
      setProjectId(
        (current) =>
          current ||
          value.suggestedProjectId ||
          (value.projects.length === 1 ? value.projects[0].id : ""),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, route]);
  useEffect(() => {
    if (!initial) void load();
  }, [initial, load]);
  useEffect(() => {
    if (!projectId || request?.status !== "pending") {
      setAudience(undefined);
      return;
    }
    let current = true;
    setAudience(undefined);
    setReviewing(true);
    setError("");
    api
      .request<SourceTaskAudience>(`${route}/projects/${enc(projectId)}`)
      .then((value) => {
        if (current) setAudience(value);
      })
      .catch((e) => {
        if (current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (current) setReviewing(false);
      });
    return () => {
      current = false;
    };
  }, [api, projectId, request?.status, reviewAttempt, route]);
  useEffect(
    () =>
      chat.subscribe((frame) => {
        if (
          frame.t === "event" &&
          frame.type === "task-request.changed" &&
          (frame.data as { id?: string }).id === requestId
        )
          void api
            .request<SourceTaskView>(route)
            .then(setRequest)
            .catch(() => {});
      }),
    [api, chat.subscribe, requestId, route],
  );

  const chosen = request?.projects.find((project) => project.id === projectId);
  const warning = !!audience?.outside.length && !audience.confirmed;
  async function create() {
    if (!audience || audience.projectId !== projectId || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.request<SourceTaskView>(`${route}/confirm`, {
        projectId,
        fingerprint: audience.fingerprint,
        share: warning,
        ...(editable ? { title: title.trim(), prompt: prompt.trim() } : {}),
      });
      setRequest(result);
      if (result.status === "created" && result.taskId) onCreated(result.taskId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAudience(undefined);
      try {
        setAudience(await api.request<SourceTaskAudience>(`${route}/projects/${enc(projectId)}`));
      } catch {
        /* the error above is kept */
      }
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    setError("");
    try {
      setRequest(await api.request<SourceTaskView>(`${route}/cancel`, {}));
      onCancel?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Text style={s.muted}>Loading project choices…</Text>;
  if (!request)
    return (
      <View style={{ gap: 8 }}>
        <ErrorNotice error={error} />
        <Button small onPress={() => void load()}>
          Try again
        </Button>
      </View>
    );
  if (request.status !== "pending")
    return (
      <Text style={s.small}>
        {request.status === "created" ? "Task created." : "Task not created."}
      </Text>
    );
  const shown = request.projects.filter((project) =>
    project.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <View style={{ gap: 14 }}>
      {editable ? (
        <>
          <Field
            label="Title"
            value={title}
            maxLength={160}
            onChangeText={setTitle}
            editable={!busy}
          />
          <Field
            label="Description"
            value={prompt}
            maxLength={12000}
            onChangeText={setPrompt}
            editable={!busy}
            multiline
            style={{ minHeight: 90 }}
          />
        </>
      ) : (
        <View style={{ gap: 6 }}>
          <Text selectable style={s.heading}>
            {request.title}
          </Text>
          {!!request.prompt && (
            <Text selectable style={s.muted} numberOfLines={fullDescription ? undefined : 4}>
              {request.prompt}
            </Text>
          )}
          {!!request.prompt && (
            <Button small onPress={() => setFullDescription((value) => !value)}>
              {fullDescription ? "Show less" : "Show full description"}
            </Button>
          )}
        </View>
      )}
      <View style={{ gap: 7 }}>
        <Text style={s.label}>Project</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Project: ${chosen?.name ?? "Choose a project"}`}
          accessibilityState={{ expanded, disabled: busy }}
          disabled={busy}
          onPress={() => setExpanded((value) => !value)}
          style={[
            s.between,
            {
              padding: 12,
              borderWidth: 1,
              borderColor: expanded ? colors.primary : colors.lineStrong,
              backgroundColor: colors.paper,
              borderRadius: radius.md,
              gap: 10,
            },
          ]}
        >
          <Text style={[s.text, { flex: 1 }]}>{chosen?.name ?? "Choose a project"}</Text>
          <ChevronDown size={17} color={colors.muted} />
        </Pressable>
        {expanded && (
          <View style={{ gap: 8 }}>
            {request.projects.length > 8 && (
              <SearchField
                label="Search projects"
                placeholder="Search projects"
                value={query}
                onChangeText={setQuery}
              />
            )}
            <ScrollView
              style={{ maxHeight: 230 }}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
            >
              {!shown.length && (
                <Text style={[s.muted, { paddingVertical: 10 }]}>
                  {request.projects.length
                    ? "No project matches."
                    : "You cannot add tasks to any project yet. Ask a project admin for access."}
                </Text>
              )}
              {shown.map((project) => (
                <Pressable
                  key={project.id}
                  accessibilityRole="button"
                  disabled={busy}
                  accessibilityState={{ selected: project.id === projectId, disabled: busy }}
                  onPress={() => {
                    setProjectId(project.id);
                    setExpanded(false);
                    setQuery("");
                  }}
                  style={[
                    s.between,
                    {
                      gap: 10,
                      padding: 12,
                      minHeight: 44,
                      borderRadius: radius.sm,
                      backgroundColor: project.id === projectId ? colors.primarySoft : colors.paper,
                    },
                  ]}
                >
                  <Text style={[s.text, { flex: 1 }]}>{project.name}</Text>
                  {project.id === projectId ? (
                    <Check size={16} color={colors.primaryText} />
                  ) : (
                    <Text style={s.small}>
                      {project.access[0].toUpperCase() + project.access.slice(1)}
                    </Text>
                  )}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}
        {!request.projects.length && !expanded && (
          <Text style={s.small}>Ask a project admin for access before creating a task.</Text>
        )}
      </View>
      {reviewing && <Text style={s.small}>Checking who can see this task…</Text>}
      {audience && (
        <View accessibilityRole={warning ? "alert" : undefined} style={{ gap: 7 }}>
          {warning ? (
            <>
              <View style={[s.row, { gap: 7, alignItems: "flex-start" }]}>
                <TriangleAlert size={17} color={colors.text} />
                <Text style={[s.text, { flex: 1, fontWeight: "600" }]}>
                  {audience.outside.length === 1
                    ? "One person outside this conversation can see this task."
                    : `${audience.outside.length} people outside this conversation can see this task.`}
                </Text>
              </View>
              <ScrollView style={{ maxHeight: 180 }} nestedScrollEnabled>
                {audience.outside.map((person) => (
                  <Text selectable key={person.id} style={[s.small, { paddingVertical: 3 }]}>
                    {person.name}
                    {person.name !== person.email ? ` (${person.email})` : ""}
                  </Text>
                ))}
              </ScrollView>
              <Text style={s.small}>
                Creating the task shares its title and description with this project. Task access
                follows the project.
              </Text>
            </>
          ) : (
            <Text style={s.small}>
              {audience.confirmed
                ? "Sharing with this project was already confirmed in this thread."
                : "Everyone who can currently see this project can already see this conversation."}{" "}
              Task access follows the project.
            </Text>
          )}
        </View>
      )}
      <ErrorNotice error={error} />
      {!!projectId && !audience && !reviewing && !busy && (
        <Button small onPress={() => setReviewAttempt((value) => value + 1)}>
          Check project access again
        </Button>
      )}
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button
          primary
          small
          busy={busy}
          disabled={busy || !audience || reviewing || (editable && !title.trim())}
          onPress={() => void create()}
        >
          {warning ? "Share and create task" : "Create task"}
        </Button>
        <Button small disabled={busy} onPress={() => void cancel()}>
          Cancel
        </Button>
      </View>
    </View>
  );
}

/** A task made from a private-channel message: the person chooses what to copy and where. */
export function SourceTaskCreate({
  messageId,
  onClose,
  onCreated,
}: {
  messageId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { api } = useWorkspace();
  const [request, setRequest] = useState<SourceTaskView>();
  const [error, setError] = useState("");
  const clientId = useRef(`task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  useEffect(() => {
    let current = true;
    api
      .request<SourceTaskView>("/chat/v1/task-requests", { messageId, clientId: clientId.current })
      .then((value) => {
        if (current) setRequest(value);
      })
      .catch((e) => {
        if (current) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      current = false;
    };
  }, [api, messageId]);
  function close() {
    if (request?.status === "pending")
      void api.request(`/chat/v1/task-requests/${enc(request.id)}/cancel`, {}).catch(() => {});
    onClose();
  }
  return (
    <Sheet title="Create task" subtitle="Copy task details to a project" onClose={close}>
      <View style={{ gap: 14 }}>
        <Text style={s.small}>
          Only the title and description below are copied when this task is created.
        </Text>
        <ErrorNotice error={error} />
        {request ? (
          <TaskProjectChoice
            requestId={request.id}
            initial={request}
            editable
            onCancel={onClose}
            onCreated={(id) => {
              onClose();
              onCreated(id);
            }}
          />
        ) : (
          !error && <Text style={s.muted}>Preparing the task…</Text>
        )}
      </View>
    </Sheet>
  );
}
