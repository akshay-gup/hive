import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { HOME } from "./accounts.ts";
import type { GoogleLogin } from "./app.ts";
import { HttpError } from "./errors.ts";
import type { ControlStore } from "./store.ts";

export interface GoogleSettings {
  clientId: string;
  clientSecret: string;
  /** Where Google sends the person back to: `<publicUrl>/v1/auth/google/callback`. */
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
}

export const GOOGLE_ENDPOINTS = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userinfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
};

const STATE_MS = 10 * 60 * 1000;
const tokenSchema = z.object({ access_token: z.string().min(1) });
const profileSchema = z.object({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
});
interface PendingSignIn {
  id: string;
  verifier: string;
  origin?: string;
  expiresAt: number;
}

/**
 * Signing in with Google, for who the person is and nothing else: name and email. A person's
 * Gmail or Calendar is not asked for here; a workspace asks for that itself, if it wants it.
 */
export class GoogleSignIn implements GoogleLogin {
  private readonly settings: GoogleSettings;
  constructor(
    private readonly db: ControlStore,
    settings: Pick<GoogleSettings, "clientId" | "clientSecret" | "redirectUri"> &
      Partial<GoogleSettings>,
  ) {
    this.settings = { ...GOOGLE_ENDPOINTS, ...settings };
  }

  async loginUrl(origin?: string): Promise<{ url: string }> {
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    await this.db.put<PendingSignIn>(HOME, "oauth", {
      id: state,
      verifier,
      ...(origin ? { origin } : {}),
      expiresAt: Date.now() + STATE_MS,
    });
    const url = new URL(this.settings.authUrl);
    url.search = new URLSearchParams({
      client_id: this.settings.clientId,
      redirect_uri: this.settings.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    return { url: url.toString() };
  }

  async loginCallback(state: string, code: string) {
    // A state is good for one return from Google, whether or not that return goes well.
    const pending = await this.db.take<PendingSignIn>(HOME, "oauth", state);
    if (!pending || pending.expiresAt < Date.now())
      throw new HttpError("Google sign-in expired. Try again.", 400);

    const exchanged = await this.ask(this.settings.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
        redirect_uri: this.settings.redirectUri,
        grant_type: "authorization_code",
        code,
        code_verifier: pending.verifier,
      }),
    });
    const token = tokenSchema.safeParse(exchanged);
    if (!token.success) throw new HttpError("Google could not complete sign-in. Try again.", 502);

    const profile = profileSchema.safeParse(
      await this.ask(this.settings.userinfoUrl, {
        headers: { Authorization: `Bearer ${token.data.access_token}` },
      }),
    );
    if (!profile.success)
      throw new HttpError("Google could not verify who you are. Try again.", 502);
    // Accounts and invitations go by email address, so an address Google has not checked is not one to trust.
    if (profile.data.email_verified !== true)
      throw new HttpError(
        "Google has not verified this email address. Verify it with Google, then sign in again.",
        403,
      );
    return {
      sub: profile.data.sub,
      email: profile.data.email,
      name: profile.data.name,
      origin: pending.origin,
    };
  }

  private async ask(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new HttpError("Could not reach Google. Try again.", 502);
    }
    if (!response.ok) throw new HttpError("Google could not complete sign-in. Try again.", 502);
    return response.json().catch(() => null);
  }
}
