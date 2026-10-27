import { createHmac, timingSafeEqual } from "node:crypto";

/** How long a ticket works: long enough for the app to keep one fresh, short enough to be of little use if it leaks. */
export const TICKET_MS = 30 * 60_000;

interface Claims {
  workspaceId: string;
  userId: string;
  /** When it stops working, in milliseconds. */
  exp: number;
}

const mac = (key: string, claims: Claims) =>
  createHmac("sha256", key)
    .update(["board", claims.workspaceId, claims.userId, claims.exp].join("\n"))
    .digest("hex");

/**
 * What the app hands the agent's machine so the agent can change the board for the person in the app's own
 * chat with it (which the chat service has no run for). It names the person and nothing else, works only
 * for board calls, and runs out soon. The room made it after it knew who was asking.
 */
export function makeTicket(key: string, claims: Claims): string {
  return `${Buffer.from(JSON.stringify({ u: claims.userId, e: claims.exp })).toString("base64url")}.${mac(key, claims)}`;
}

/** Who a ticket is for, if it is one this key made for this workspace and has not run out. */
export function readTicket(
  key: string,
  workspaceId: string,
  ticket: string,
  now = Date.now(),
): string | null {
  const [body, given] = ticket.split(".");
  if (!body || !given) return null;
  let parsed: { u?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
  if (typeof parsed.u !== "string" || typeof parsed.e !== "number" || parsed.e < now) return null;
  const expected = Buffer.from(mac(key, { workspaceId, userId: parsed.u, exp: parsed.e }));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? parsed.u : null;
}
