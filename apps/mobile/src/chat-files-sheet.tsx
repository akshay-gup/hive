import { File as FileIcon, FileText, Image as ImageIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ChatFile } from "../../../packages/domain/src/chat";
import { openChatFile } from "./chat-files";
import { fileSize } from "./file-format";
import { colors, dateLabel, Empty, ErrorNotice, Pending, radius, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

interface Listed extends ChatFile {
  createdAt: string;
}

/** The files people have sent to a channel, newest first, each to open. */
export function ChatFilesSheet({ channelId, name }: { channelId: string; name?: string }) {
  const { api, close } = useWorkspace();
  const [files, setFiles] = useState<Listed[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api
      .request<Listed[]>(`/chat/v1/channels/${encodeURIComponent(channelId)}/files`)
      .then((list) => live && setFiles(list))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [api, channelId]);
  return (
    <Sheet title="Files" subtitle={name ? `Sent to ${name}` : undefined} onClose={close}>
      <View style={{ gap: 4 }}>
        <ErrorNotice error={error} />
        {!files && !error ? (
          <Pending height={96} />
        ) : files && files.length === 0 ? (
          <Empty
            icon={FileIcon}
            title="No files yet"
            detail="Files sent in this channel will be here."
          />
        ) : (
          files?.map((file) => {
            const Icon = /^image\//i.test(file.mime)
              ? ImageIcon
              : /pdf|text|word|sheet/i.test(file.mime)
                ? FileText
                : FileIcon;
            return (
              <Pressable
                key={file.id}
                accessibilityRole="button"
                accessibilityLabel={`Open file: ${file.name}`}
                onPress={() =>
                  void openChatFile(api, file).catch((e) => setError(String(e.message ?? e)))
                }
                style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                  s.row,
                  {
                    gap: 12,
                    paddingVertical: 10,
                    paddingHorizontal: 10,
                    borderRadius: radius.md,
                    backgroundColor: pressed || hovered ? colors.surfaceHover : "transparent",
                  },
                ]}
              >
                <Icon size={20} color={colors.muted} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.text} numberOfLines={1}>
                    {file.name}
                  </Text>
                  <Text style={s.small}>
                    {fileSize(file.bytes)} · {dateLabel(file.createdAt)}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
      </View>
    </Sheet>
  );
}
