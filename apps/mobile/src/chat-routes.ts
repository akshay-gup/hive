/**
 * Which of the app's calls the chat service answers, and what it calls them. The channel screens were
 * written to speak to the workspace server (`/api/agent/channels/...`); the chat service has the same
 * things under `/v1`, so those calls are sent there without each screen knowing. What belongs to the
 * agent (a channel's tasks, its threads with the agent, its working folder) stays with the workspace
 * server. A path that starts with `/chat/` is the chat service's own and goes there as it is.
 */
const CHANNEL_PARTS = /^(members|managers|archive|mentionable|read|messages|since|threads|files)$/;
// A channel's threads and files in the chat service are its people's; the workspace server's (the
// agent's) have other names: `/threads` and `/files` with an `agent` prefix, below.

/** The chat service's path for a call the app makes, or null if the call is not the chat service's. */
export function chatPathOf(path: string): string | null {
  if (path.startsWith("/chat/")) return path.slice("/chat".length);
  const at = path.indexOf("?");
  const pathname = at === -1 ? path : path.slice(0, at);
  const query = at === -1 ? "" : path.slice(at);
  const part = pathname.split("/");
  // ["", "api", "agent", "channels", id, rest]
  if (part[1] !== "api" || part[2] !== "agent") return null;
  const to = (rest: string) => `${rest}${query}`;
  if (part[3] === "channels") {
    if (part.length === 4) return to("/v1/channels");
    if (part.length === 5) return to(`/v1/channels/${part[4]}`);
    // `/channels/:id/members` and the others the chat service has; tasks, the agent's threads and its
    // folder are not among them.
    if (
      part.length === 6 &&
      CHANNEL_PARTS.test(part[5] ?? "") &&
      part[5] !== "threads" &&
      part[5] !== "files"
    )
      return to(`/v1/channels/${part[4]}/${part[5]}`);
    return null;
  }
  if (part[3] === "admin" && part[4] === "channels")
    return to(
      `/v1/admin/channels${part
        .slice(5)
        .map((p) => `/${p}`)
        .join("")}`,
    );
  if (part[3] === "dms" && part.length <= 5) return to(`/v1/dms${part[4] ? `/${part[4]}` : ""}`);
  if (part[3] === "notification-prefs" && part.length === 4) return to("/v1/notification-prefs");
  return null;
}
