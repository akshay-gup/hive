import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../../../packages/integrations/src/vault.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  scope: z.string().optional(),
});
interface Tokens {
  connectionId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
  account: string;
}
interface OAuthState {
  id: string;
  owner: string;
  expiresAt: number;
  verifier: string;
  scopes: string[];
  generation: string;
  /** "connect" links Gmail/Calendar; "login" signs the user into Hive. */
  purpose?: "connect" | "login";
  /** Web origin that opened the login popup (for postMessage target). */
  origin?: string;
  /** SHA-256 of a secret only the app that started the sign-in holds. */
  challenge?: string;
}
interface LoginCode {
  id: string;
  purpose: "login-code";
  token: string;
  mode: string;
  expiresAt: number;
  challenge?: string;
}
/** base64url of a SHA-256 digest: what an app sends to start a sign-in. */
const challengePattern = /^[A-Za-z0-9_-]{43}$/;
interface Credential {
  id: string;
  generation?: string;
  connectionId: string | null;
  secret: string | null;
  /** Who completed the connection, to show on the Apps screen. */
  connectedBy?: string;
  connectedAt?: string;
}
export class GoogleAuth {
  private readonly refreshing = new Map<string, Promise<string>>();
  constructor(
    private readonly db: Store,
    private readonly config: Config,
  ) {}
  configured() {
    return Boolean(
      this.config.googleClientId && this.config.googleClientSecret && this.config.encryptionKey,
    );
  }
  /**
   * The workspace's Google connection. There is only one, so `owner` is whoever is asking and
   * makes no difference to which connection they get.
   */
  async tokens(owner: string): Promise<Tokens | null> {
    return this.decodeTokens(await this.db.get<Credential>(owner, "credentials", "google"));
  }
  /** Who connected the workspace's Google account, when it is connected. */
  async connectedBy(owner: string): Promise<string | undefined> {
    const credential = await this.db.get<Credential>(owner, "credentials", "google");
    return credential?.secret ? credential.connectedBy : undefined;
  }
  private decodeTokens(stored: Credential | null): Tokens | null {
    if (!stored?.secret) return null;
    if (!this.config.encryptionKey)
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
    return JSON.parse(decryptSecret(stored.secret, this.config.encryptionKey));
  }
  private async save(owner: string, tokens: Tokens, generation: string) {
    if (!this.config.encryptionKey)
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
    const saved = await this.db.compareAndSwap<Credential>(
      owner,
      "credentials",
      "google",
      { generation },
      {
        generation: randomUUID(),
        connectionId: tokens.connectionId,
        secret: encryptSecret(JSON.stringify(tokens), this.config.encryptionKey),
        connectedBy: owner,
        connectedAt: new Date().toISOString(),
      },
    );
    if (!saved)
      throw new AppError("Google sign-in changed or was disconnected. Connect again.", 409);
  }
  private async rotateGeneration(owner: string, disconnect = false) {
    const generation = randomUUID();
    for (;;) {
      const previous = await this.db.get<Credential>(owner, "credentials", "google");
      if (!previous) {
        const inserted = await this.db.insertIfAbsent(owner, "credentials", {
          id: "google",
          generation,
          connectionId: null,
          secret: null,
        });
        if (inserted) return { generation, previous: null };
      } else {
        const updated = await this.db.compareAndSwap<Credential>(
          owner,
          "credentials",
          "google",
          { ...previous },
          {
            generation,
            ...(disconnect ? { connectionId: null, secret: null } : {}),
          },
        );
        if (updated) return { generation, previous };
      }
    }
  }
  async connect(owner: string, write: boolean) {
    if (!this.configured())
      throw new AppError(
        "Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY to connect Google",
        503,
      );
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    const { generation, previous } = await this.rotateGeneration(owner);
    const existing = this.decodeTokens(previous);
    const scopes = Array.from(
      new Set([
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
        ...(existing?.scopes ?? []),
        ...(write
          ? [
              "https://www.googleapis.com/auth/gmail.send",
              "https://www.googleapis.com/auth/calendar.events",
              "https://www.googleapis.com/auth/drive.file",
            ]
          : []),
      ]),
    );
    await this.db.put("system", "oauth", {
      id: state,
      owner,
      expiresAt: Date.now() + 10 * 60 * 1000,
      verifier,
      scopes,
      generation,
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.googleClientId ?? "",
      redirect_uri: this.config.googleRedirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      // Granting more access is for the account that is connected, so Google starts there.
      ...(existing ? { login_hint: existing.account } : {}),
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    return { url: url.toString() };
  }
  /**
   * Start a Google sign-in. Minimal identity scopes only — Gmail/Calendar
   * stay as separate incremental consent via `connect()`. The same
   * redirect URI serves both flows; the callback dispatches on the
   * state's purpose.
   */
  async loginUrl(origin?: string, challenge?: string) {
    if (!this.configured())
      throw new AppError(
        "Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY for Google sign-in",
        503,
      );
    // The code that comes back reaches the app through a web popup or a custom-scheme link, and
    // another page or app can listen on either. A popup is only handed the code when its origin is
    // one this server allows (the route checks), and an app's link is only good to the app that
    // holds the proof, so a sign-in names one or the other.
    if (challenge !== undefined && !challengePattern.test(challenge))
      throw new AppError("Sign-in could not start. Update the app and try again.", 400);
    if (!origin && !challenge)
      throw new AppError("Sign-in could not start. Update the app and try again.", 400);
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    await this.db.put("system", "oauth", {
      id: state,
      owner: "",
      expiresAt: Date.now() + 10 * 60 * 1000,
      verifier,
      scopes: ["openid", "email", "profile"],
      generation: "",
      purpose: "login",
      ...(origin ? { origin } : {}),
      ...(challenge ? { challenge } : {}),
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.googleClientId ?? "",
      redirect_uri: this.config.googleRedirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    return { url: url.toString() };
  }
  /** Peek at a pending OAuth state's purpose without consuming it. */
  async callbackPurpose(stateId: string): Promise<"connect" | "login" | null> {
    const state = await this.db.get<OAuthState>("system", "oauth", stateId);
    if (!state) return null;
    return state.purpose === "login" ? "login" : "connect";
  }
  /**
   * Complete a Google sign-in: exchange the code and return the Google
   * identity. Consumes the state.
   */
  async loginCallback(stateId: string, code: string) {
    const state = await this.db.take<OAuthState>("system", "oauth", stateId);
    if (!state || state.expiresAt < Date.now())
      throw new AppError("Google sign-in expired. Try again.", 400);
    if (state.purpose !== "login") throw new AppError("Google sign-in expired. Try again.", 400);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.googleClientId ?? "",
        client_secret: this.config.googleClientSecret ?? "",
        redirect_uri: this.config.googleRedirectUri,
        grant_type: "authorization_code",
        code,
        code_verifier: state.verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new AppError("Google could not complete sign-in. Try again.", 502);
    const token = tokenSchema.parse(await response.json());
    const userinfo = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!userinfo.ok) throw new AppError("Google could not verify identity. Try again.", 502);
    const profile = z
      .object({ sub: z.string().min(1), email: z.email(), name: z.string().optional() })
      .parse(await userinfo.json());
    return { ...profile, origin: state.origin, challenge: state.challenge };
  }
  /**
   * Mint a single-use login code for the app to exchange for its session
   * token (keeps the bearer token out of browser history / deep links).
   * With a challenge, only the holder of the matching proof can exchange it.
   */
  async mintLoginCode(token: string, mode: string, challenge?: string): Promise<string> {
    const code = randomBytes(24).toString("base64url");
    await this.db.put<LoginCode>("system", "oauth", {
      id: code,
      purpose: "login-code",
      token,
      mode,
      expiresAt: Date.now() + 5 * 60 * 1000,
      ...(challenge ? { challenge } : {}),
    });
    return code;
  }
  /**
   * Exchange a single-use login code for the session token. A code is spent by the first attempt,
   * right or wrong, so a guess at the proof cannot be retried.
   */
  async exchangeLoginCode(code: string, proof?: string): Promise<{ token: string; mode: string }> {
    const record = await this.db.take<LoginCode>("system", "oauth", code);
    if (record?.purpose !== "login-code" || (record.expiresAt ?? 0) < Date.now())
      throw new AppError("Sign-in expired. Try again.", 400);
    if (record.challenge) {
      const expected = Buffer.from(record.challenge, "base64url");
      const actual = createHash("sha256")
        .update(proof ?? "")
        .digest();
      if (!proof || expected.length !== actual.length || !timingSafeEqual(expected, actual))
        throw new AppError("Sign-in expired. Try again.", 400);
    }
    return { token: record.token, mode: record.mode as "sample" | "live" };
  }
  async callback(stateId: string, code: string) {
    const state = await this.db.take<OAuthState>("system", "oauth", stateId);
    if (!state || state.expiresAt < Date.now())
      throw new AppError("Google sign-in expired. Connect again.", 400);
    const credential = await this.db.get<Credential>(state.owner, "credentials", "google");
    if (!state.generation || credential?.generation !== state.generation)
      throw new AppError("Google sign-in changed or was disconnected. Connect again.", 409);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.googleClientId ?? "",
        client_secret: this.config.googleClientSecret ?? "",
        redirect_uri: this.config.googleRedirectUri,
        grant_type: "authorization_code",
        code,
        code_verifier: state.verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new AppError("Google could not complete sign-in. Connect again.", 502);
    const token = tokenSchema.parse(await response.json());
    const profile = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!profile.ok)
      throw new AppError("Google did not grant Gmail read access. Connect again.", 403);
    const { emailAddress } = z.object({ emailAddress: z.email() }).parse(await profile.json());
    const previous = await this.tokens(state.owner);
    // The workspace has one Google connection. More access for the connected account is fine;
    // a different account has to wait until the connected one is disconnected.
    if (previous && previous.account !== emailAddress)
      throw new AppError(
        `Google is already connected as ${previous.account}. Disconnect it before connecting ${emailAddress}.`,
        409,
      );
    await this.save(
      state.owner,
      {
        connectionId: randomUUID(),
        accessToken: token.access_token,
        refreshToken:
          token.refresh_token ??
          (previous?.account === emailAddress ? previous.refreshToken : undefined),
        expiresAt: Date.now() + token.expires_in * 1000,
        scopes: token.scope?.split(" ") ?? state.scopes,
        account: emailAddress,
      },
      state.generation,
    );
  }
  async accessToken(owner: string, expectedConnectionId?: string): Promise<string> {
    const tokens = await this.tokens(owner);
    if (!tokens) throw new AppError("Google is disconnected", 409);
    if (expectedConnectionId && tokens.connectionId !== expectedConnectionId)
      throw new AppError("Google account or connection changed. Prepare a new action.", 409);
    if (tokens.expiresAt > Date.now() + 60000) return tokens.accessToken;
    // One connection serves the whole workspace, so a refresh is shared by whoever asks.
    const refreshKey = tokens.connectionId;
    const pending = this.refreshing.get(refreshKey);
    if (pending) return pending;
    const task = this.refresh(owner, tokens).finally(() => this.refreshing.delete(refreshKey));
    this.refreshing.set(refreshKey, task);
    return task;
  }
  private async refresh(owner: string, tokens: Tokens) {
    if (!tokens.refreshToken) throw new AppError("Google session expired. Connect again.", 401);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.googleClientId ?? "",
        client_secret: this.config.googleClientSecret ?? "",
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new AppError("Google session expired. Connect again.", 401);
    const token = tokenSchema.parse(await response.json());
    const refreshed = {
      ...tokens,
      accessToken: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
    if (!this.config.encryptionKey) throw new AppError("Token encryption is not configured", 503);
    const updated = await this.db.updateCredential(
      owner,
      tokens.connectionId,
      encryptSecret(JSON.stringify(refreshed), this.config.encryptionKey),
    );
    if (!updated)
      throw new AppError("Google account changed or was disconnected during refresh", 409);
    return token.access_token;
  }
  async disconnect(owner: string) {
    const { previous } = await this.rotateGeneration(owner, true);
    const tokens = this.decodeTokens(previous);
    if (tokens) {
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refreshToken ?? tokens.accessToken }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok && response.status !== 400)
        throw new AppError(
          "Disconnected locally. Google revocation failed; remove access in your Google account settings.",
          502,
        );
    }
  }
}
