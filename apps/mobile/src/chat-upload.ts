import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";
import type { MuseApi } from "./api-client";
import { fileSize } from "./file-format";
import type { PickedFile } from "./file-upload";

/** The most a picture is sent at, in either direction; larger ones are made smaller before they go. */
const MAX_SIDE = 2048;
const THUMB_SIDE = 400;
/** A picture under this, already small enough to the eye, is sent as it is. */
const LEAVE_ALONE_BYTES = 1.5 * 1024 ** 2;

/** What the service gives for a file to be sent. */
interface Begun {
  fileId: string;
  upload: string;
  thumbUpload?: string;
}

const canResize = (mime: string) => /^image\/(png|jpe?g|webp)$/i.test(mime);

/** A picture made smaller, and a small one to show in the conversation: only where the page can draw them. */
async function shrink(file: File) {
  if (Platform.OS !== "web" || !canResize(file.type) || typeof createImageBitmap !== "function")
    return null;
  try {
    const bitmap = await createImageBitmap(file);
    const draw = (side: number, quality: number) => {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    };
    const tooBig =
      Math.max(bitmap.width, bitmap.height) > MAX_SIDE || file.size > LEAVE_ALONE_BYTES;
    const main = tooBig ? ((await draw(MAX_SIDE, 0.85)) ?? file) : file;
    const thumb = await draw(THUMB_SIDE, 0.75);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    return {
      main: main.size < file.size || !tooBig ? main : file,
      thumb: thumb && thumb.size < 2 * 1024 ** 2 ? thumb : undefined,
      width: tooBig ? Math.round(bitmap.width * scale) : bitmap.width,
      height: tooBig ? Math.round(bitmap.height * scale) : bitmap.height,
    };
  } catch {
    return null;
  }
}

async function failure(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error || fallback);
}

/**
 * Send a chosen file to a channel's chat: ask the service where to send it (it says no, in words, to a
 * file that is too big or a workspace that is full), send it there, and say which file it is, to go on
 * a message. A picture goes smaller where the page can make it so, with a small one beside it.
 */
export async function sendChatFile(
  api: MuseApi,
  channelId: string,
  picked: PickedFile,
): Promise<{ fileId: string; name: string; size: number; mime: string }> {
  const mime = picked.mimeType || picked.file?.type || "application/octet-stream";
  let blob: Blob | undefined = picked.file;
  let thumb: Blob | undefined;
  let width: number | undefined;
  let height: number | undefined;
  if (picked.file) {
    const small = await shrink(picked.file);
    if (small) {
      blob = small.main;
      thumb = small.thumb;
      width = small.width;
      height = small.height;
    }
  }
  const bytes = blob?.size ?? picked.size;
  if (!bytes) throw new Error(`${picked.name} could not be read. Please choose it again.`);
  const begun = await api.request<Begun>("/chat/v1/files/uploads", {
    channelId,
    name: picked.name,
    mime: blob?.type && blob.type !== mime ? blob.type : mime,
    bytes,
    ...(thumb ? { thumbBytes: thumb.size } : {}),
    ...(width && height ? { width, height } : {}),
  });
  if (blob) {
    const sent = await fetch(api.chatUrl(begun.upload), { method: "PUT", body: blob });
    if (!sent.ok) throw await failure(sent, `${picked.name} could not be sent.`);
    if (thumb && begun.thumbUpload)
      // A picture that does not arrive does not stop the file.
      await fetch(api.chatUrl(begun.thumbUpload), { method: "PUT", body: thumb }).catch(
        () => undefined,
      );
  } else {
    const sent = await FileSystem.uploadAsync(api.chatUrl(begun.upload), picked.uri, {
      httpMethod: "PUT",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { "Content-Type": mime },
    });
    if (sent.status < 200 || sent.status >= 300)
      throw new Error(`${picked.name} could not be sent (${fileSize(bytes)}).`);
  }
  return { fileId: begun.fileId, name: picked.name, size: bytes, mime };
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
