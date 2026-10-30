import type { Context } from "hono";
import type { Scope } from "../../../packages/chat-core/src/access.ts";
import { AppError } from "../../../packages/chat-core/src/errors.ts";
import { ORCHESTRATOR_CHANNEL_ID } from "../../../packages/domain/src/agent.ts";
import type { AgentService } from "./engine/service.ts";

const NOT_FOR_GUESTS = "Guests can open only the channels they were added to";

/**
 * Who may reach what a channel holds, for every request to the workspace. A workspace that keeps no
 * roles trusts everyone, as it always did; otherwise:
 *
 * A guest may ask for only what is on a list (see `guestGate`), so a route added later is closed
 * to them until it is put there.
 *
 * Everyone else may ask for anything, except what belongs to a private channel they are not in.
 * That is anything that names the channel, one of its threads, or one of its tasks; the lists
 * (the channels, and the work in the workspace) are cut to what they may open where they are made.
 * To them a channel they may not open is not there.
 */
export async function channelGate(c: Context, owner: string, service: AgentService) {
  const scope = await service.access.scope(owner);
  if (!scope.person) return;
  if (scope.person.role === "guest") return guestGate(c, owner, service, scope);
  return memberGate(c, owner, service, scope);
}

/** An id out of a path comes percent-encoded; one out of a query or a body does not. */
const decoded = (id: string) => {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
};

/** What the request body says, read from a copy so whatever handles the request still has it. */
const bodyOf = async (c: Context): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = await c.req.raw.clone().json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const pathOf = (c: Context) =>
  c.req.path.length > 1 ? c.req.path.replace(/\/+$/, "") : c.req.path;

/** The channel a conversation belongs to: a channel's own, or one of its threads. */
const channelOfThread = async (
  service: AgentService,
  owner: string,
  threadId: string,
): Promise<string | null> =>
  threadId.startsWith("channel:")
    ? threadId.slice("channel:".length) || null
    : ((await service.channelOfThread(owner, threadId))?.channelId ?? null);

/**
 * Anyone but a guest: what names a channel they may not open is refused as if it were not there.
 * Everything else, the whole workspace, is theirs.
 */
async function memberGate(c: Context, owner: string, service: AgentService, scope: Scope) {
  const method = c.req.method;
  const path = pathOf(c);
  const gone = () => new AppError("That channel is not there, or you cannot see it.", 404);
  const channel = (id: unknown) => {
    if (typeof id === "string" && !scope.allows(decoded(id))) throw gone();
  };
  const thread = async (id: unknown) => {
    if (typeof id !== "string" || !id) return;
    const channelId = await channelOfThread(service, owner, decoded(id));
    if (channelId) channel(channelId);
  };
  const match = (pattern: RegExp) => pattern.exec(path);

  const ofChannel = match(/^\/api\/agent\/channels\/([^/]+)(?:\/|$)/);
  if (ofChannel) return channel(ofChannel[1]);
  if (method === "POST" && path === "/api/agent/threads/bind")
    return channel((await bodyOf(c)).channelId);
  const ofThread = match(/^\/api\/agent\/threads\/([^/]+)(?:\/|$)/);
  if (ofThread) return thread(ofThread[1]);
}

/**
 * What a guest may ask this server for. It is a list of what they may do, so a route added later is
 * closed to them until it is put here: the mail, the calendar, the files, the browser, the goals
 * and everything else that belongs to the whole workspace, and the orchestrator chat, which has all
 * of that at its disposal, are not on it.
 *
 * What is on it is the conversation in the channels they were added to: its messages, threads, files
 * and board, and who else is in them.
 */
async function guestGate(c: Context, owner: string, service: AgentService, scope: Scope) {
  const method = c.req.method;
  const path = pathOf(c);
  const refuse = () => new AppError(NOT_FOR_GUESTS, 403);
  const channel = (id: string) => {
    if (!scope.allows(decoded(id)))
      throw new AppError("That channel is not there, or you cannot see it.", 404);
  };
  const thread = async (threadId: unknown) => {
    const id = typeof threadId === "string" ? decoded(threadId) : "";
    const channelId = id ? await channelOfThread(service, owner, id) : null;
    if (!channelId || channelId === ORCHESTRATOR_CHANNEL_ID) throw refuse();
    channel(channelId);
  };
  const match = (pattern: RegExp) => pattern.exec(path);

  if (path === "/api/auth/session" || path === "/api/auth/logout") return;
  // What these send is the guest's own: the server fits the answer to them.
  if (method === "GET" && ["/api/workspace", "/api/agent", "/api/agent/channels"].includes(path))
    return;
  // What they want to be told about is theirs to say.
  if ((method === "GET" || method === "PUT") && path === "/api/agent/notification-prefs") return;
  // A picture of a page the agent read, seen in a conversation: named by a number no one guesses.
  if (method === "GET" && /^\/api\/browser-shots\/[0-9a-f-]{36}(\/link)?$/.test(path)) return;

  const inChannel = match(
    /^\/api\/agent\/channels\/([^/]+)\/(files|files\/info|tasks|threads|uploads\/[^/]+|view\/.+|members|read|mentionable)$/,
  );
  if (inChannel) {
    // They may write to the channel, and leave it: the channel's own rules say whether they may
    // leave this one, and a guest cannot add anyone.
    const adds = ["files", "threads", "members", "read"].includes(inChannel[2]);
    if (method === "GET" || (method === "POST" && adds)) return channel(inChannel[1]);
    throw refuse();
  }

  const ofThread = match(/^\/api\/agent\/threads\/([^/]+)(\/channel)?$/);
  if (ofThread) {
    if ((method === "PATCH" && !ofThread[2]) || (method === "GET" && ofThread[2]))
      return thread(ofThread[1]);
    throw refuse();
  }

  throw refuse();
}
