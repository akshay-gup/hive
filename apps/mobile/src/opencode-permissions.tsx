import Hash from "lucide-react-native/dist/esm/icons/hash";
import ShieldCheck from "lucide-react-native/dist/esm/icons/shield-check";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { Channel } from "../../../packages/domain/src/agent";
import { useGuest } from "./access";
import {
  Button,
  Card,
  colors,
  Empty,
  ErrorNotice,
  fontSize,
  IconSlot,
  Pending,
  radius,
  SectionHeading,
  s,
  selectedCard,
} from "./ui";
import { useWorkspace } from "./workspace";

interface PendingRequest {
  requestId: string;
  permission: string;
  patterns: string[];
  tool?: { messageID: string; callID: string };
  askedAt: number;
  channelId: string;
}

function waited(askedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - askedAt) / 1000));
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

function requestSummary(request: PendingRequest): string {
  const patterns = request.patterns.filter(Boolean).join(", ");
  return patterns ? `${request.permission} · ${patterns}` : request.permission;
}

/**
 * Pending permission approvals for a thread. Polls the opencode permission
 * API (a 404 hides the component entirely). Rendered under the channel thread
 * banner in chat.
 */
export function PendingApprovals({ threadId }: { threadId: string }) {
  const { api } = useWorkspace();
  // A guest sees what the agent is waiting for, and a teammate decides.
  const guest = useGuest();
  const [pending, setPending] = useState<PendingRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const list = await api.request<PendingRequest[]>(
        `/api/agent/opencode/threads/${threadId}/permissions/pending`,
      );
      setPending(list);
      setError("");
    } catch (e) {
      // A 404 means there is nothing to ask about here — hide, don't error.
      setPending(null);
      if (e instanceof Error && !/404/.test(e.message)) setError(e.message);
    }
  }, [api, threadId]);

  useEffect(() => {
    setPending(null);
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  async function reply(requestId: string, reply: "once" | "always" | "reject") {
    setBusy(requestId);
    setError("");
    try {
      await api.request(`/api/agent/opencode/permissions/${requestId}/reply`, { reply });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!pending?.length) return null;
  return (
    <View style={{ gap: 8, marginBottom: 10 }}>
      <ErrorNotice error={error} />
      {pending.map((request) => (
        <View
          key={request.requestId}
          accessibilityRole="alert"
          style={{
            gap: 10,
            paddingHorizontal: 14,
            paddingVertical: 14,
            backgroundColor: colors.warningBg,
            borderRadius: radius.xl,
            borderWidth: 1,
            borderColor: colors.warningLine,
          }}
        >
          <View style={[s.row, { gap: 8, alignItems: "center" }]}>
            <ShieldCheck size={16} color={colors.text} />
            <Text
              selectable
              style={[s.text, { flex: 1, fontSize: fontSize.ui, fontWeight: "600" }]}
            >
              {requestSummary(request)}
            </Text>
          </View>
          <Text style={s.small}>
            The agent is paused until {guest ? "a teammate decides" : "you decide"} · waiting{" "}
            {waited(request.askedAt)}
          </Text>
          {!guest && (
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              <Button
                small
                primary
                busy={busy === request.requestId}
                disabled={busy === request.requestId}
                onPress={() => void reply(request.requestId, "once")}
              >
                Approve once
              </Button>
              <Button
                small
                busy={busy === request.requestId}
                disabled={busy === request.requestId}
                onPress={() => void reply(request.requestId, "always")}
              >
                Always allow
              </Button>
              <Button
                small
                danger
                busy={busy === request.requestId}
                disabled={busy === request.requestId}
                onPress={() => void reply(request.requestId, "reject")}
              >
                Deny
              </Button>
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

/** Permission mode, mirroring the OpenCode TUI's auto-approve toggle. */
type PermissionMode = "ask" | "auto";
type ThreadMode = PermissionMode | null;

const MODES: { id: PermissionMode; label: string; detail: string }[] = [
  { id: "ask", label: "Ask", detail: "Approve each action" },
  { id: "auto", label: "Auto-approve", detail: "Run without asking" },
];

/**
 * TUI-style permission mode selector (the TUI's auto-approve toggle).
 * `loadUrl` returns `{ mode }` (threads: `{ mode, channelMode }`);
 * `saveUrl` accepts `{ mode }`. Threads may inherit the channel mode.
 */
export function PermissionModeSelector({
  loadUrl,
  saveUrl,
  title,
  allowInherit = false,
}: {
  loadUrl: string;
  saveUrl: string;
  title: string;
  allowInherit?: boolean;
}) {
  const { api } = useWorkspace();
  const [mode, setMode] = useState<ThreadMode | undefined>(undefined);
  const [channelMode, setChannelMode] = useState<PermissionMode | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await api.request<{ mode: ThreadMode; channelMode?: PermissionMode }>(loadUrl);
      setMode(data.mode ?? null);
      setChannelMode(data.channelMode ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, loadUrl]);

  useEffect(() => {
    setMode(undefined);
    void load();
  }, [load]);

  async function save(next: ThreadMode) {
    setSaving(true);
    setError("");
    try {
      const data = await api.request<{ mode: ThreadMode }>(saveUrl, { mode: next }, "PUT");
      setMode(data.mode ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (mode === undefined) return error ? <ErrorNotice error={error} /> : <Pending height={96} />;
  const inheritDetail = channelMode
    ? `Channel: ${channelMode === "auto" ? "Auto-approve" : "Ask"}`
    : "Channel default";
  const options: { id: ThreadMode; label: string; detail: string }[] = allowInherit
    ? [{ id: null, label: "Inherit", detail: inheritDetail }, ...MODES]
    : MODES;
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.small}>{title}</Text>
      {options.map((option) => {
        const active = mode === option.id;
        return (
          <Pressable
            key={option.label}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            onPress={() => void save(option.id as ThreadMode)}
            style={[
              s.row,
              {
                gap: 10,
                alignItems: "center",
                paddingVertical: 11,
                paddingHorizontal: 13,
                borderRadius: radius.lg,
              },
              selectedCard(active, "transparent", colors.line),
            ]}
          >
            <Text
              style={[
                s.text,
                { flex: 1, fontSize: fontSize.ui, fontWeight: active ? "600" : "400" },
              ]}
            >
              {option.label}
            </Text>
            <Text style={s.small}>{option.detail}</Text>
          </Pressable>
        );
      })}
      {!allowInherit && (
        <Text style={[s.small, { color: colors.muted }]}>Explicit deny rules still apply.</Text>
      )}
      <ErrorNotice error={error} />
      <IconSlot>{saving && <ActivityIndicator size="small" color={colors.primary} />}</IconSlot>
    </View>
  );
}

/** Channel permission mode, shown in the expanded channel view. */
export function ChannelPermissionRules({ channelId }: { channelId: string }) {
  return (
    <PermissionModeSelector
      title="Ask me before acting, or auto-approve everything (explicit deny rules still apply)"
      loadUrl={`/api/agent/opencode/channels/${channelId}/permissions/mode`}
      saveUrl={`/api/agent/opencode/channels/${channelId}/permissions/mode`}
    />
  );
}

/** Per-thread mode override, shown in the thread banner. */
export function ThreadPermissionRules({ threadId }: { threadId: string }) {
  return (
    <PermissionModeSelector
      title="Thread override (wins over the channel mode)"
      loadUrl={`/api/agent/opencode/threads/${threadId}/permissions/mode`}
      saveUrl={`/api/agent/opencode/threads/${threadId}/permissions/mode`}
      allowInherit
    />
  );
}

/**
 * Permissions section for agent settings: every channel with an expandable
 * rule editor. Thread overrides (set inside a thread) win over these.
 */
export function PermissionsSettings() {
  const { api } = useWorkspace();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setChannels(await api.request<Channel[]>("/api/agent/channels"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card style={{ gap: 12 }}>
      <SectionHeading title="Permissions" />
      <Text style={s.muted}>
        Ask: approve each action. Auto-approve: run without asking (explicit deny rules still
        apply). Thread overrides win over the channel mode.
      </Text>
      <ErrorNotice error={error} />
      {channels === null ? (
        <Pending height={96} />
      ) : !channels.length ? (
        <Empty icon={Hash} title="No channels yet" detail="Create a channel to set its rules." />
      ) : (
        channels.map((channel) => (
          <View
            key={channel.id}
            style={{
              gap: 12,
              paddingBottom: 16,
              borderBottomWidth: 1,
              borderBottomColor: colors.line,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Permission rules for ${channel.name}`}
              onPress={() => setExpanded(expanded === channel.id ? null : channel.id)}
              style={[s.row, { gap: 10, alignItems: "center", paddingVertical: 10 }]}
            >
              <ShieldCheck size={17} color={colors.muted} />
              <Text style={[s.text, { flex: 1, fontWeight: "600" }]} numberOfLines={1}>
                {channel.name}
              </Text>
              <Text style={[s.small, { fontWeight: "600" }]}>
                {expanded === channel.id ? "Hide" : "Edit"}
              </Text>
            </Pressable>
            {expanded === channel.id && <ChannelPermissionRules channelId={channel.id} />}
          </View>
        ))
      )}
    </Card>
  );
}
