import Check from "lucide-react-native/dist/esm/icons/check";
import FolderOpen from "lucide-react-native/dist/esm/icons/folder-open";
import Upload from "lucide-react-native/dist/esm/icons/upload";
import X from "lucide-react-native/dist/esm/icons/x";
import { useCallback, useContext, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type {
  ChannelFile,
  UploadRequest,
  UploadRequestState,
} from "../../../packages/domain/src/workspace-files";
import { fileSize } from "./file-format";
import { kindIcon } from "./file-preview";
import { type PickedFile, pickFiles, uploadChannelFile } from "./file-upload";
import { JevInteractionContext } from "./jev-tool-card";
import { ago } from "./task-board";
import { parseUploadRequest, uploadMessage } from "./tool-results";
import { Button, Card, Chip, colors, ErrorNotice, IconSlot, radius, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Item {
  picked: PickedFile;
  status: "ready" | "uploading" | "done" | "failed";
  error?: string;
  saved?: ChannelFile;
}
const sameFile = (a: PickedFile, b: PickedFile) => a.name === b.name && a.size === b.size;

/**
 * Choose files, add them to the workspace for the request, and tell the agent. The files are saved
 * first and the agent told after, so a message that cannot be sent (the chat is busy, or offline)
 * can be sent again without uploading anything twice.
 */
function UploadModal({
  request,
  onClose,
  onUploaded,
}: {
  request: UploadRequest;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const { api } = useWorkspace();
  const { send } = useContext(JevInteractionContext);
  const [items, setItems] = useState<Item[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const done = items.length > 0 && items.every((item) => item.status === "done");

  async function choose() {
    setError("");
    try {
      const picked = await pickFiles({ accept: request.accept, multiple: request.multiple });
      if (!picked.length) return;
      setItems((current) =>
        request.multiple
          ? [
              ...current,
              ...picked
                .filter((file) => !current.some((item) => sameFile(item.picked, file)))
                .map((file): Item => ({ picked: file, status: "ready" })),
            ]
          : picked.slice(0, 1).map((file): Item => ({ picked: file, status: "ready" })),
      );
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function submit() {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      const update = (index: number, patch: Partial<Item>) =>
        setItems((current) =>
          current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
        );
      const saved: ChannelFile[] = [];
      let failed = false;
      for (const [index, item] of items.entries()) {
        if (item.status === "done" && item.saved) {
          saved.push(item.saved);
          continue;
        }
        update(index, { status: "uploading", error: undefined });
        try {
          const file = await uploadChannelFile(
            api,
            request.channelId,
            item.picked,
            undefined,
            request.requestId,
          );
          saved.push(file);
          update(index, { status: "done", saved: file });
        } catch (e) {
          failed = true;
          update(index, { status: "failed", error: errorText(e) });
        }
      }
      // Files that are in are worth telling the agent about even if another one failed; the
      // person can add the rest and tell it again.
      if (saved.length) onUploaded();
      if (failed) {
        setError(
          saved.length
            ? "Some files could not be added. Remove them or try again, then send what is in."
            : "The files could not be added.",
        );
        return;
      }
      await tell(saved);
    } finally {
      setWorking(false);
    }
  }

  async function tell(files: readonly ChannelFile[]) {
    try {
      await send(uploadMessage(files));
      onClose();
    } catch (e) {
      setError(
        `The files are added, but the message to the agent was not sent: ${errorText(e)} Try again in a moment.`,
      );
    }
  }

  return (
    <Sheet title="Upload files" subtitle={request.prompt} onClose={onClose}>
      <View style={{ gap: 14 }}>
        {!!request.accept?.length && (
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            <Text style={s.small}>The agent can use:</Text>
            {request.accept.map((type) => (
              <Chip key={type}>{type.toUpperCase()}</Chip>
            ))}
          </View>
        )}
        {items.map((item, index) => {
          const Icon = kindIcon[item.saved?.kind ?? "other"];
          return (
            <View
              key={`${item.picked.name}:${item.picked.size ?? index}`}
              style={[
                s.row,
                {
                  gap: 12,
                  padding: 12,
                  borderWidth: 1,
                  borderColor: item.status === "failed" ? colors.dangerLine : colors.line,
                  borderRadius: radius.lg,
                },
              ]}
            >
              <View style={s.iconBox}>
                {item.status === "uploading" ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : item.status === "done" ? (
                  <Check size={19} color={colors.success} />
                ) : (
                  <Icon size={19} color={colors.primary} />
                )}
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.text} numberOfLines={1}>
                  {item.picked.name}
                </Text>
                <Text
                  style={[s.small, item.status === "failed" && { color: colors.danger }]}
                  numberOfLines={2}
                >
                  {item.status === "failed"
                    ? item.error
                    : item.status === "done"
                      ? "Added"
                      : item.picked.size !== undefined
                        ? fileSize(item.picked.size)
                        : ""}
                </Text>
              </View>
              {!working && item.status !== "done" && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${item.picked.name}`}
                  hitSlop={8}
                  onPress={() => setItems((current) => current.filter((_, i) => i !== index))}
                >
                  <X size={18} color={colors.muted} />
                </Pressable>
              )}
            </View>
          );
        })}
        <ErrorNotice error={error} />
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button
            icon={Upload}
            disabled={working || (!request.multiple && items.length >= 1 && done)}
            onPress={() => void choose()}
          >
            {items.length
              ? request.multiple
                ? "Choose more"
                : "Choose a different file"
              : request.multiple
                ? "Choose files"
                : "Choose a file"}
          </Button>
          <Button
            primary
            busy={working}
            disabled={!items.length}
            onPress={() => void (done ? tell(items.flatMap((item) => item.saved ?? [])) : submit())}
          >
            {done
              ? "Send to the agent"
              : items.length > 1
                ? `Upload ${items.length} files`
                : "Upload"}
          </Button>
        </View>
        <Text style={s.small}>
          Files go in {request.folder}/ in this channel's workspace, and the agent is told where
          they are.
        </Text>
      </View>
    </Sheet>
  );
}

/**
 * An agent's request for files, in the chat: what it needs, an Upload button that opens the
 * modal, and what has been uploaded for it so far (read from the server, so it is right on a
 * later visit and when a teammate answers).
 */
export function UploadRequestCard({ request }: { request: UploadRequest }) {
  const { api, open } = useWorkspace();
  const { busy } = useContext(JevInteractionContext);
  const [state, setState] = useState<UploadRequestState | null>(null);
  const [modal, setModal] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setState(
        await api.request<UploadRequestState>(
          `/api/agent/channels/${encodeURIComponent(request.channelId)}/uploads/${request.requestId}`,
        ),
      );
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }, [api, request.channelId, request.requestId]);
  useEffect(() => {
    void load();
  }, [load]);

  const files = state?.files ?? [];
  const full = !request.multiple && files.length >= 1;
  return (
    <Card style={{ padding: 16, gap: 14, maxWidth: 460, width: "100%" }}>
      <View style={[s.row, { gap: 12, alignItems: "flex-start" }]}>
        <View style={s.iconBox}>
          <Upload size={19} color={colors.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={s.label}>Files needed</Text>
          <Text style={s.text}>{request.prompt}</Text>
        </View>
      </View>
      {!!request.accept?.length && (
        <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
          {request.accept.map((type) => (
            <Chip key={type}>{type.toUpperCase()}</Chip>
          ))}
        </View>
      )}
      {files.map((file) => (
        <Pressable
          key={file.path}
          accessibilityRole="button"
          accessibilityLabel={`Open ${file.name}`}
          onPress={() =>
            open({ type: "channelFile", channelId: request.channelId, path: file.path })
          }
          style={[s.row, { gap: 10 }]}
        >
          <Check size={16} color={colors.success} />
          <Text style={[s.text, { flex: 1, color: colors.primaryText }]} numberOfLines={1}>
            {file.name}
          </Text>
          <Text style={s.small} numberOfLines={1}>
            {fileSize(file.size)} · {file.mine ? "you" : (file.uploadedByName ?? "a teammate")},{" "}
            {ago(file.uploadedAt)}
          </Text>
        </Pressable>
      ))}
      <ErrorNotice error={error} />
      {!full && (
        <View style={{ gap: 6 }}>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              primary
              small
              icon={Upload}
              disabled={busy}
              onPress={() => setModal(true)}
              accessibilityLabel="Upload files for the agent"
            >
              {files.length ? "Add more" : request.multiple ? "Upload files" : "Upload a file"}
            </Button>
            {!!files.length && (
              <Button
                small
                icon={FolderOpen}
                onPress={() =>
                  open({
                    type: "channelFiles",
                    channelId: request.channelId,
                    path: request.folder,
                  })
                }
              >
                Show in files
              </Button>
            )}
          </View>
          {busy && !files.length && (
            <Text style={s.small}>You can upload once the agent has finished replying.</Text>
          )}
        </View>
      )}
      {!files.length && !error && state && <Text style={s.small}>Waiting for your files.</Text>}
      {modal && (
        <UploadModal
          request={request}
          onClose={() => setModal(false)}
          onUploaded={() => void load()}
        />
      )}
    </Card>
  );
}

/** The card for one `request_upload` call: working, asked, or not asked and why. */
export function UploadRequestToolCard({ result, loading }: { result: unknown; loading: boolean }) {
  const parsed = parseUploadRequest(result);
  if (parsed && "channelId" in parsed) return <UploadRequestCard request={parsed} />;
  return (
    <Card style={{ padding: 14, maxWidth: 460, width: "100%" }}>
      {parsed ? (
        <>
          <Text style={[s.text, { fontWeight: "600" }]}>Could not ask for files</Text>
          <ErrorNotice error={parsed.error} />
        </>
      ) : (
        <View style={[s.row, { gap: 10 }]}>
          <IconSlot>
            {loading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Upload size={16} color={colors.muted} />
            )}
          </IconSlot>
          <Text style={s.muted}>
            {loading ? "Asking for files…" : "The request could not be shown."}
          </Text>
        </View>
      )}
    </Card>
  );
}
