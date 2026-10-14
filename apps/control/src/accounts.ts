import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "./errors.ts";
import type { ControlStore } from "./store.ts";

/** The `owner` the control plane files its records under: it is one service, not a person's workspace. */
export const HOME = "control";
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_CODE_MS = 5 * 60 * 1000;

export interface Account {
  id: string;
  email: string;
  name: string;
  googleSub?: string;
  createdAt: string;
  lastLoginAt: string;
}
interface SessionRecord {
  id: string;
  accountId: string;
  expiresAt: number;
}
interface LoginCode {
  id: string;
  accountId: string;
  expiresAt: number;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
/** One account per email address, so two sign-ins at once cannot make two. */
export const accountIdFor = (email: string) => `acct_${digest(`email:${email}`).slice(0, 24)}`;

/** People, and the sessions they sign in with. */
export class Accounts {
  constructor(private readonly db: ControlStore) {}

  /** The account for an email address, made on first sign-in; a name is only taken when one is given. */
  async upsert(profile: { email: string; name?: string; googleSub?: string }): Promise<Account> {
    const email = profile.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320)
      throw new HttpError("Enter a valid email address", 422);
    const id = accountIdFor(email);
    const now = new Date().toISOString();
    const existing = await this.db.get<Account>(HOME, "accounts", id);
    const name = profile.name?.trim() || existing?.name || email.split("@")[0] || email;
    return this.db.put<Account>(HOME, "accounts", {
      id,
      email,
      name: name.slice(0, 100),
      googleSub: profile.googleSub ?? existing?.googleSub,
      createdAt: existing?.createdAt ?? now,
      lastLoginAt: now,
    });
  }

  get(id: string): Promise<Account | null> {
    return this.db.get<Account>(HOME, "accounts", id);
  }

  async startSession(accountId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.db.put<SessionRecord>(HOME, "sessions", {
      id: digest(token),
      accountId,
      expiresAt: Date.now() + SESSION_MS,
    });
    return token;
  }

  /** The account a request's bearer token belongs to, or a 401. */
  async accountFor(authorization?: string): Promise<Account> {
    if (!authorization?.startsWith("Bearer ")) throw new HttpError("Sign in to Hive", 401);
    const session = await this.db.get<SessionRecord>(
      HOME,
      "sessions",
      digest(authorization.slice(7)),
    );
    if (!session || session.expiresAt < Date.now())
      throw new HttpError("Session expired. Sign in again.", 401);
    const account = await this.get(session.accountId);
    if (!account) throw new HttpError("Session expired. Sign in again.", 401);
    return account;
  }

  async endSession(authorization?: string): Promise<void> {
    if (authorization?.startsWith("Bearer "))
      await this.db.remove(HOME, "sessions", digest(authorization.slice(7)));
  }

  /**
   * A single-use code that stands for a sign-in that just happened, so the app can ask for its
   * session once, and the session token itself never travels in a URL.
   */
  async mintLoginCode(accountId: string): Promise<string> {
    const code = randomBytes(24).toString("base64url");
    await this.db.put<LoginCode>(HOME, "login-codes", {
      id: code,
      accountId,
      expiresAt: Date.now() + LOGIN_CODE_MS,
    });
    return code;
  }

  async exchangeLoginCode(code: string): Promise<{ token: string; account: Account }> {
    const record = await this.db.take<LoginCode>(HOME, "login-codes", code);
    if (!record || record.expiresAt < Date.now())
      throw new HttpError("Sign-in expired. Try again.", 400);
    const account = await this.get(record.accountId);
    if (!account) throw new HttpError("Sign-in expired. Try again.", 400);
    return { token: await this.startSession(account.id), account };
  }
}
