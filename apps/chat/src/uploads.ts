import { createHmac, timingSafeEqual } from "node:crypto";

export type LinkKind = "up" | "dl";
/** The file itself, or the smaller picture of it. */
export type Variant = "file" | "thumb";

export interface LinkClaims {
  workspaceId: string;
  kind: LinkKind;
  fileId: string;
  variant: Variant;
  /** When the address stops working, in milliseconds. */
  exp: number;
  /** For an upload: exactly how many bytes may be sent to it. */
  bytes?: number;
}

const mac = (key: string, c: LinkClaims) =>
  createHmac("sha256", key)
    .update([c.workspaceId, c.kind, c.fileId, c.variant, c.exp, c.bytes ?? ""].join("\n"))
    .digest("hex");

/**
 * The address a file is sent to or fetched from. Nothing about who is asking travels with it: the
 * address itself is the permission, made by the room after it checked who may, good for a few minutes,
 * for one file, and (for an upload) for exactly the size that was said.
 */
export function signedPath(key: string, claims: LinkClaims): string {
  const query = new URLSearchParams({
    v: claims.variant,
    exp: String(claims.exp),
    ...(claims.bytes !== undefined ? { n: String(claims.bytes) } : {}),
    sig: mac(key, claims),
  });
  return `/f/${claims.kind}/${encodeURIComponent(claims.fileId)}?${query}`;
}

/** The claims in an address, if its signature is the one this key makes and it has not run out. */
export function readSignedLink(
  key: string,
  workspaceId: string,
  kind: LinkKind,
  fileId: string,
  query: URLSearchParams,
  now = Date.now(),
): LinkClaims | null {
  const variant = query.get("v");
  const exp = Number(query.get("exp"));
  const given = query.get("sig") ?? "";
  const n = query.get("n");
  if ((variant !== "file" && variant !== "thumb") || !Number.isFinite(exp) || !given) return null;
  const claims: LinkClaims = {
    workspaceId,
    kind,
    fileId,
    variant,
    exp,
    ...(n !== null ? { bytes: Number(n) } : {}),
  };
  if (claims.bytes !== undefined && !Number.isInteger(claims.bytes)) return null;
  const expected = Buffer.from(mac(key, claims));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return exp > now ? claims : null;
}

/** What may be shown in the browser itself, and what is only ever downloaded. */
const INLINE =
  /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|audio\/[\w.+-]+|video\/[\w.+-]+)$/i;

/** The headers a file is served with: it never runs as a page, and only the kinds above open in the browser. */
export function serveHeaders(mime: string, name: string, bytes: number): Record<string, string> {
  const inline = INLINE.test(mime);
  const safeName = name.replace(/["\\\r\n]/g, "_");
  return {
    "content-type": inline ? mime : "application/octet-stream",
    "content-length": String(bytes),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "cache-control": "private, max-age=300",
    "accept-ranges": "bytes",
  };
}
