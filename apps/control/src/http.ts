import { ProvisionError } from "./provisioner.ts";

/** What every provisioner needs of the network: calls that survive a busy service, and waiting for a workspace to answer. */

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const REQUEST_MS = 30_000;
const ATTEMPTS = 4;
/** However long a service asks us to wait, we wait no longer than this before trying again. */
const LONGEST_WAIT_SECONDS = 10;

/** How long a service asks to be left alone: its `Retry-After`, or the time until its `RateLimit-Reset` (a Unix time). */
function askedToWait(response: Response): number | undefined {
  const after = Number(response.headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return after;
  const reset = Number(response.headers.get("ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const seconds = reset - Date.now() / 1000;
    if (seconds > 0) return seconds;
  }
  return undefined;
}

/**
 * One request, tried again when the service is busy (429) or has a bad moment (5xx), or the network
 * drops it, with a pause that doubles each time (`retryMs` to start). The last answer is returned
 * whatever it is, so the caller says what went wrong.
 */
export async function retryingFetch(
  url: string,
  init: RequestInit,
  retryMs = 500,
): Promise<Response> {
  let last: Response | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const final = attempt === ATTEMPTS - 1;
    try {
      last = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS) });
      if (last.status !== 429 && last.status < 500) return last;
      if (final) break;
      const asked = askedToWait(last);
      await sleep(
        asked !== undefined ? Math.min(asked, LONGEST_WAIT_SECONDS) * 1000 : retryMs * 2 ** attempt,
      );
    } catch (error) {
      if (final) throw error;
      await sleep(retryMs * 2 ** attempt);
    }
  }
  return last as Response;
}

/**
 * Ask a workspace's own health check, through its public address, until it answers as the right
 * workspace: the machine is up, what answers is this workspace and not another, it is on the build it is to
 * run (a machine that has not taken up its update would be answering, but without what the update brings),
 * and its agent has connected to the chat service. The last is waited for a little while and then let go:
 * a chat service that cannot be reached must not keep anyone from their workspace.
 */
export async function waitUntilAnswering(
  url: string,
  workspaceId: string,
  options: { waitSeconds: number; pollMs?: number; build?: string; agentSeconds?: number },
): Promise<void> {
  const until = Date.now() + options.waitSeconds * 1000;
  let last = "no answer";
  let agentUntil = 0;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const health = (await response.json()) as {
          ok?: boolean;
          workspace?: string;
          version?: string;
          update?: { state?: string };
          chatRunner?: { connected?: boolean };
        };
        if (!health.ok || health.workspace !== workspaceId)
          last = "answered, but as a different workspace";
        else if (
          options.build &&
          health.version !== options.build &&
          // An update that failed is not going to finish: the workspace is let in on the build it has.
          health.update?.state !== "failed"
        )
          last = `still on ${health.version ?? "an unknown build"}, updating to ${options.build}`;
        else if (!health.chatRunner || health.chatRunner.connected) return;
        else {
          agentUntil ||= Date.now() + (options.agentSeconds ?? 60) * 1000;
          if (Date.now() >= agentUntil) return;
          last = "its agent has not connected yet";
        }
      } else last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(options.pollMs ?? 2000);
  }
  throw new ProvisionError(
    `${url} did not answer in ${options.waitSeconds}s (${last})`,
    "The workspace started but is not answering yet. Try again in a minute.",
  );
}
