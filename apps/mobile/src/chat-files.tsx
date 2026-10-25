import { File as FileIcon, FileText, Image as ImageIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Image, Linking, Platform, Pressable, Text, View } from "react-native";
import type { ChatFile } from "../../../packages/domain/src/chat";
import { chatFileLink } from "./chat-upload";
import { fileSize } from "./file-format";
import { colors, fontSize, radius, s } from "./ui";
import { useWorkspace } from "./workspace";

const isImage = (file: ChatFile) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.mime);

/** A link to a file, asked for when it is needed and made again when it has run out. */
function useFileLink(file: ChatFile, variant: "file" | "thumb") {
  const { api } = useWorkspace();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    chatFileLink(api, file.id, variant)
      .then((link) => live && setUrl(link))
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [api, file.id, variant]);
  return url;
}

/** Open a file: a picture or document in the browser's own viewer, anything else as a download. */
export async function openChatFile(api: ReturnType<typeof useWorkspace>["api"], file: ChatFile) {
  const url = await chatFileLink(api, file.id);
  if (Platform.OS === "web") window.open(url, "_blank", "noopener");
  else await Linking.openURL(url);
}

/** The files of a message: a picture is shown, anything else is a card to open. */
export function ChatFiles({ files }: { files: ChatFile[] }) {
  if (!files.length) return null;
  return (
    <View style={{ gap: 6, paddingTop: 4 }}>
      {files.map((file) =>
        isImage(file) ? <Picture key={file.id} file={file} /> : <Card key={file.id} file={file} />,
      )}
    </View>
  );
}

function Picture({ file }: { file: ChatFile }) {
  const { api } = useWorkspace();
  const url = useFileLink(file, file.thumb ? "thumb" : "file");
  const ratio = file.width && file.height ? file.width / file.height : 4 / 3;
  const width = Math.min(file.thumb ? 400 : 360, file.width ?? 360);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open picture: ${file.name}`}
      onPress={() => void openChatFile(api, file)}
      style={{
        width,
        maxWidth: "100%",
        aspectRatio: ratio,
        borderRadius: radius.md,
        overflow: "hidden",
        backgroundColor: colors.surfaceMuted,
        borderWidth: 1,
        borderColor: colors.line,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {url ? (
        <Image
          source={{ uri: url }}
          accessibilityLabel={file.name}
          style={{ width: "100%", height: "100%" }}
          resizeMode="cover"
        />
      ) : (
        <ImageIcon size={22} color={colors.muted} />
      )}
    </Pressable>
  );
}

function Card({ file }: { file: ChatFile }) {
  const { api } = useWorkspace();
  const Icon = /pdf|text|word|sheet|presentation/i.test(file.mime) ? FileText : FileIcon;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open file: ${file.name}, ${fileSize(file.bytes)}`}
      onPress={() => void openChatFile(api, file)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        s.row,
        {
          gap: 10,
          alignSelf: "flex-start",
          maxWidth: "100%",
          paddingVertical: 8,
          paddingHorizontal: 12,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.line,
          backgroundColor: pressed || hovered ? colors.surfaceHover : colors.surface,
        },
      ]}
    >
      <Icon size={20} color={colors.muted} />
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Text style={[s.text, { fontWeight: "600" }]} numberOfLines={1}>
          {file.name}
        </Text>
        <Text style={{ fontSize: fontSize.caption, color: colors.muted }}>
          {fileSize(file.bytes)}
        </Text>
      </View>
    </Pressable>
  );
}
