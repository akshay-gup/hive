import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  DEFAULT_TOKEN_SECONDS,
  signWorkspaceToken,
  type WorkspaceRole,
} from "../../../packages/integrations/src/workspace-token.ts";
import type { Store } from "../../server/src/db.ts";
import { type Account, type Accounts, accountIdFor, HOME } from "./accounts.ts";
import { HttpError } from "./errors.ts";
import type { Mailer } from "./mailer.ts";
import { DEFAULT_PLAN, type PlanId, plans } from "./plans.ts";
import { type MachineState, ProvisionError, type Provisioner } from "./provisioner.ts";
import type { SigningKeys } from "./signing.ts";

export type WorkspaceStatus = "provisioning" | "ready" | "failed" | "deleting";

interface WorkspaceRecord {
  id: string;
  name: string;
  plan: PlanId;
  status: WorkspaceStatus;
  url?: string;
  error?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
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
  role: "admin" | "member";
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
  role: "admin" | "member";
  email?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: number;
  maxUses: number;
  uses: number;
}

const INVITE_DAYS = 7;
const LINK_INVITE_USES = 50;
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
  db: Store;
  accounts: Accounts;
  provisioner: Provisioner;
  mailer: Mailer;
  keys: SigningKeys;
  /** The control plane's address, which invite links are made from and workspaces allow. */
  publicUrl: string;
  allowedOrigins: string[];
  maxWorkspacesPerAccount: number;
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
    const made = await this.db.listWhere<WorkspaceRecord>(
      HOME,
      "workspaces",
      "createdBy",
      account.id,
    );
    if (made.filter((w) => w.status !== "deleting").length >= this.options.maxWorkspacesPerAccount)
      throw new HttpError(
        `You can have up to ${this.options.maxWorkspacesPerAccount} workspaces`,
        403,
      );
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
      });
    if (!record) throw new HttpError("Could not make a workspace. Try again.", 503);
    await this.db.put<MemberRecord>(HOME, "members", {
      id: `${record.id}:${account.id}`,
      workspaceId: record.id,
      accountId: account.id,
      role: "owner",
      joinedAt: now,
    });
    void this.provision(record.id);
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
      { status: "provisioning", error: null, updatedAt: new Date().toISOString() },
    );
    void this.provision(id);
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
    await this.options.provisioner.destroy(id);
    for (const m of await this.db.listWhere<MemberRecord>(HOME, "members", "workspaceId", id))
      await this.db.remove(HOME, "members", m.id);
    for (const i of await this.db.listWhere<InviteRecord>(HOME, "invites", "workspaceId", id))
      await this.db.remove(HOME, "invites", i.id);
    await this.db.remove(HOME, "workspaces", id);
  }

  /** Pick up what a restart (or a failed removal) left half done: workspaces being made, and ones being removed. */
  async resume(): Promise<void> {
    for (const { value } of await this.db.scan<WorkspaceRecord>("workspaces")) {
      if (value.status === "provisioning") void this.provision(value.id);
      if (value.status === "deleting")
        await this.finishRemoval(value.id).catch((error) =>
          console.error(`[Hive control] could not remove ${value.id}: ${this.describe(error)}`),
        );
    }
  }

  /** Resolves when the work now under way for a workspace is done. */
  async settled(id: string): Promise<void> {
    await this.jobs.get(id);
  }

  private provision(id: string): Promise<void> {
    const running = this.jobs.get(id);
    if (running) return running;
    const job = (async () => {
      try {
        const record = await this.db.get<WorkspaceRecord>(HOME, "workspaces", id);
        if (record?.status !== "provisioning") return;
        const { url } = await this.options.provisioner.create({
          workspaceId: id,
          name: record.name,
          plan: plans[record.plan],
          controlPublicKey: this.options.keys.publicKey,
          allowedOrigins: [new URL(this.options.publicUrl).origin, ...this.options.allowedOrigins],
        });
        await this.db.compareAndSwap(
          HOME,
          "workspaces",
          id,
          { status: "provisioning" },
          { status: "ready", url, updatedAt: new Date().toISOString() },
        );
      } catch (error) {
        console.error(`[Hive control] could not start ${id}: ${this.describe(error)}`);
        await this.db.compareAndSwap(
          HOME,
          "workspaces",
          id,
          { status: "provisioning" },
          {
            status: "failed",
            error:
              error instanceof ProvisionError
                ? error.userMessage
                : "We could not start this workspace. Try again in a minute.",
            updatedAt: new Date().toISOString(),
          },
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
    await this.require(account, id);
    const rows = await this.db.listWhere<MemberRecord>(HOME, "members", "workspaceId", id);
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
    const rank: Record<WorkspaceRole, number> = { owner: 0, admin: 1, member: 2 };
    return views.sort((a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name));
  }

  async setRole(
    account: Account,
    id: string,
    targetId: string,
    role: "admin" | "member",
  ): Promise<void> {
    const { member } = await this.require(account, id);
    if (member.role !== "owner") throw new HttpError("Only the owner can change roles", 403);
    const target = await this.db.get<MemberRecord>(HOME, "members", `${id}:${targetId}`);
    if (!target) throw new HttpError("That person is not in this workspace", 404);
    if (target.role === "owner") throw new HttpError("The owner's role cannot change", 409);
    await this.db.compareAndSwap(HOME, "members", target.id, {}, { role });
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
      leaving || member.role === "owner" || (member.role === "admin" && target.role === "member");
    if (!allowed) throw new HttpError("You cannot remove that person", 403);
    await this.db.remove(HOME, "members", target.id);
  }

  // Invites

  async createInvite(
    account: Account,
    id: string,
    input: { email?: string; role?: "admin" | "member" },
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
    const link = `${this.options.publicUrl}/join/${token}`;
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
