import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  DEFAULT_TOKEN_SECONDS,
  signRevocation,
  signWorkspaceToken,
  type WorkspaceRole,
} from "../../../packages/integrations/src/workspace-token.ts";
import { type Account, type Accounts, accountIdFor, HOME } from "./accounts.ts";
import { HttpError } from "./errors.ts";
import type { Mailer } from "./mailer.ts";
import { DEFAULT_PLAN, type PlanId, plans } from "./plans.ts";
import {
  type MachineState,
  ProvisionError,
  type Provisioner,
  type ProvisionProgress,
  type ProvisionStep,
  provisionSteps,
} from "./provisioner.ts";
import type { SigningKeys } from "./signing.ts";
import type { ControlStore } from "./store.ts";

export type WorkspaceStatus = "provisioning" | "ready" | "failed" | "deleting";

interface WorkspaceRecord {
  id: string;
  name: string;
  plan: PlanId;
  status: WorkspaceStatus;
  url?: string;
  error?: string;
  /** How far making it has got, while it is being made. */
  step?: ProvisionStep;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Until when one copy of the control plane has the right to make this workspace (a time in
   * milliseconds; 0 for no one). Several copies may find it unfinished at once, and only the one
   * that holds this makes it.
   */
  leaseUntil?: number;
}
/** What a person can be invited as: the owner is the one who made the workspace. */
export type InvitedRole = "admin" | "member" | "guest";
interface MemberRecord {
  id: string;
  workspaceId: string;
  accountId: string;
  role: WorkspaceRole;
  joinedAt: string;
  invitedBy?: string;
}
interface InviteRecord {
  /** The digest of the token, so the token itself is only ever in the link. */
  id: string;
  workspaceId: string;
  role: InvitedRole;
  /** When set, only the person with this email can use it. */
  email?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: number;
  maxUses: number;
  uses: number;
  revokedAt?: string;
}

/** What a person is shown of a workspace they belong to. */
export interface WorkspaceView {
  id: string;
  name: string;
  status: WorkspaceStatus;
  role: WorkspaceRole;
  /** Where the apps reach it; only once it is ready. */
  url?: string;
  error?: string;
  /** How far making it has got, while it is being made, if the provider says. */
  step?: ProvisionStep;
  createdAt: string;
}
export interface MemberView {
  accountId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: string;
}
export interface InviteView {
  id: string;
  role: InvitedRole;
  email?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: number;
  maxUses: number;
  uses: number;
}

const INVITE_DAYS = 7;
/** Longer than making a workspace can take, so a copy that is still at it is not taken over; a copy that died is, after this. */
const LEASE_MS = 20 * 60 * 1000;
const LINK_INVITE_USES = 50;
/** How long a workspace the provider has no room for is tried again (each minute) before it is said to have failed. */
const CAPACITY_WAIT_MS = 15 * 60 * 1000;
// No look-alikes (0/o, 1/l/i), so an id read aloud or off a screen is not misheard.
const ID_ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const newWorkspaceId = () =>
  `w${Array.from({ length: 10 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("")}`;
const manages = (role: WorkspaceRole) => role === "owner" || role === "admin";
const hasControlCharacter = (text: string) =>
  [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });

export interface WorkspaceServiceOptions {
  db: ControlStore;
  accounts: Accounts;
  provisioner: Provisioner;
  mailer: Mailer;
  keys: SigningKeys;
  /** The control plane's address, which workspaces allow. */
  publicUrl: string;
  /** Where the web app is opened, which invite links are made from. The control plane's own address when it serves the app. */
  appUrl?: string;
  allowedOrigins: string[];
  maxWorkspacesPerAccount: number;
  /** The model settings a new workspace is given: its model, and the address and key to reach it by. */
  modelEnvironment?: (workspaceId: string) => Record<string, string>;
  /**
   * Where making a workspace is started. Left out, it is done in this process, which is right for
   * one long-running server. Somewhere that cannot keep work going after a request (a Worker), it
   * hands the id to a workflow or queue, which calls `provisionNow`.
   */
  startProvisioning?: (workspaceId: string) => void | Promise<void>;
  /** For tests: the `fetch` that reaches a workspace. */
  fetch?: typeof fetch;
}

/** Workspaces, who belongs to them, and getting them running. */
export class WorkspaceService {
  private readonly jobs = new Map<string, Promise<void>>();
  constructor(private readonly options: WorkspaceServiceOptions) {}
  private get db() {
    return this.options.db;
  }

  // Workspaces

  async create(account: Account, rawName: string): Promise<WorkspaceView> {
    const name = rawName.trim();
    if (!name || name.length > 60 || hasControlCharacter(name))
      throw new HttpError("Give the workspace a name of up to 60 characters", 422);
    if ((await this.workspacesOf(account)).length >= this.options.maxWorkspacesPerAccount)
      throw this.limitReached();
    const now = new Date().toISOString();
    let record: WorkspaceRecord | null = null;
    for (let attempt = 0; attempt < 5 && !record; attempt++)
      record = await this.db.insertIfAbsent<WorkspaceRecord>(HOME, "workspaces", {
        id: newWorkspaceId(),
        name,
        plan: DEFAULT_PLAN,
        status: "provisioning",
        createdBy: account.id,
        createdAt: now,
        updatedAt: now,
        leaseUntil: 0,
      });
    if (!record) throw new HttpError("Could not make a workspace. Try again.", 503);
    await this.db.put<MemberRecord>(HOME, "members", {
      id: `${record.id}:${account.id}`,
      workspaceId: record.id,
      accountId: account.id,
      role: "owner",
      joinedAt: now,
    });
    await this.begin(record.id);
    return this.toView(record, "owner");
  }

  async list(account: Account): Promise<WorkspaceView[]> {
    const memberships = await this.db.listWhere<MemberRecord>(
      HOME,
      "members",
      "accountId",
      account.id,
    );
    const views: WorkspaceView[] = [];
    for (const member of memberships) {
      const record = await this.db.get<WorkspaceRecord>(HOME, "workspaces", member.workspaceId);
      if (record && record.status !== "deleting") views.push(this.toView(record, member.role));
    }
    return views.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async view(account: Account, id: string): Promise<WorkspaceView> {
    const { record, member } = await this.require(account, id);
    return this.toView(record, member.role);
  }

  /**
   * A token the app takes to the workspace to sign in. This is where belonging is enforced: a
   * person who has been removed cannot get another, and their last session ends within the hour.
   */
  async token(
    account: Account,
    id: string,
  ): Promise<{ token: string; url: string; expiresAt: number }> {
    const { record, member } = await this.require(account, id);
    if (record.status !== "ready" || !record.url)
      throw new HttpError("This workspace is not ready yet", 409);
    const token = signWorkspaceToken(this.options.keys.privateKey, {
      workspaceId: id,
      sub: account.id,
      email: account.email,
      name: account.name,
      role: member.role,
    });
    return { token, url: record.url, expiresAt: Date.now() + DEFAULT_TOKEN_SECONDS * 1000 };
  }

  /**
   * Where the edge connects to reach a workspace. A name nobody has made is answered from the
   * records, so asking for one costs the host nothing, and so is one that failed or is being
   * removed. One being made is looked for, because making it ends when it answers at its public
   * address, which is through the edge. One that is made but not running (it was stopped) has no
   * address.
   */
  async upstream(id: string): Promise<{ known: boolean; upstream: string | null }> {
    const record = await this.db.get<WorkspaceRecord>(HOME, "workspaces", id);
    if (record?.status !== "ready" && record?.status !== "provisioning")
      return { known: false, upstream: null };
    return { known: true, upstream: (await this.options.provisioner.upstream?.(id)) ?? null };
  }

  /** Start the workspace's machine if it was stopped to save money. */
  async wake(account: Account, id: string): Promise<{ state: MachineState }> {
    const { record } = await this.require(account, id);
    if (record.status !== "ready") throw new HttpError("This workspace is not ready yet", 409);
    await this.options.provisioner.wake(id);
    return { state: await this.options.provisioner.state(id) };
  }

  async retry(account: Account, id: string): Promise<WorkspaceView> {
    const { record, member } = await this.require(account, id);
    if (member.role !== "owner") throw new HttpError("Only the owner can do that", 403);
    if (record.status !== "failed") throw new HttpError("This workspace did not fail", 409);
    const moved = await this.db.compareAndSwap<WorkspaceRecord>(
      HOME,
      "workspaces",
      id,
      { status: "failed" },
      { status: "provisioning", error: null, step: null, updatedAt: new Date().toISOString() },
    );
    await this.begin(id);
    return this.toView(moved ?? record, member.role);
  }

  async remove(account: Account, id: string): Promise<void> {
    const { member } = await this.require(account, id);
    if (member.role !== "owner") throw new HttpError("Only the owner can delete a workspace", 403);
    await this.db.compareAndSwap(HOME, "workspaces", id, {}, { status: "deleting" });
    try {
      await this.finishRemoval(id);
    } catch (error) {
      // It stays on its way out, and `resume` finishes the job.
      console.error(`[Hive control] could not remove ${id}: ${this.describe(error)}`);
      throw new HttpError("We could not remove the workspace's servers. Try again.", 502);
    }
  }

  /** Take a workspace that is going away off its servers, then out of the records. */
  private async finishRemoval(id: string): Promise<void> {
    await this.jobs.get(id);
    // Another copy may still be making it. Let that end first, or the machine it is about to start would be left behind.
    const record = await this.db.get<WorkspaceRecord>(HOME, "workspaces", id);
    if (record && (record.leaseUntil ?? 0) > Date.now()) return;
    await this.options.provisioner.destroy(id);
    for (const m of await this.db.listWhere<MemberRecord>(HOME, "members", "workspaceId", id))
      await this.db.remove(HOME, "members", m.id);
    for (const i of await this.db.listWhere<InviteRecord>(HOME, "invites", "workspaceId", id))
      await this.db.remove(HOME, "invites", i.id);
    await this.db.remove(HOME, "workspaces", id);
  }

  /** Pick up what a restart (or a failed removal) left half done: workspaces being made, and ones being removed. */
  async resume(): Promise<void> {
    // The provider's own upkeep first, so that what it unlocks (the image in another region) is there for what follows.
    try {
      await this.options.provisioner.maintain?.();
    } catch (error) {
      console.error(`[Hive control] provider upkeep failed: ${this.describe(error)}`);
    }
    // Only the unfinished ones are asked for, so this stays cheap however many workspaces there are.
    for (const value of await this.db.listWhere<WorkspaceRecord>(
      HOME,
      "workspaces",
      "status",
      "provisioning",
    ))
      if ((value.leaseUntil ?? 0) <= Date.now()) await this.begin(value.id);
    for (const value of await this.db.listWhere<WorkspaceRecord>(
      HOME,
      "workspaces",
      "status",
      "deleting",
    ))
      await this.finishRemoval(value.id).catch((error) =>
        console.error(`[Hive control] could not remove ${value.id}: ${this.describe(error)}`),
      );
  }

  /** Resolves when the work now under way for a workspace is done. */
  async settled(id: string): Promise<void> {
    await this.jobs.get(id);
  }

  /** Start making a workspace, here or wherever `startProvisioning` sends it. A failure to start is for `resume` to retry. */
  private async begin(id: string): Promise<void> {
    const start = this.options.startProvisioning;
    if (!start) {
      void this.provision(id);
      return;
    }
    try {
      await start(id);
    } catch (error) {
      console.error(`[Hive control] could not start making ${id}: ${this.describe(error)}`);
    }
  }

  /** Make the workspace now, if no other copy is making it, and resolve when that is done. For whatever `startProvisioning` hands the id to. */
  provisionNow(id: string): Promise<void> {
    return this.provision(id);
  }

  /** Take the right to make a workspace: of several copies that find it unfinished, one gets it. */
  private async claim(id: string): Promise<WorkspaceRecord | null> {
    const record = await this.db.get<WorkspaceRecord>(HOME, "workspaces", id);
    if (record?.status !== "provisioning" || (record.leaseUntil ?? 0) > Date.now()) return null;
    // Whoever changes the lease from the value both read wins; the other finds it moved. (A record
    // from before leases has no value to compare, so it can be claimed by more than one: making a
    // workspace can be repeated, and none are left like that.)
    return this.db.compareAndSwap<WorkspaceRecord>(
      HOME,
      "workspaces",
      id,
      {
        status: "provisioning",
        ...(record.leaseUntil === undefined ? {} : { leaseUntil: record.leaseUntil }),
      },
      { leaseUntil: Date.now() + LEASE_MS },
    );
  }

  private provision(id: string): Promise<void> {
    const running = this.jobs.get(id);
    if (running) return running;
    const job = (async () => {
      let lease: number | undefined;
      let since = 0;
      try {
        const claimed = await this.claim(id);
        if (!claimed) return;
        lease = claimed.leaseUntil;
        since = Date.parse(claimed.updatedAt);
        // The step the person sees. One write after another, so a slow one cannot land after the
        // step that follows it, and none after the workspace is ready.
        let steps: Promise<unknown> = Promise.resolve();
        const progress: ProvisionProgress = (step) => {
          steps = steps
            .then(() =>
              this.db.compareAndSwap(HOME, "workspaces", id, { status: "provisioning" }, { step }),
            )
            // Telling the person how it is going is never worth failing the workspace over.
            .catch(() => {});
        };
        const { url } = await this.options.provisioner.create(
          {
            workspaceId: id,
            name: claimed.name,
            plan: plans[claimed.plan],
            controlPublicKey: this.options.keys.publicKey,
            allowedOrigins: [
              new URL(this.options.publicUrl).origin,
              ...this.options.allowedOrigins,
            ],
            updateUrl: `${this.options.publicUrl}/v1/release/${id}`,
            ...(this.options.modelEnvironment
              ? { modelEnv: this.options.modelEnvironment(id) }
              : {}),
          },
          progress,
        );
        await steps;
        await this.db.compareAndSwap(
          HOME,
          "workspaces",
          id,
          { status: "provisioning" },
          { status: "ready", url, step: null, leaseUntil: 0, updatedAt: new Date().toISOString() },
        );
      } catch (error) {
        // No room at the provider is not a failure yet: the lease is let go below, and the timer
        // starts it again each minute, until it has waited long enough.
        const waiting =
          error instanceof ProvisionError &&
          error.capacity &&
          Date.now() - since < CAPACITY_WAIT_MS;
        console.error(
          waiting
            ? `[Hive control] no room for ${id} yet, trying again: ${this.describe(error)}`
            : `[Hive control] could not start ${id}: ${this.describe(error)}`,
        );
        // Only a copy that had the workspace says it failed; one that never got it has nothing to say.
        if (lease !== undefined && !waiting)
          await this.db.compareAndSwap(
            HOME,
            "workspaces",
            id,
            { status: "provisioning" },
            {
              status: "failed",
              step: null,
              leaseUntil: 0,
              error:
                error instanceof ProvisionError
                  ? error.userMessage
                  : "We could not start this workspace. Try again in a minute.",
              updatedAt: new Date().toISOString(),
            },
          );
      } finally {
        // Let go of the lease however it went (a workspace being removed meanwhile never reaches the lines above).
        if (lease !== undefined)
          await this.db.compareAndSwap(
            HOME,
            "workspaces",
            id,
            { leaseUntil: lease },
            { leaseUntil: 0 },
          );
      }
    })()
      .catch((error) =>
        console.error(
          `[Hive control] could not record the outcome for ${id}: ${this.describe(error)}`,
        ),
      )
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }

  // Members

  async members(account: Account, id: string): Promise<MemberView[]> {
    const { member } = await this.require(account, id);
    const rows = (await this.db.listWhere<MemberRecord>(HOME, "members", "workspaceId", id)).filter(
      // A guest is shown who they are here, not who else is.
      (row) => member.role !== "guest" || row.accountId === account.id,
    );
    const views: MemberView[] = [];
    for (const row of rows) {
      const person = await this.options.accounts.get(row.accountId);
      if (person)
        views.push({
          accountId: person.id,
          name: person.name,
          email: person.email,
          role: row.role,
          joinedAt: row.joinedAt,
        });
    }
    const rank: Record<WorkspaceRole, number> = { owner: 0, admin: 1, member: 2, guest: 3 };
    return views.sort((a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name));
  }

  async setRole(account: Account, id: string, targetId: string, role: InvitedRole): Promise<void> {
    const { member } = await this.require(account, id);
    if (member.role !== "owner") throw new HttpError("Only the owner can change roles", 403);
    const target = await this.db.get<MemberRecord>(HOME, "members", `${id}:${targetId}`);
    if (!target) throw new HttpError("That person is not in this workspace", 404);
    if (target.role === "owner") throw new HttpError("The owner's role cannot change", 409);
    await this.db.compareAndSwap(HOME, "members", target.id, {}, { role });
    await this.endSessions(id, targetId);
  }

  /**
   * Tell a workspace that a person's sessions there are over, so that being removed, or having a new
   * role, takes hold now and not when the hour of their session is up. The app is signed in again
   * through this control plane, which refuses a person who is gone and says what a person now is.
   * Best effort: a workspace that is stopped or slow keeps the session until it runs out.
   */
  private async endSessions(workspaceId: string, accountId: string): Promise<void> {
    const record = await this.db.get<WorkspaceRecord>(HOME, "workspaces", workspaceId);
    if (record?.status !== "ready" || !record.url) return;
    const token = signRevocation(this.options.keys.privateKey, { workspaceId, sub: accountId });
    try {
      await (this.options.fetch ?? fetch)(`${record.url.replace(/\/+$/, "")}/api/auth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(4000),
      });
    } catch (error) {
      console.error(
        `[Hive control] could not end ${accountId}'s sessions in ${workspaceId}: ${this.describe(error)}`,
      );
    }
  }

  /** Remove someone, or leave: the owner can remove anyone, an admin members, and anyone can leave but the owner. */
  async removeMember(account: Account, id: string, targetId: string): Promise<void> {
    const { member } = await this.require(account, id);
    const target = await this.db.get<MemberRecord>(HOME, "members", `${id}:${targetId}`);
    if (!target) throw new HttpError("That person is not in this workspace", 404);
    if (target.role === "owner")
      throw new HttpError("The owner cannot leave. Delete the workspace instead.", 409);
    const leaving = targetId === account.id;
    const allowed =
      leaving ||
      member.role === "owner" ||
      (member.role === "admin" && (target.role === "member" || target.role === "guest"));
    if (!allowed) throw new HttpError("You cannot remove that person", 403);
    await this.db.remove(HOME, "members", target.id);
    await this.endSessions(id, targetId);
  }

  /**
   * Take a person out of every workspace, and away from every invitation they sent or were sent,
   * ahead of deleting their account. The account id comes from the email address, so a membership
   * left behind would come back to life when the same person signed up again. An owner cannot go
   * first: the workspace would be left with no one to run it, so they delete it themselves.
   */
  async removePerson(account: Account): Promise<void> {
    const memberships = await this.db.listWhere<MemberRecord>(
      HOME,
      "members",
      "accountId",
      account.id,
    );
    for (const member of memberships) {
      if (member.role !== "owner") continue;
      const record = await this.db.get<WorkspaceRecord>(HOME, "workspaces", member.workspaceId);
      const name = record?.name ?? "your workspace";
      throw new HttpError(
        record?.status === "deleting"
          ? `${name} is still being deleted. Try again in a minute.`
          : `You own ${name}. Delete it before you delete your account.`,
        409,
      );
    }
    for (const member of memberships) {
      await this.db.remove(HOME, "members", member.id);
      await this.endSessions(member.workspaceId, account.id);
    }
    const invites = [
      ...(await this.db.listWhere<InviteRecord>(HOME, "invites", "createdBy", account.id)),
      ...(await this.db.listWhere<InviteRecord>(HOME, "invites", "email", account.email)),
    ];
    for (const invite of invites) await this.db.remove(HOME, "invites", invite.id);
  }

  // Invites

  async createInvite(
    account: Account,
    id: string,
    input: { email?: string; role?: InvitedRole },
  ): Promise<{ invite: InviteView; link: string }> {
    const { record, member } = await this.require(account, id);
    if (!manages(member.role)) throw new HttpError("Only an owner or admin can invite people", 403);
    const role = input.role ?? "member";
    if (role === "admin" && member.role !== "owner")
      throw new HttpError("Only the owner can invite an admin", 403);
    const email = input.email?.trim().toLowerCase() || undefined;
    if (email) {
      const existing = await this.db.get<Account>(HOME, "accounts", accountIdFor(email));
      if (existing && (await this.db.get(HOME, "members", `${id}:${existing.id}`)))
        throw new HttpError("That person is already in this workspace", 409);
    }
    const token = randomBytes(24).toString("base64url");
    const now = Date.now();
    const stored: InviteRecord = {
      id: digest(token),
      workspaceId: id,
      role,
      ...(email ? { email } : {}),
      createdBy: account.id,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + INVITE_DAYS * 24 * 60 * 60 * 1000,
      maxUses: email ? 1 : LINK_INVITE_USES,
      uses: 0,
    };
    await this.db.put(HOME, "invites", stored);
    const link = `${this.options.appUrl ?? this.options.publicUrl}/join/${token}`;
    if (email)
      await this.options.mailer
        .sendInvite({ to: email, workspaceName: record.name, inviterName: account.name, link })
        .catch((error) =>
          console.error(`[Hive control] could not send an invitation: ${this.describe(error)}`),
        );
    return { invite: this.toInviteView(stored), link };
  }

  async invites(account: Account, id: string): Promise<InviteView[]> {
    const { member } = await this.require(account, id);
    if (!manages(member.role)) throw new HttpError("Only an owner or admin can see invites", 403);
    const now = Date.now();
    return (await this.db.listWhere<InviteRecord>(HOME, "invites", "workspaceId", id))
      .filter((i) => !i.revokedAt && i.expiresAt > now && i.uses < i.maxUses)
      .map((i) => this.toInviteView(i))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revokeInvite(account: Account, id: string, inviteId: string): Promise<void> {
    const { member } = await this.require(account, id);
    if (!manages(member.role)) throw new HttpError("Only an owner or admin can do that", 403);
    const invite = await this.db.get<InviteRecord>(HOME, "invites", inviteId);
    if (!invite || invite.workspaceId !== id) throw new HttpError("Invite not found", 404);
    await this.db.compareAndSwap(
      HOME,
      "invites",
      inviteId,
      {},
      { revokedAt: new Date().toISOString() },
    );
  }

  /** What a link says, to whoever holds it, before they sign in or accept. */
  async previewInvite(
    token: string,
  ): Promise<{ workspaceName: string; inviterName: string; role: string; email?: string }> {
    const { invite, record } = await this.usableInvite(token);
    const inviter = await this.options.accounts.get(invite.createdBy);
    return {
      workspaceName: record.name,
      inviterName: inviter?.name ?? "Someone",
      role: invite.role,
      ...(invite.email ? { email: invite.email } : {}),
    };
  }

  async acceptInvite(account: Account, token: string): Promise<WorkspaceView> {
    const { invite, record } = await this.usableInvite(token);
    if (invite.email && invite.email !== account.email)
      throw new HttpError(`This invitation is for ${invite.email}`, 403);
    const memberId = `${record.id}:${account.id}`;
    const already = await this.db.get<MemberRecord>(HOME, "members", memberId);
    if (already) return this.toView(record, already.role);
    // Before the use is counted, so a refusal does not spend the link.
    if ((await this.workspacesOf(account)).length >= this.options.maxWorkspacesPerAccount)
      throw this.limitReached();
    // Count the use first, so a link with one use left cannot admit two people.
    let current = invite;
    for (let attempt = 0; ; attempt++) {
      const counted = await this.db.compareAndSwap<InviteRecord>(
        HOME,
        "invites",
        invite.id,
        { uses: current.uses },
        { uses: current.uses + 1 },
      );
      if (counted) break;
      const fresh = await this.db.get<InviteRecord>(HOME, "invites", invite.id);
      if (!fresh || fresh.uses >= fresh.maxUses || attempt >= 5)
        throw new HttpError("This invitation has already been used", 410);
      current = fresh;
    }
    const now = new Date().toISOString();
    await this.db.insertIfAbsent<MemberRecord>(HOME, "members", {
      id: memberId,
      workspaceId: record.id,
      accountId: account.id,
      role: invite.role,
      joinedAt: now,
      invitedBy: invite.createdBy,
    });
    return this.toView(record, invite.role);
  }

  // Helpers

  /** The workspaces a person is in, made or joined, not counting one on its way out. */
  private async workspacesOf(account: Account): Promise<WorkspaceRecord[]> {
    const memberships = await this.db.listWhere<MemberRecord>(
      HOME,
      "members",
      "accountId",
      account.id,
    );
    const found: WorkspaceRecord[] = [];
    for (const membership of memberships) {
      const record = await this.db.get<WorkspaceRecord>(HOME, "workspaces", membership.workspaceId);
      if (record && record.status !== "deleting") found.push(record);
    }
    return found;
  }

  private limitReached(): HttpError {
    const most = this.options.maxWorkspacesPerAccount;
    return new HttpError(
      most === 1
        ? "You can be in only one workspace. Leave or delete yours to make or join another."
        : `You can have up to ${most} workspaces`,
      403,
    );
  }

  private async usableInvite(token: string) {
    const invite = await this.db.get<InviteRecord>(HOME, "invites", digest(token));
    if (!invite || invite.revokedAt) throw new HttpError("This invitation is not valid", 404);
    if (invite.expiresAt < Date.now()) throw new HttpError("This invitation has expired", 410);
    if (invite.uses >= invite.maxUses)
      throw new HttpError("This invitation has already been used", 410);
    const record = await this.db.get<WorkspaceRecord>(HOME, "workspaces", invite.workspaceId);
    if (!record || record.status === "deleting")
      throw new HttpError("This invitation is not valid", 404);
    return { invite, record };
  }

  /** The workspace and the asking person's place in it. Not belonging looks like not existing. */
  private async require(account: Account, id: string) {
    const [record, member] = await Promise.all([
      this.db.get<WorkspaceRecord>(HOME, "workspaces", id),
      this.db.get<MemberRecord>(HOME, "members", `${id}:${account.id}`),
    ]);
    if (!record || !member || record.status === "deleting")
      throw new HttpError("Workspace not found", 404);
    return { record, member };
  }

  private toView(record: WorkspaceRecord, role: WorkspaceRole): WorkspaceView {
    return {
      id: record.id,
      name: record.name,
      status: record.status,
      role,
      ...(record.status === "ready" && record.url ? { url: record.url } : {}),
      ...(record.status === "failed" && record.error ? { error: record.error } : {}),
      ...(record.status === "provisioning" && record.step && provisionSteps.includes(record.step)
        ? { step: record.step }
        : {}),
      createdAt: record.createdAt,
    };
  }

  private toInviteView(invite: InviteRecord): InviteView {
    return {
      id: invite.id,
      role: invite.role,
      ...(invite.email ? { email: invite.email } : {}),
      createdBy: invite.createdBy,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      maxUses: invite.maxUses,
      uses: invite.uses,
    };
  }

  private describe(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
