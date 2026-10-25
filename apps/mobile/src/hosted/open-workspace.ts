import {
  type ChatToken,
  type ControlApi,
  isControlError,
  type Role,
  type WorkspaceSummary,
} from "./control-api.ts";

export interface WorkspaceUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** A workspace the person is signed in to: where it is, and the session it gave them. */
export interface OpenedWorkspace {
  workspace: WorkspaceSummary;
  /** The workspace's own API, with no trailing slash. */
  url: string;
  token: string;
  /** When the session ends (milliseconds since 1970); sign in again before then. */
  expiresAt: number;
  user: WorkspaceUser;
  /** The chat service, where there is one: what people say in channels goes through it. */
  chat?: ChatToken;
}

/** Why a workspace could not be opened, in words fit for the person. */
export class WorkspaceUnavailable extends Error {
  constructor(
    message: string,
    readonly reason: "not-ready" | "failed" | "gone" | "unreachable",
  ) {
    super(message);
    this.name = "WorkspaceUnavailable";
  }
}

type Fetcher = typeof fetch;
export interface OpenOptions {
  /** Start the workspace's machine first, in case it was stopped to save money. On unless false. */
  wake?: boolean;
  onStep?: (step: "waking" | "signing-in") => void;
  fetcher?: Fetcher;
}

/** Sign in to a workspace: the control plane vouches for the person, and the workspace gives its own session. */
export async function openWorkspace(
  control: ControlApi,
  id: string,
  options: OpenOptions = {},
): Promise<OpenedWorkspace> {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  let workspace: WorkspaceSummary;
  try {
    workspace = await control.workspace(id);
  } catch (error) {
    if (isControlError(error) && error.status === 404)
      throw new WorkspaceUnavailable("You no longer have access to this workspace.", "gone");
    throw error;
  }
  if (workspace.status === "provisioning")
    throw new WorkspaceUnavailable("This workspace is still being set up.", "not-ready");
  if (workspace.status !== "ready")
    throw new WorkspaceUnavailable(
      workspace.error ?? "This workspace could not be started.",
      "failed",
    );
  if (options.wake !== false) {
    options.onStep?.("waking");
    await control.wake(id);
  }
  options.onStep?.("signing-in");
  // Chat has its own token. A control plane with no chat service says so, and the workspace goes without.
  const chat = await control.chatToken(id).catch((error) => {
    if (isControlError(error) && error.status === 404) return undefined;
    throw error;
  });
  // A token opens one session, so an attempt that failed on the way is made again with a new one.
  for (let attempt = 0; ; attempt++) {
    const minted = await control.workspaceToken(id);
    const url = minted.url.replace(/\/+$/, "");
    let response: Response;
    try {
      response = await fetcher(`${url}/api/auth/managed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: minted.token }),
      });
    } catch {
      throw new WorkspaceUnavailable(
        "Could not reach the workspace. Check your connection and try again.",
        "unreachable",
      );
    }
    const payload = (await response.json().catch(() => ({}))) as {
      token?: string;
      expiresAt?: number;
      user?: WorkspaceUser;
      error?: string;
    };
    if (response.ok && payload.token && payload.user)
      return {
        workspace,
        url,
        token: payload.token,
        expiresAt: payload.expiresAt ?? Date.now() + 50 * 60 * 1000,
        user: payload.user,
        chat,
      };
    if (response.status === 401 && attempt === 0) continue;
    throw new WorkspaceUnavailable(
      response.status === 401
        ? "The workspace would not sign you in. Try again."
        : (payload.error ?? `The workspace answered with an error (${response.status}).`),
      "unreachable",
    );
  }
}

/** How long before a session ends to sign in again, so that nothing a person does meets the end of it. */
export const RENEW_MARGIN_MS = 5 * 60 * 1000;

/** True once a session has little enough time left that it should be renewed. */
export function shouldRenew(opened: Pick<OpenedWorkspace, "expiresAt">, now = Date.now()) {
  return opened.expiresAt - now <= RENEW_MARGIN_MS;
}

/** A new session in the same workspace, without waking it: the person is already using it. */
export function renewSession(control: ControlApi, opened: OpenedWorkspace, fetcher?: Fetcher) {
  return openWorkspace(control, opened.workspace.id, { wake: false, fetcher });
}
