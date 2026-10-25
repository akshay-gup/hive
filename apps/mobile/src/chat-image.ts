/** The most a picture is sent at, on its longer side; a smaller one goes beside it to show in the conversation. */
export const MAX_SIDE = 2048;
export const THUMB_SIDE = 400;
/** A picture under this many bytes and within the size above is sent as it is. */
export const LEAVE_ALONE_BYTES = 1.5 * 1024 ** 2;

/** The kinds of picture that are made smaller (the phone's own, and the usual ones). */
export const resizable = (mime: string) => /^image\/(png|jpe?g|webp|heic|heif)$/i.test(mime);

/** How to make a picture of this size fit on its longer side, or null when it already does. */
export function fitTo(
  width: number,
  height: number,
  side: number,
): { width: number } | { height: number } | null {
  if (!(width > 0) || !(height > 0) || Math.max(width, height) <= side) return null;
  return width >= height ? { width: side } : { height: side };
}

/** The size a picture comes to when fitted. */
export function fitted(width: number, height: number, side: number) {
  const scale = Math.min(1, side / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Whether a picture of this size and weight is worth making smaller before it is sent. */
export const worthShrinking = (width: number, height: number, bytes: number) =>
  Math.max(width, height) > MAX_SIDE || bytes > LEAVE_ALONE_BYTES;
