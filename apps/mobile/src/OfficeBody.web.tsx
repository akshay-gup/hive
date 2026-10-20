import { useEffect, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type { ChannelFile } from "../../../packages/domain/src/workspace-files";
import { fileSize } from "./file-format";
import { openFile, TableGrid } from "./file-preview";
import {
  officeLimits,
  officeView,
  readDocument,
  readPicture,
  readSheets,
  readSlides,
  type Sheet,
  type Slide,
} from "./office-read";
import { Button, colors, ErrorNotice, Pending, radius, s } from "./ui";

type Loaded =
  | { view: "document"; html: string }
  | { view: "sheets"; sheets: Sheet[] }
  | { view: "slides"; slides: Slide[] }
  | { view: "picture"; src: string };

/** The whole file, read in this page and not sent anywhere else. */
async function load(file: ChannelFile, url: string): Promise<Loaded> {
  const view = officeView(file.name);
  if (!view) throw new Error("There is no preview for this kind of file.");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The file could not be read (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  switch (view) {
    case "document":
      return { view, html: await readDocument(bytes) };
    case "sheets":
      return { view, sheets: await readSheets(bytes) };
    case "slides":
      return { view, slides: readSlides(bytes) };
    case "picture": {
      const picture = readPicture(bytes);
      if (!picture) throw new Error("This file has no preview picture inside it.");
      return {
        view,
        src: URL.createObjectURL(
          new Blob([picture.bytes.slice().buffer as ArrayBuffer], { type: picture.type }),
        ),
      };
    }
  }
}

function Download({ url }: { url: string }) {
  return (
    <Button onPress={() => void openFile(url, true)} small>
      Download
    </Button>
  );
}

function Sheets({ sheets }: { sheets: Sheet[] }) {
  const [active, setActive] = useState(0);
  const sheet = sheets[active] ?? sheets[0];
  if (!sheet) return <Text style={s.muted}>This file has no sheets.</Text>;
  return (
    <View style={{ gap: 10 }}>
      {sheets.length > 1 && (
        <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
          {sheets.map((item, index) => (
            <Pressable
              key={item.name}
              accessibilityRole="tab"
              accessibilityState={{ selected: index === active }}
              onPress={() => setActive(index)}
              style={{
                paddingVertical: 5,
                paddingHorizontal: 10,
                borderRadius: radius.md,
                backgroundColor: index === active ? colors.primarySoft : colors.surfaceMuted,
              }}
            >
              <Text style={[s.small, { color: colors.text }]}>{item.name}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <TableGrid table={sheet.table} />
    </View>
  );
}

function Slides({ slides }: { slides: Slide[] }) {
  if (!slides.length) return <Text style={s.muted}>This presentation has no slides.</Text>;
  return (
    <View style={{ gap: 10 }}>
      {slides.map((slide) => (
        <View
          key={slide.number}
          style={{
            gap: 6,
            padding: 14,
            borderWidth: 1,
            borderColor: colors.line,
            borderRadius: radius.md,
            backgroundColor: colors.paper,
          }}
        >
          <Text style={s.small}>Slide {slide.number}</Text>
          {slide.lines.length ? (
            slide.lines.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of a slide have no identity but their place
              <Text key={index} style={index === 0 ? [s.text, { fontWeight: "600" }] : s.text}>
                {line}
              </Text>
            ))
          ) : (
            <Text style={s.muted}>No text on this slide.</Text>
          )}
        </View>
      ))}
    </View>
  );
}

/**
 * Word, Excel, PowerPoint and iWork files, read in the browser. It shows what is in them, not their
 * exact layout, and says so; the file itself is a download away.
 */
export function OfficeBody({ file }: { file: ChannelFile }) {
  const url = file.url;
  const [state, setState] = useState<{ loaded?: Loaded; error?: string }>({});
  const tooBig = file.size > officeLimits.bytes;
  useEffect(() => {
    if (!url || tooBig) return;
    let active = true;
    let made: string | undefined;
    setState({});
    load(file, url)
      .then((loaded) => {
        if (loaded.view === "picture") made = loaded.src;
        if (active) setState({ loaded });
      })
      .catch((error) => {
        if (active)
          setState({
            error: error instanceof Error ? error.message : "The file could not be read.",
          });
      });
    return () => {
      active = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [file, url, tooBig]);
  if (!url) return <Text style={s.muted}>This file cannot be opened right now.</Text>;
  if (tooBig || !officeView(file.name))
    return (
      <View style={{ gap: 12, alignItems: "flex-start" }}>
        <Text style={s.muted}>
          {tooBig
            ? `This file is ${fileSize(file.size)}, too big to preview here.`
            : "There is no preview for this kind of file."}
        </Text>
        <Download url={url} />
      </View>
    );
  if (state.error)
    return (
      <View style={{ gap: 12, alignItems: "flex-start" }}>
        <ErrorNotice error={state.error} />
        <Download url={url} />
      </View>
    );
  const { loaded } = state;
  if (!loaded) return <Pending height={200} />;
  return (
    <View style={{ gap: 10 }}>
      {loaded.view === "document" && (
        <iframe
          title={file.name}
          // Nothing in the frame may run, and the page inside says the same in its own policy.
          sandbox=""
          srcDoc={loaded.html}
          style={{
            height: 560,
            width: "100%",
            border: 0,
            borderRadius: radius.lg,
            background: colors.paper,
          }}
        />
      )}
      {loaded.view === "sheets" && <Sheets sheets={loaded.sheets} />}
      {loaded.view === "slides" && <Slides slides={loaded.slides} />}
      {loaded.view === "picture" && (
        <Image
          accessibilityLabel={`First page of ${file.name}`}
          source={{ uri: loaded.src }}
          resizeMode="contain"
          style={{ width: "100%", height: 460, borderRadius: radius.md }}
        />
      )}
      <Text style={s.small}>
        {loaded.view === "picture"
          ? "The first page only. "
          : "A preview of what is in the file, without its exact layout or charts. "}
        <Text
          accessibilityRole="link"
          style={{ color: colors.primary, textDecorationLine: "underline" }}
          onPress={() => void openFile(url, true)}
        >
          Download the file
        </Text>{" "}
        to see it all.
      </Text>
    </View>
  );
}
