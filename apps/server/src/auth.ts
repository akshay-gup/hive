import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();
const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url").toString("utf8");
export class Auth {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly signingKey: string,
  ) {}
  /**
   * Keyless session for local/sample mode. Live mode has no key login —
   * the only way in is Google sign-in (see google-auth.ts).
   */
  async session() {
    if (this.config.mode === "live")
      throw new AppError("Sign in with Google to open your workspace.", 401);
    return this.sessionForOwner("local-user");
  }
  /** Create a session for any owner (used by Google sign-in), good for a day unless `ttlMs` says otherwise. */
  async sessionForOwner(owner: string, ttlMs = 24 * 60 * 60 * 1000) {
    const token = randomBytes(32).toString("base64url");
    await this.db.put("system", "sessions", {
      id: digest(token).toString("hex"),
      owner,
      expiresAt: Date.now() + ttlMs,
    });
    return { token, mode: this.config.mode };
  }
  async owner(authorization?: string) {
    if (!authorization?.startsWith("Bearer ")) throw new AppError("Sign in to Hive", 401);
    const session = await this.db.get<{ owner: string; expiresAt: number }>(
      "system",
      "sessions",
      digest(authorization.slice(7)).toString("hex"),
    );
    if (!session || session.expiresAt < Date.now())
      throw new AppError("Session expired. Sign in again.", 401);
    return session.owner;
  }
  /** End every session a person has, so what they were signed in as stops working now and not when each runs out. */
  async endSessions(owner: string): Promise<number> {
    const sessions = await this.db.listWhere<{ id: string }>("system", "sessions", "owner", owner);
    for (const session of sessions) await this.db.remove("system", "sessions", session.id);
    return sessions.length;
  }
  async logout(authorization: string) {
    await this.db.remove("system", "sessions", digest(authorization.slice(7)).toString("hex"));
  }
  sign(owner: string, path: string) {
    const expires = String(Date.now() + 15 * 60 * 1000);
    const signature = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${path}\n${expires}`)
      .digest("hex");
    return `${this.config.publicUrl}${path}?owner=${encodeURIComponent(owner)}&expires=${expires}&signature=${signature}`;
  }
  verify(url: URL) {
    const owner = url.searchParams.get("owner") ?? "";
    const expires = url.searchParams.get("expires") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    if (
      !owner ||
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now() ||
      !/^\w{64}$/.test(signature)
    )
      throw new AppError("Document link expired; refresh the workspace", 401);
    const expected = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${url.pathname}\n${expires}`)
      .digest("hex");
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
      throw new AppError("Invalid access link", 403);
    return owner;
  }
  /**
   * A time-limited token saying `owner` may use whatever `subject` names. The subject travels in the
   * token and is covered by its signature, so a link can keep its scope in the path, where the
   * relative links of a page keep it too, instead of in a query string they would drop.
   */
  signToken(owner: string, subject: string): string {
    const body = `${Date.now() + 15 * 60 * 1000}.${encode(owner)}.${encode(subject)}`;
    return `${body}.${this.mac(body)}`;
  }
  /** The owner and subject of a token this server issued, or an error saying why it is no good. */
  verifyToken(token: string): { owner: string; subject: string } {
    const parts = token.split(".");
    const [expires, owner, subject, signature] = parts;
    if (
      parts.length !== 4 ||
      !/^\d+$/.test(expires) ||
      !/^[\w-]+$/.test(owner) ||
      !/^[\w-]*$/.test(subject) ||
      !/^[\w-]{43}$/.test(signature)
    )
      throw new AppError("This link is not valid; refresh and try again", 401);
    if (Number(expires) < Date.now())
      throw new AppError("This link expired; refresh and try again", 401);
    const body = `${expires}.${owner}.${subject}`;
    if (!timingSafeEqual(Buffer.from(this.mac(body)), Buffer.from(signature)))
      throw new AppError("Invalid access link", 403);
    return { owner: decode(owner), subject: decode(subject) };
  }
  /** Tokens are signed apart from `sign`'s links, so one kind of signature never stands for the other. */
  private mac(body: string) {
    return createHmac("sha256", this.signingKey).update(`token\n${body}`).digest("base64url");
  }
}
export async function createAuth(db: Store, config: Config) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const path = join(config.dataDir, "session-signing-key");
  let key: string;
  try {
    key = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    key = randomBytes(32).toString("base64");
    await writeFile(path, key, { mode: 0o600, flag: "wx" });
  }
  return new Auth(db, config, key);
}
