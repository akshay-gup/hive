import {
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  File as GenericFile,
  Globe,
  type LucideIcon,
} from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Image, Linking, Platform, ScrollView, Text, View } from "react-native";
import {
  type ChannelFile,
  channelFileLimits,
  type FileKind,
} from "../../../packages/domain/src/workspace-files";
import { AssistantResponse } from "./assistant-response";
import { HtmlFrame, MediaPlayer, PdfFrame } from "./FileEmbed";
import { fileSize, parseTable, prettyJson, type Table } from "./file-format";
import { OfficeBody } from "./OfficeBody";
import {
  Button,
  colors,
  ErrorNotice,
  fontSize,
  monoFont,
  monoProps,
  Pending,
  radius,
  s,
} from "./ui";

export const kindIcon: Record<FileKind, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  video: FileVideo,
  audio: FileAudio,
  markdown: FileText,
  html: Globe,
  csv: FileSpreadsheet,
  json: FileJson,
  code: FileCode,
  text: FileText,
  archive: FileArchive,
  office: FileText,
  other: GenericFile,
};

/** A link to the file's bytes, from a listing or `info`. Opens in the browser, or the phone's viewer. */
export const openFile = (url: string, download = false) =>
  Linking.openURL(download ? `${url}${url.includes("?") ? "&" : "?"}download=1` : url);

/** The start of a text file, from its link. Only as much as a viewer shows is ever fetched. */
function useFileText(url: string | undefined, limit: number) {
  const [state, setState] = useState<{ text?: string; error?: string }>({});
  useEffect(() => {
    if (!url) return;
    let active = true;
    setState({});
    fetch(`${url}${url.includes("?") ? "&" : "?"}head=${limit}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`The file could not be read (${response.status}).`);
        return response.text();
      })
      .then((text) => {
        if (active) setState({ text });
      })
      .catch((e) => {
        if (active) setState({ error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      active = false;
    };
  }, [url, limit]);
  return state;
}

/** Code and plain text, in a code font. Long lines scroll sideways rather than wrapping. */
export function TextBlock({ text, maxHeight }: { text: string; maxHeight?: number }) {
  return (
    <View
      style={{
        backgroundColor: colors.surfaceMuted,
        borderRadius: radius.md,
        maxHeight,
        overflow: "hidden",
      }}
    >
      <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ padding: 12 }}>
        <Text
          selectable
          {...monoProps}
          style={{
            fontFamily: monoFont,
            fontSize: fontSize.small,
            lineHeight: 19,
            color: colors.text,
          }}
        >
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

/** The first rows of a spreadsheet as a grid, with the first row as its heading. */
function TablePreview({ text, delimiter }: { text: string; delimiter: string }) {
  const table = useMemo(() => parseTable(text, delimiter), [text, delimiter]);
  return <TableGrid table={table} />;
}

export function TableGrid({ table }: { table: Table }) {
  if (!table.rows.length) return <Text style={s.muted}>This file is empty.</Text>;
  const [head, ...rows] = table.rows;
  const cell = (value: string, key: number, bold = false) => (
    <View
      key={key}
      style={{
        width: 150,
        padding: 8,
        borderRightWidth: 1,
        borderRightColor: colors.line,
      }}
    >
      <Text
        numberOfLines={3}
        style={[
          s.text,
          { fontSize: fontSize.small, lineHeight: 18 },
          bold && { fontWeight: "600" },
        ]}
      >
        {value}
      </Text>
    </View>
  );
  return (
    <View style={{ gap: 8 }}>
      <View
        style={{
          borderWidth: 1,
          borderColor: colors.line,
          borderRadius: radius.md,
          overflow: "hidden",
        }}
      >
        <ScrollView horizontal nestedScrollEnabled>
          <View>
            <View style={[s.row, { backgroundColor: colors.surfaceMuted, alignItems: "stretch" }]}>
              {head.map((value, index) => cell(value, index, true))}
            </View>
            {rows.map((row, index) => (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: rows of a file have no identity but their place
                key={index}
                style={[
                  s.row,
                  { alignItems: "stretch", borderTopWidth: 1, borderTopColor: colors.line },
                ]}
              >
                {row.map((value, column) => cell(value, column))}
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
      {(table.moreRows || table.moreColumns) && (
        <Text style={s.small}>
          Showing the first {table.rows.length} rows
          {table.moreColumns ? " and the first columns" : ""}. Download the file to see the rest.
        </Text>
      )}
    </View>
  );
}

/** Text a viewer loads from the file's link, in the way that suits its kind. */
function TextBody({ file }: { file: ChannelFile }) {
  const limit = channelFileLimits.textViewBytes;
  const { text, error } = useFileText(file.url, limit);
  if (error) return <ErrorNotice error={error} />;
  if (text === undefined) return <Pending height={200} />;
  const cut = file.size > limit;
  return (
    <View style={{ gap: 10 }}>
      {file.kind === "markdown" ? (
        <AssistantResponse content={text} />
      ) : file.kind === "csv" ? (
        <TablePreview
          text={text}
          delimiter={file.name.toLowerCase().endsWith(".tsv") ? "\t" : ","}
        />
      ) : (
        <TextBlock text={file.kind === "json" ? prettyJson(text) : text} />
      )}
      {cut && (
        <Text style={s.small}>
          Showing the first {fileSize(limit)} of {fileSize(file.size)}. Download the file to see the
          rest.
        </Text>
      )}
    </View>
  );
}

/** A file's contents, as much as can be shown: the preview that fits its kind. */
export function FileBody({ file }: { file: ChannelFile }) {
  const url = file.url;
  if (!url) return <Text style={s.muted}>This file cannot be opened right now.</Text>;
  switch (file.kind) {
    case "image":
      // React Native's own image view does not draw SVG; a web view does.
      return file.mimeType === "image/svg+xml" && Platform.OS !== "web" ? (
        <HtmlFrame url={url} height={420} />
      ) : (
        <Image
          accessibilityLabel={file.name}
          source={{ uri: url }}
          resizeMode="contain"
          style={{ width: "100%", height: 460, borderRadius: radius.md }}
        />
      );
    case "pdf":
      return <PdfFrame url={url} height={560} />;
    case "video":
    case "audio":
      return <MediaPlayer url={url} kind={file.kind} name={file.name} />;
    case "html":
      return (
        <View style={{ gap: 8 }}>
          <HtmlFrame url={url} height={540} />
          <Text style={s.small}>
            This page runs in a sandbox, so it can draw itself but cannot reach anything in Hive.
          </Text>
        </View>
      );
    case "markdown":
    case "csv":
    case "json":
    case "code":
    case "text":
      return <TextBody file={file} />;
    case "office":
      return <OfficeBody file={file} />;
    default:
      return (
        <View style={{ gap: 12, alignItems: "flex-start" }}>
          <Text style={s.muted}>There is no preview for this kind of file.</Text>
          <Button icon={kindIcon[file.kind ?? "other"]} onPress={() => void openFile(url, true)}>
            Download
          </Button>
        </View>
      );
  }
}
