import { Download, ExternalLink, Eye, EyeOff, FileX2, Globe } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import {
  type ChannelFile,
  type FileKind,
  type SentFile,
  textKinds,
} from "../../../packages/domain/src/workspace-files";
import { fileLine } from "./channel-files";
import { HtmlFrame, MediaPlayer } from "./FileEmbed";
import { kindIcon, openFile, TextBlock } from "./file-preview";
import { parseSharedFile } from "./tool-results";
import { Button, Card, colors, ErrorNotice, IconSlot, s } from "./ui";
import { useWorkspace } from "./workspace";

/** The first lines of a text file, for a card. */
const firstLines = (text: string, lines = 10) => {
  const all = text.replace(/\s+$/, "").split("\n");
  return all.length > lines ? `${all.slice(0, lines).join("\n")}\n…` : all.join("\n");
};

/**
 * A file an agent shared, as a card in the conversation: a preview that fits what it is, and a way
 * to open and download it. The result names the file but carries no link (links expire, a chat does
 * not), so the card asks the server for the file as it is now, and for a fresh link.
 */
export function ChannelFileCard({ sent }: { sent: SentFile }) {
  const { api, open } = useWorkspace();
  const { channelId, caption } = sent;
  const [file, setFile] = useState<ChannelFile | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(false);
  useEffect(() => {
    let active = true;
    setGone(false);
    setError("");
    void api
      .request<ChannelFile>(
        `/api/agent/channels/${encodeURIComponent(channelId)}/files/info?path=${encodeURIComponent(sent.file.path)}`,
      )
      .then((info) => {
        if (active) setFile(info);
      })
      .catch((e) => {
        if (!active) return;
        // A file that has been moved or deleted since is not an error to alarm anyone with.
        if ((e as { status?: number }).status === 404) setGone(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, channelId, sent.file.path]);

  const shown: ChannelFile = file ?? { ...sent.file, type: "file" };
  const kind: FileKind = shown.kind ?? "other";
  const Icon = kindIcon[kind];
  const view = () => open({ type: "channelFile", channelId, path: sent.file.path });
  const url = file?.url;
  return (
    <Card style={{ padding: 0, overflow: "hidden", maxWidth: 460, width: "100%", gap: 0 }}>
      {url && kind === "image" && (
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={`Open ${shown.name}`}
          onPress={view}
        >
          <Image
            accessibilityLabel={shown.name}
            source={{ uri: url }}
            resizeMode="contain"
            style={{ width: "100%", height: 260, backgroundColor: colors.surfaceMuted }}
          />
        </Pressable>
      )}
      {url && (kind === "video" || kind === "audio") && (
        <View style={{ padding: 10, backgroundColor: colors.surfaceMuted }}>
          <MediaPlayer url={url} kind={kind} name={shown.name} />
        </View>
      )}
      {url && kind === "html" && page && <HtmlFrame url={url} height={360} />}
      {textKinds.has(kind) && kind !== "html" && !!file?.excerpt && (
        <View style={{ padding: 10, backgroundColor: colors.surfaceMuted }}>
          <TextBlock text={firstLines(file.excerpt)} maxHeight={210} />
        </View>
      )}
      <View style={{ padding: 14, gap: 12 }}>
        <View style={[s.row, { gap: 12 }]}>
          <View style={s.iconBox}>
            {gone ? (
              <FileX2 size={19} color={colors.muted} />
            ) : (
              <Icon size={19} color={colors.primary} />
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[s.text, { fontWeight: "600" }]} numberOfLines={2}>
              {shown.name}
            </Text>
            <Text style={s.small} numberOfLines={2}>
              {gone ? "This file is no longer in the workspace." : fileLine(shown)}
            </Text>
          </View>
        </View>
        {!!caption && <Text style={s.muted}>{caption}</Text>}
        <ErrorNotice error={error} />
        {!gone && (
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {kind === "html" && url && (
              <Button small icon={page ? EyeOff : Globe} onPress={() => setPage(!page)}>
                {page ? "Hide preview" : "Show preview"}
              </Button>
            )}
            <Button small icon={kind === "html" ? Eye : ExternalLink} onPress={view}>
              Open
            </Button>
            <Button
              small
              icon={Download}
              disabled={!url}
              onPress={() => url && void openFile(url, true)}
            >
              Download
            </Button>
          </View>
        )}
      </View>
    </Card>
  );
}

/** The card for one `send_file` call: working, shared, or not shared and why. */
export function SentFileToolCard({ result, loading }: { result: unknown; loading: boolean }) {
  const shared = parseSharedFile(result);
  if (shared && "channelId" in shared) return <ChannelFileCard sent={shared} />;
  if (shared)
    return (
      <Card style={{ padding: 14, maxWidth: 460, width: "100%" }}>
        <Text style={[s.text, { fontWeight: "600" }]}>Could not share the file</Text>
        <ErrorNotice error={shared.error} />
      </Card>
    );
  return (
    <Card style={{ padding: 14, maxWidth: 460, width: "100%" }}>
      <View style={[s.row, { gap: 10 }]}>
        <IconSlot>
          {loading ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <FileX2 size={16} color={colors.muted} />
          )}
        </IconSlot>
        <Text style={s.muted}>{loading ? "Sharing a file…" : "The file could not be shown."}</Text>
      </View>
    </Card>
  );
}
