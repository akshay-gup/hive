import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { z } from "zod";

/** A guest has the run of only the channels they were added to. */
export type WorkspaceRole = "owner" | "admin" | "member" | "guest";
export const workspaceRoles: readonly WorkspaceRole[] = ["owner", "admin", "member", "guest"];

/** Who the control plane says a person is, and what they may do, for one workspace. */
export interface WorkspaceIdentity {
  /** The person's account id in the control plane. */
  sub: string;
  email: string;
  name: string;
  role: WorkspaceRole;
}

export interface VerifiedWorkspaceToken extends WorkspaceIdentity {
  workspaceId: string;
  /** Unique to this token, so a workspace can refuse to see one twice. */
  id: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

export class WorkspaceTokenError extends Error {
  constructor(
    readonly reason: "malformed" | "signature" | "expired" | "audience" | "issuer" | "lifetime",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceTokenError";
  }
}

export const TOKEN_ISSUER = "hive-control";
/** A token only has to last long enough for the app to hand it to the workspace. */
export const DEFAULT_TOKEN_SECONDS = 60;
export const MAX_TOKEN_SECONDS = 15 * 60;
/** Clocks of the control plane and a workspace may differ a little. */
const LEEWAY_SECONDS = 30;

const audience = (workspaceId: string) => `ws:${workspaceId}`;
const claimsSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1).max(200),
  email: z.string().min(1).max(320),
  name: z.string().max(200),
  role: z.enum(["owner", "admin", "member", "guest"]),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(8).max(100),
});

/** A fresh signing pair, each key as base64url DER: the private one stays with the control plane. */
export function generateWorkspaceKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  };
}

/** The verifying key from its base64url DER form, or an error saying what is wrong with it. */
export function parseWorkspacePublicKey(encoded: string): KeyObject {
  try {
    const key = createPublicKey({
      key: Buffer.from(encoded, "base64url"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
    return key;
  } catch {
    throw new Error("The control plane public key is not a base64url Ed25519 (SPKI DER) key");
  }
}

function parsePrivateKey(encoded: string): KeyObject {
  try {
    const key = createPrivateKey({
      key: Buffer.from(encoded, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
    return key;
  } catch {
    throw new Error("The control plane signing key is not a base64url Ed25519 (PKCS8 DER) key");
  }
}

/** The verifying key that goes with a signing key, so a deployment only has to be given one. */
export function workspacePublicKeyOf(privateKey: string): string {
  return createPublicKey(parsePrivateKey(privateKey))
    .export({ type: "spki", format: "der" })
    .toString("base64url");
}

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const header = part({ alg: "EdDSA", typ: "JWT" });

/**
 * A short-lived JWT (EdDSA) naming one person and their role in one workspace. The workspace
 * trusts it because the control plane signed it, and for that workspace only.
 */
export function signWorkspaceToken(
  privateKey: string,
  input: WorkspaceIdentity & { workspaceId: string; ttlSeconds?: number; now?: number },
): string {
  const ttl = input.ttlSeconds ?? DEFAULT_TOKEN_SECONDS;
  if (ttl <= 0 || ttl > MAX_TOKEN_SECONDS)
    throw new Error(`A workspace token lasts between 1 and ${MAX_TOKEN_SECONDS} seconds`);
  const issued = Math.floor((input.now ?? Date.now()) / 1000);
  const body = `${header}.${part({
    iss: TOKEN_ISSUER,
    aud: audience(input.workspaceId),
    sub: input.sub,
    email: input.email,
    name: input.name,
    role: input.role,
    iat: issued,
    exp: issued + ttl,
    jti: randomUUID(),
  })}`;
  return `${body}.${sign(null, Buffer.from(body), parsePrivateKey(privateKey)).toString("base64url")}`;
}

/** What a token says, once it is known to be signed by the control plane for this workspace. */
export function verifyWorkspaceToken(
  publicKey: string,
  token: string,
  expected: { workspaceId: string; now?: number },
): VerifiedWorkspaceToken {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[\w-]+$/.test(p)))
    throw new WorkspaceTokenError("malformed", "This sign-in is not valid. Try again.");
  const [head, payload, signature] = parts as [string, string, string];
  let claims: z.infer<typeof claimsSchema>;
  try {
    const decoded = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    // Only the algorithm this module signs with: never `none`, never a key the token names.
    if (decoded?.alg !== "EdDSA")
      throw new WorkspaceTokenError("malformed", "This sign-in is not valid. Try again.");
    claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch (error) {
    if (error instanceof WorkspaceTokenError) throw error;
    throw new WorkspaceTokenError("malformed", "This sign-in is not valid. Try again.");
  }
  const signed = Buffer.from(`${head}.${payload}`);
  const valid = verify(
    null,
    signed,
    parseWorkspacePublicKey(publicKey),
    Buffer.from(signature, "base64url"),
  );
  if (!valid) throw new WorkspaceTokenError("signature", "This sign-in is not valid. Try again.");
  if (claims.iss !== TOKEN_ISSUER)
    throw new WorkspaceTokenError("issuer", "This sign-in is not valid. Try again.");
  if (claims.aud !== audience(expected.workspaceId))
    throw new WorkspaceTokenError("audience", "This sign-in is for a different workspace.");
  const now = Math.floor((expected.now ?? Date.now()) / 1000);
  if (claims.exp <= now - LEEWAY_SECONDS || claims.iat > now + LEEWAY_SECONDS)
    throw new WorkspaceTokenError("expired", "This sign-in expired. Try again.");
  if (claims.exp - claims.iat > MAX_TOKEN_SECONDS + LEEWAY_SECONDS)
    throw new WorkspaceTokenError("lifetime", "This sign-in is not valid. Try again.");
  return {
    workspaceId: expected.workspaceId,
    sub: claims.sub,
    email: claims.email,
    name: claims.name,
    role: claims.role,
    id: claims.jti,
    expiresAt: claims.exp * 1000,
  };
}
