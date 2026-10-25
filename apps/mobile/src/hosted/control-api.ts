export type Role = "owner" | "admin" | "member" | "guest";
/** What a person can be invited, or made, as: the owner is whoever made the workspace. */
export type InvitedRole = "admin" | "member" | "guest";
export type WorkspaceStatus = "provisioning" | "ready" | "failed" | "deleting";

export interface ControlAccount {
  id: string;
  email: string;
  name: string;
}
/** How far making a workspace has got, as the control plane reports it. */
export type MakingStepName = "address" | "machine" | "starting" | "checking";
export interface WorkspaceSummary {
  id: string;
  name: string;
  status: WorkspaceStatus;
  role: Role;
  /** Where the apps reach it; only once it is ready. */
  url?: string;
  error?: string;
  /** While it is being made, the step it is on, if the control plane says. */
  step?: MakingStepName;
  createdAt: string;
}
export interface Member {
  accountId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}
export interface InviteSummary {
  id: string;
  role: InvitedRole;
  email?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: number;
  maxUses: number;
  uses: number;
}
export interface InvitePreview {
  workspaceName: string;
  inviterName: string;
  role: string;
  email?: string;
}
export interface WorkspaceToken {
  token: string;
  url: string;
  expiresAt: number;
}
/** A token for the chat service, and where it is reached for this workspace. */
export interface ChatToken {
  token: string;
  url: string;
  wsUrl: string;
  expiresAt: number;
}

/** A refusal from the control plane, with words that are fit to show; `status` 0 means it could not be reached. */
export class ControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

/** True for a refusal from the control plane, whichever copy of this module made it. */
export const isControlError = (error: unknown): error is ControlError =>
  error instanceof Error && error.name === "ControlError";

type Fetcher = typeof fetch;

/**
 * The Hive control plane, as the app uses it: who you are, which workspaces are yours, and the
 * invitations to them. It holds the person's session; a refusal of that session (401) is reported
 * through `onSignedOut`, so whatever is on screen can give way to signing in.
 */
export class ControlApi {
  readonly baseUrl: string;
  onSignedOut?: () => void;
  constructor(
    baseUrl: string,
    public token = "",
    private readonly fetcher: Fetcher = (input, init) => fetch(input, init),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ControlError("Could not reach Hive. Check your connection and try again.", 0);
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (!response.ok) {
      if (response.status === 401 && this.token) this.onSignedOut?.();
      throw new ControlError(
        typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`,
        response.status,
      );
    }
    return payload as T;
  }

  /** Which ways in this control plane has: public, so the app can offer them before anyone signs in. */
  health() {
    return this.call<{ ok: boolean; mode: "sample" | "live"; google: boolean }>("GET", "/health");
  }

  // Signing in. The control plane gives a session once a person has proved who they are.

  /** A sample control plane signs anyone in by email address; a live one refuses. */
  async signInByEmail(email: string, name?: string) {
    const session = await this.call<{ token: string; account: ControlAccount }>(
      "POST",
      "/v1/auth/dev",
      { email, name: name || undefined },
    );
    this.token = session.token;
    return session.account;
  }
  /** Where to send the person to sign in with Google. `origin` is the web page that opens it. */
  googleUrl(origin?: string) {
    const query = origin ? `?origin=${encodeURIComponent(origin)}` : "";
    return this.call<{ url: string }>("GET", `/v1/auth/google/url${query}`);
  }
  /** Trade the single-use code Google's sign-in ends with for a session. */
  async exchangeLoginCode(code: string) {
    const session = await this.call<{ token: string; account: ControlAccount }>(
      "POST",
      "/v1/auth/exchange",
      { code },
    );
    this.token = session.token;
    return session.account;
  }
  async signOut() {
    try {
      if (this.token) await this.call("POST", "/v1/auth/logout", {});
    } finally {
      this.token = "";
    }
  }
  me() {
    return this.call<{ account: ControlAccount; workspaces: WorkspaceSummary[] }>("GET", "/v1/me");
  }

  // Workspaces

  createWorkspace(name: string) {
    return this.call<WorkspaceSummary>("POST", "/v1/workspaces", { name });
  }
  workspace(id: string) {
    return this.call<WorkspaceSummary>("GET", `/v1/workspaces/${encodeURIComponent(id)}`);
  }
  /** Start the workspace's machine if it was stopped to save money; resolves once it answers. */
  wake(id: string) {
    return this.call<{ state: string }>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(id)}/wake`,
      {},
    );
  }
  retry(id: string) {
    return this.call<WorkspaceSummary>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(id)}/retry`,
      {},
    );
  }
  async deleteWorkspace(id: string) {
    await this.call("DELETE", `/v1/workspaces/${encodeURIComponent(id)}`);
  }
  /**
   * Delete the account, and with it every session. The control plane says no, with a 409 and why,
   * to an owner who still has a workspace: they delete that first.
   */
  async deleteAccount() {
    await this.call("DELETE", "/v1/account");
    this.token = "";
  }
  /** A short-lived token to take to the workspace, which signs the person in with it. */
  workspaceToken(id: string) {
    return this.call<WorkspaceToken>("POST", `/v1/workspaces/${encodeURIComponent(id)}/token`, {});
  }

  /** A token for the workspace's chat, which does not need its machine to be running. */
  chatToken(id: string) {
    return this.call<ChatToken>("POST", `/v1/workspaces/${encodeURIComponent(id)}/chat-token`, {});
  }

  // People

  members(id: string) {
    return this.call<Member[]>("GET", `/v1/workspaces/${encodeURIComponent(id)}/members`);
  }
  async setRole(id: string, accountId: string, role: InvitedRole) {
    await this.call(
      "PATCH",
      `/v1/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(accountId)}`,
      { role },
    );
  }
  /** Remove a person, or leave, when `accountId` is your own. */
  async removeMember(id: string, accountId: string) {
    await this.call(
      "DELETE",
      `/v1/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(accountId)}`,
    );
  }
  invites(id: string) {
    return this.call<InviteSummary[]>("GET", `/v1/workspaces/${encodeURIComponent(id)}/invites`);
  }
  /** A link anyone can join with, or an invitation for one email address, which is also sent to it. */
  createInvite(id: string, input: { email?: string; role?: InvitedRole } = {}) {
    return this.call<{ invite: InviteSummary; link: string }>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(id)}/invites`,
      input,
    );
  }
  async revokeInvite(id: string, inviteId: string) {
    await this.call(
      "DELETE",
      `/v1/workspaces/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}`,
    );
  }
  /** What an invitation link is for; public, so it can be shown before anyone signs in. */
  previewInvite(token: string) {
    return this.call<InvitePreview>("GET", `/v1/invites/${encodeURIComponent(token)}`);
  }
  acceptInvite(token: string) {
    return this.call<WorkspaceSummary>(
      "POST",
      `/v1/invites/${encodeURIComponent(token)}/accept`,
      {},
    );
  }

  /**
   * Wait while a workspace is being made. Resolves with it once it is ready or has failed, and
   * says how far it got along the way. `signal` ends the wait without an error.
   */
  async untilSettled(
    id: string,
    options: {
      signal?: AbortSignal;
      intervalMs?: number;
      timeoutMs?: number;
      onUpdate?: (workspace: WorkspaceSummary) => void;
    } = {},
  ): Promise<WorkspaceSummary | null> {
    const until = Date.now() + (options.timeoutMs ?? 10 * 60 * 1000);
    for (;;) {
      const workspace = await this.workspace(id);
      options.onUpdate?.(workspace);
      if (workspace.status !== "provisioning") return workspace;
      if (options.signal?.aborted) return null;
      if (Date.now() > until)
        throw new ControlError("Setting up your workspace is taking longer than expected.", 0);
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1500));
      if (options.signal?.aborted) return null;
    }
  }
}
