import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Folder,
  FolderOpen,
  RefreshCw,
  Upload,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Image, Platform, Pressable, Share, Text, View } from "react-native";
import { ORCHESTRATOR_CHANNEL_ID } from "../../../packages/domain/src/agent";
import type { ChannelFile, ChannelFolder } from "../../../packages/domain/src/workspace-files";
import { crumbs, fileSize, fileType, parentOf } from "./file-format";
import { FileBody, kindIcon, openFile } from "./file-preview";
import { pickFiles, uploadChannelFile } from "./file-upload";
import { ago } from "./task-board";
import {
  Button,
  colors,
  Empty,
  ErrorNotice,
  fontSize,
  Pending,
  radius,
  Sheet,
  s,
  type WebPressState,
} from "./ui";
import { useWorkspace } from "./workspace";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const since = (iso: string) => {
  const label = ago(iso);
  return label === "just now" || !label ? label : `${label} ago`;
};
const filesPath = (channelId: string) =>
  `/api/agent/channels/${encodeURIComponent(channelId)}/files`;

/** A file's details as a person reads them: what it is, how big, when it changed. */
export const fileLine = (file: ChannelFile) =>
  [fileType(file), fileSize(file.size), since(file.modifiedAt)].filter(Boolean).join(" · ");

/** The actions on one file, and what is in it. */
export function ChannelFileView({ file }: { file: ChannelFile }) {
  const { notify } = useWorkspace();
  async function copyPath() {
    try {
      if (Platform.OS === "web") {
        await navigator.clipboard.writeText(file.path);
        notify("Path copied");
      } else await Share.share({ message: file.path });
    } catch {
      notify(`Could not copy. The path is ${file.path}`);
    }
  }
  return (
    <View style={{ gap: 16 }}>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button
          small
          icon={ExternalLink}
          disabled={!file.url}
          onPress={() => file.url && void openFile(file.url)}
        >
          Open
        </Button>
        <Button
          small
          icon={Download}
          disabled={!file.url}
          onPress={() => file.url && void openFile(file.url, true)}
        >
          Download
        </Button>
        <Button small icon={Copy} onPress={() => void copyPath()}>
          Copy path
        </Button>
      </View>
      <FileBody file={file} />
    </View>
  );
}

/** A single file opened from a chat: its contents, and a way to the folder it is in. */
export function ChannelFileSheet({ channelId, path }: { channelId: string; path: string }) {
  const { api, close, open } = useWorkspace();
  const [file, setFile] = useState<ChannelFile | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void api
      .request<ChannelFile>(`${filesPath(channelId)}/info?path=${encodeURIComponent(path)}`)
      .then((info) => {
        if (active) setFile(info);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [api, channelId, path, attempt]);
  return (
    <Sheet
      title={path.split("/").at(-1) || "File"}
      subtitle={file ? fileLine(file) : undefined}
      onClose={close}
      wide
      tall
    >
      <View style={{ gap: 16 }}>
        <ErrorNotice error={error} />
        {file ? (
          <ChannelFileView file={file} />
        ) : error ? (
          <Button onPress={() => setAttempt((n) => n + 1)}>Try again</Button>
        ) : (
          <Pending height={240} />
        )}
        <Button
          small
          icon={FolderOpen}
          onPress={() => open({ type: "channelFiles", channelId, path: parentOf(path) })}
        >
          Show in files
        </Button>
      </View>
    </Sheet>
  );
}

function FileRow({
  file,
  onPress,
  showFolder,
}: {
  file: ChannelFile;
  onPress: () => void;
  showFolder?: boolean;
}) {
  const folder = file.type === "folder";
  const Icon = folder ? Folder : kindIcon[file.kind ?? "other"];
  const where = showFolder ? parentOf(file.path) : "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${folder ? "Open folder" : "Open"} ${file.name}`}
      onPress={onPress}
      style={({ pressed, hovered }: WebPressState) => [
        s.row,
        { gap: 12, paddingVertical: 10, paddingHorizontal: 8, borderRadius: radius.lg },
        (pressed || hovered) && { backgroundColor: colors.surfaceMuted },
      ]}
    >
      {file.kind === "image" && file.url && file.mimeType !== "image/svg+xml" ? (
        <Image
          source={{ uri: file.url }}
          resizeMode="cover"
          style={{ width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.line }}
        />
      ) : (
        <View style={s.iconBox}>
          <Icon size={19} color={colors.primary} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.text, { fontWeight: "500" }]} numberOfLines={1}>
          {file.name}
        </Text>
        <Text style={s.small} numberOfLines={1}>
          {folder ? since(file.modifiedAt) : fileLine(file)}
          {where ? ` · in ${where}` : ""}
        </Text>
      </View>
      {folder && <ChevronRight size={18} color={colors.muted} />}
    </Pressable>
  );
}

/**
 * Everything in a channel's workspace: what the agent makes there, and what people add. Recent shows
 * the latest changes anywhere, which is what answers "what did the agent just make"; Browse walks
 * the folders.
 */
export function ChannelFilesSheet({
  channelId,
  name,
  path,
}: {
  channelId: string;
  name?: string;
  path?: string;
}) {
  const { api, close, notify } = useWorkspace();
  const [tab, setTab] = useState<"recent" | "browse">(path ? "browse" : "recent");
  const [folder, setFolder] = useState(path ?? "");
  const [listing, setListing] = useState<ChannelFolder | null>(null);
  const [viewing, setViewing] = useState<ChannelFile | null>(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const query = tab === "recent" ? "recent=1&limit=50" : `path=${encodeURIComponent(folder)}`;
  useEffect(() => {
    let active = true;
    setError("");
    setListing(null);
    void api
      .request<ChannelFolder>(`${filesPath(channelId)}?${query}`)
      .then((result) => {
        if (active) setListing(result);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [api, channelId, query, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /** A listing's links may be old by now, so a file is looked up again for a fresh one as it opens. */
  async function view(file: ChannelFile) {
    if (opening) return;
    setOpening(true);
    setError("");
    try {
      setViewing(
        await api.request<ChannelFile>(
          `${filesPath(channelId)}/info?path=${encodeURIComponent(file.path)}`,
        ),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setOpening(false);
    }
  }
  async function upload() {
    setError("");
    let added = 0;
    try {
      const picked = await pickFiles();
      if (!picked.length) return;
      setUploading(true);
      for (const item of picked) {
        await uploadChannelFile(
          api,
          channelId,
          item,
          tab === "browse" && folder ? folder : undefined,
        );
        added++;
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUploading(false);
      if (added) {
        notify(added === 1 ? "File added" : `${added} files added`);
        reload();
      }
    }
  }

  if (viewing)
    return (
      <Sheet title={viewing.name} subtitle={fileLine(viewing)} onClose={close} wide tall>
        <View style={{ gap: 16 }}>
          <View style={[s.row, { justifyContent: "flex-start" }]}>
            <Button
              small
              icon={ChevronLeft}
              onPress={() => {
                setViewing(null);
                reload();
              }}
            >
              Back to files
            </Button>
          </View>
          <ChannelFileView file={viewing} />
        </View>
      </Sheet>
    );

  const entries = listing?.entries ?? [];
  return (
    <Sheet
      title="Files"
      subtitle={
        channelId === ORCHESTRATOR_CHANNEL_ID
          ? "Private to you · what the agent makes and what you add"
          : name
            ? `#${name} · what the agent makes and what people add`
            : undefined
      }
      onClose={close}
      wide
      tall
    >
      <View style={{ gap: 14 }}>
        <View style={[s.between, { gap: 8, flexWrap: "wrap" }]}>
          <View style={[s.row, { gap: 8 }]}>
            {(["recent", "browse"] as const).map((item) => (
              <Button
                key={item}
                small
                primary={tab === item}
                onPress={() => {
                  setTab(item);
                  if (item === "browse") setFolder("");
                }}
              >
                {item === "recent" ? "Recent" : "Browse"}
              </Button>
            ))}
          </View>
          <View style={[s.row, { gap: 8 }]}>
            <Button small icon={RefreshCw} onPress={reload}>
              Refresh
            </Button>
            <Button small primary icon={Upload} busy={uploading} onPress={() => void upload()}>
              Upload
            </Button>
          </View>
        </View>
        {tab === "browse" && (
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            <Pressable accessibilityRole="button" onPress={() => setFolder("")}>
              <Text style={[s.small, { color: folder ? colors.primaryText : colors.text }]}>
                Files
              </Text>
            </Pressable>
            {crumbs(folder).map((crumb, index, all) => (
              <View key={crumb.path} style={[s.row, { gap: 6 }]}>
                <ChevronRight size={12} color={colors.muted} />
                <Pressable
                  accessibilityRole="button"
                  disabled={index === all.length - 1}
                  onPress={() => setFolder(crumb.path)}
                >
                  <Text
                    style={[
                      s.small,
                      { color: index === all.length - 1 ? colors.text : colors.primaryText },
                    ]}
                  >
                    {crumb.name}
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <ErrorNotice error={error} />
        {!listing && !error ? (
          <Pending height={240} />
        ) : listing && !entries.length ? (
          <Empty
            icon={FolderOpen}
            title={tab === "recent" ? "No files yet" : "This folder is empty"}
            detail={
              tab === "recent"
                ? "Files the agent makes in this channel, and files people upload, show up here."
                : "Nothing is in this folder yet."
            }
          />
        ) : (
          <View>
            {entries.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                showFolder={tab === "recent"}
                onPress={() => {
                  if (file.type === "folder") {
                    setTab("browse");
                    setFolder(file.path);
                  } else void view(file);
                }}
              />
            ))}
          </View>
        )}
        {listing?.truncated && (
          <Text style={s.small}>
            Showing the first {entries.length} files here.{" "}
            {tab === "recent" ? "Browse the folders for older ones." : ""}
          </Text>
        )}
        <Text style={[s.small, { fontSize: fontSize.caption }]}>
          {tab === "browse" && folder
            ? `Uploads go in ${folder}.`
            : "Uploads go in the uploads folder, where the agent can find them."}
        </Text>
      </View>
    </Sheet>
  );
}
