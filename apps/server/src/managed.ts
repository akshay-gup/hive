import {
  verifyRevocation,
  verifyWorkspaceToken,
  type WorkspaceRole,
  WorkspaceTokenError,
} from "../../../packages/integrations/src/workspace-token.ts";
import type { Auth } from "./auth.ts";
import type { ManagedWorkspace } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

/**
 * How long a managed workspace keeps someone signed in. The control plane decides who belongs, so
 * a person it removes loses access within this time: the app signs in again, through the control
 * plane, before it runs out.
 */
export const MANAGED_SESSION_MS = 60 * 60 * 1000;

interface HiveUser {
  id: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  createdAt: string;
  lastLoginAt: string;
}

/**
 * Sign-in for a workspace the control plane runs: the person arrives with a token the control
 * plane signed for this workspace, and leaves with the workspace's own session, as after any
 * other sign-in.
 */
export class ManagedSignIn {
  /** Tokens already used, until they would have expired anyway: one token opens one session. */
  private readonly used = new Map<string, number>();
  constructor(
    private readonly db: Store,
    private readonly auth: Auth,
    private readonly managed: ManagedWorkspace,
    /** Gives a person who is new here what a signed-in person has (their orchestrator chat). */
    private readonly welcome: (owner: string, role: WorkspaceRole) => Promise<unknown> | undefined,
  ) {}

  async signIn(token: string) {
    let verified: ReturnType<typeof verifyWorkspaceToken>;
    try {
      verified = verifyWorkspaceToken(this.managed.controlPublicKey, token, {
        workspaceId: this.managed.workspaceId,
      });
    } catch (error) {
      if (error instanceof WorkspaceTokenError) throw new AppError(error.message, 401);
      throw error;
    }
    const now = Date.now();
    for (const [id, expiresAt] of this.used) if (expiresAt < now) this.used.delete(id);
    if (this.used.has(verified.id))
      throw new AppError("This sign-in was already used. Try again.", 401);
    this.used.set(verified.id, verified.expiresAt);

    const owner = `acct:${verified.sub}`;
    const existing = await this.db.get<HiveUser>("system", "users", owner);
    const at = new Date(now).toISOString();
    await this.db.put<HiveUser>("system", "users", {
      id: owner,
      email: verified.email,
      name: verified.name || verified.email,
      role: verified.role,
      createdAt: existing?.createdAt ?? at,
      lastLoginAt: at,
    });
    await this.welcome(owner, verified.role);
    const session = await this.auth.sessionForOwner(owner, MANAGED_SESSION_MS);
    return {
      ...session,
      // So the app can sign in again, through the control plane, before the session runs out.
      expiresAt: now + MANAGED_SESSION_MS,
      user: { id: owner, email: verified.email, name: verified.name, role: verified.role },
    };
  }

  /**
   * The control plane says a person's sessions here are over: they were removed, or their role changed
   * and what they were signed in as is no longer so. The app signs them in again, through the control
   * plane, which either refuses or says what they are now.
   */
  async revoke(token: string): Promise<{ ended: number }> {
    let sub: string;
    try {
      sub = verifyRevocation(this.managed.controlPublicKey, token, {
        workspaceId: this.managed.workspaceId,
      });
    } catch (error) {
      if (error instanceof WorkspaceTokenError) throw new AppError(error.message, 401);
      throw error;
    }
    return { ended: await this.auth.endSessions(`acct:${sub}`) };
  }
}
