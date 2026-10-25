import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import { Image, Platform } from "react-native";
import type { MuseApi } from "./api-client";
import { fitTo, fitted, MAX_SIDE, resizable, THUMB_SIDE, worthShrinking } from "./chat-image";
import { fileSize } from "./file-format";
import type { PickedFile } from "./file-upload";

/** What the service gives for a file to be sent. */
interface Begun {
  fileId: string;
  upload: string;
  thumbUpload?: string;
}

/** One thing to send: on the web its bytes, on a phone the place they are kept. */
interface Part {
  size: number;
  mime: string;
  blob?: Blob;
  uri?: string;
}

interface Prepared {
  main: Part;
  thumb?: Part;
  width: number;
  height: number;
}

/** A picture made smaller, and a small one to show in the conversation: where the page can draw them. */
async function shrinkOnWeb(file: File): Promise<Prepared | null> {
  if (Platform.OS !== "web" || !resizable(file.type) || typeof createImageBitmap !== "function")
    return null;
  try {
    const bitmap = await createImageBitmap(file);
    const draw = (side: number, quality: number) => {
      const size = fitted(bitmap.width, bitmap.height, side);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    };
    const shrink = worthShrinking(bitmap.width, bitmap.height, file.size);
    const made = shrink ? await draw(MAX_SIDE, 0.85) : null;
    const main = made && made.size < file.size ? made : file;
    const thumb = await draw(THUMB_SIDE, 0.75);
    const size =
      main === file
        ? { width: bitmap.width, height: bitmap.height }
        : fitted(bitmap.width, bitmap.height, MAX_SIDE);
    return {
      main: { size: main.size, mime: main.type || file.type, blob: main },
      thumb:
        thumb && thumb.size < 2 * 1024 ** 2
          ? { size: thumb.size, mime: "image/webp", blob: thumb }
          : undefined,
      ...size,
    };
  } catch {
    return null;
  }
}

/** The same on a phone, with what the phone has for it. It tries the picture as it is if the phone cannot. */
async function shrinkOnPhone(picked: PickedFile, mime: string): Promise<Prepared | null> {
  if (Platform.OS === "web" || !resizable(mime)) return null;
  try {
    const original = await FileSystem.getInfoAsync(picked.uri);
    const size = picked.size ?? (original.exists ? original.size : 0);
    const { width, height } = await new Promise<{ width: number; height: number }>(
      (resolve, reject) =>
        Image.getSize(picked.uri, (w, h) => resolve({ width: w, height: h }), reject),
    );
    // WebP where the phone writes it (Android); a JPEG where it does not (iOS).
    const format =
      Platform.OS === "android"
        ? ImageManipulator.SaveFormat.WEBP
        : ImageManipulator.SaveFormat.JPEG;
    const type = Platform.OS === "android" ? "image/webp" : "image/jpeg";
    const make = async (
      side: number,
      quality: number,
    ): Promise<Part & { width: number; height: number }> => {
      const fit = fitTo(width, height, side);
      const out = await ImageManipulator.manipulateAsync(picked.uri, fit ? [{ resize: fit }] : [], {
        compress: quality,
        format,
      });
      const info = await FileSystem.getInfoAsync(out.uri);
      return {
        uri: out.uri,
        mime: type,
        size: info.exists ? info.size : 0,
        width: out.width,
        height: out.height,
      };
    };
    const shrink = worthShrinking(width, height, size);
    const made = shrink ? await make(MAX_SIDE, 0.85) : null;
    const keep = !made || !made.size || (size > 0 && made.size >= size);
    const thumb = await make(THUMB_SIDE, 0.75);
    return {
      main: keep
        ? { size, mime, uri: picked.uri }
        : { size: made.size, mime: made.mime, uri: made.uri },
      thumb:
        thumb.size > 0 && thumb.size < 2 * 1024 ** 2
          ? { size: thumb.size, mime: thumb.mime, uri: thumb.uri }
          : undefined,
      width: keep || !made ? width : made.width,
      height: keep || !made ? height : made.height,
    };
  } catch {
    return null;
  }
}

async function failure(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error || fallback);
}

/** Send one part to the address the service gave for it. */
async function put(api: MuseApi, address: string, part: Part, name: string): Promise<void> {
  const url = api.chatUrl(address);
  if (part.blob) {
    const sent = await fetch(url, {
      method: "PUT",
      body: part.blob,
      headers: { "Content-Type": part.mime },
    });
    if (!sent.ok) throw await failure(sent, `${name} could not be sent.`);
    return;
  }
  if (!part.uri) throw new Error(`${name} could not be read. Please choose it again.`);
  const sent = await FileSystem.uploadAsync(url, part.uri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { "Content-Type": part.mime },
  });
  if (sent.status < 200 || sent.status >= 300) {
    let error = "";
    try {
      error = (JSON.parse(sent.body) as { error?: string }).error ?? "";
    } catch {
      // Not JSON: the status says enough.
    }
    throw new Error(error || `${name} could not be sent (${fileSize(part.size)}).`);
  }
}

/**
 * Send a chosen file to a channel's chat: ask the service where to send it (it says no, in words, to a
 * file that is too big or a workspace that is full), send it there, and say which file it is, to go on
 * a message. A picture goes smaller, with a small one beside it, on the web and on a phone.
 */
export async function sendChatFile(
  api: MuseApi,
  channelId: string,
  picked: PickedFile,
): Promise<{ fileId: string; name: string; size: number; mime: string }> {
  const mime = picked.mimeType || picked.file?.type || "application/octet-stream";
  const prepared = picked.file ? await shrinkOnWeb(picked.file) : await shrinkOnPhone(picked, mime);
  const main: Part = prepared?.main ?? {
    size: picked.file?.size ?? picked.size ?? 0,
    mime,
    blob: picked.file,
    uri: picked.uri,
  };
  if (!main.size) throw new Error(`${picked.name} could not be read. Please choose it again.`);
  const begun = await api.request<Begun>("/chat/v1/files/uploads", {
    channelId,
    name: picked.name,
    mime: main.mime || mime,
    bytes: main.size,
    ...(prepared?.thumb ? { thumbBytes: prepared.thumb.size } : {}),
    ...(prepared ? { width: prepared.width, height: prepared.height } : {}),
  });
  await put(api, begun.upload, main, picked.name);
  // A picture that does not arrive does not stop the file.
  if (prepared?.thumb && begun.thumbUpload)
    await put(api, begun.thumbUpload, prepared.thumb, picked.name).catch(() => undefined);
  return { fileId: begun.fileId, name: picked.name, size: main.size, mime };
}

/** A link to fetch a file from, good for a few minutes. */
export async function chatFileLink(
  api: MuseApi,
  fileId: string,
  variant: "file" | "thumb" = "file",
) {
  const link = await api.request<{ path: string; expiresAt: number }>(
    `/chat/v1/files/${encodeURIComponent(fileId)}/link`,
    { variant },
  );
  return api.chatUrl(link.path);
}
