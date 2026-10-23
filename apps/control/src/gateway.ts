import { createHmac, timingSafeEqual } from "node:crypto";
import { HOME } from "./accounts.ts";
import type { SignInLimiter } from "./limits.ts";
import type { ControlStore } from "./store.ts";

/**
 * The model gateway: workspaces reach the model through the control plane, which holds the
 * provider's key, so the key is never on a workspace's machine (where the agent's shell and any
 * member can read it).
 *
 * It is a pass-through. It reads the request's headers to learn which workspace is asking and to
 * put the real key in, and hands the provider's answer back as a stream it never reads, keeps or
 * logs. The one thing it does to what was asked is the model: a workspace names whatever model it was
 * set up with, and the gateway puts its own (`GATEWAY_MODEL`) in that place, so which model the
 * product runs on is decided here and changes for every workspace at once, those made long ago
 * included. It does that by reading a request's JSON for its `model` field and nothing else, and
 * keeps none of it. What it knows of a request is the workspace and the time.
 */

/** What a workspace calls the model, whatever it really is. The gateway swaps in the real one. */
export const MODEL_ALIAS = "hive-default";

/** The calls that name a model: the rest of the provider's API (listing models, say) is passed on untouched. */
const NAMES_A_MODEL = /(^|\/)(messages|chat\/completions|completions|responses)$/;

/** What the agent is told of the alias when `GATEWAY_MODEL_CONFIG` does not say better. */
const DEFAULT_MODEL_CONFIG = {
  name: "Hive",
  reasoning: true,
  tool_call: true,
  attachment: true,
  temperature: true,
  limit: { context: 200_000, output: 32_000 },
};

export interface GatewayProvider {
  /** The provider's API address as its SDK takes it (`https://api.openai.com/v1`), no trailing slash. */
  baseUrl: string;
  key: string;
  /** How the provider takes its key: `x-api-key: <key>` (Anthropic) or `Authorization: Bearer <key>`. */
  auth: "x-api-key" | "bearer";
}

export interface GatewaySettings {
  providers: Record<string, GatewayProvider>;
  /** The `provider/model-id` every workspace runs the agent on; the provider is one of `providers`. */
  model: string;
  /**
   * What the agent is told of the model, which it knows by the name `hive-default` and not its own:
   * OpenCode's model settings, such as `{"name":…,"tool_call":true,"reasoning":true,
   * "interleaved":{"field":"reasoning_content"},"limit":{"context":…,"output":…}}`. Left out, a
   * general description is used (it reasons, calls tools, takes files, has room for 200k tokens).
   */
  modelConfig?: Record<string, unknown>;
  /** Counts requests per workspace. Left out, each process counts for itself (120 a minute). */
  limiter?: SignInLimiter;
  /** For tests: the `fetch` that reaches the provider. */
  fetch?: typeof fetch;
  /** For tests: how long a workspace being there is believed without asking again. */
  presenceMs?: number;
}

/**
 * GATEWAY_PROVIDERS is a JSON object of the providers workspaces may use, each with its API address
 * and key, e.g. `{"anthropic":{"baseUrl":"https://api.anthropic.com/v1","key":"…"}}`, and
 * GATEWAY_MODEL the `provider/model-id` they run on. Neither set means no gateway. The optional
 * GATEWAY_MODEL_CONFIG is a JSON object describing that model to the agent (see `modelConfig`).
 */
export function gatewayFromEnv(
  env: Record<string, string | undefined> = process.env,
): GatewaySettings | undefined {
  const raw = env.GATEWAY_PROVIDERS?.trim();
  const model = env.GATEWAY_MODEL?.trim();
  if (!raw && !model) return undefined;
  if (!raw || !model) throw new Error("Set both GATEWAY_PROVIDERS and GATEWAY_MODEL, or neither");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GATEWAY_PROVIDERS must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("GATEWAY_PROVIDERS must be a JSON object");
  const providers: Record<string, GatewayProvider> = {};
  for (const [id, value] of Object.entries(parsed)) {
    const provider = value as Partial<GatewayProvider> | null;
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id))
      throw new Error(`GATEWAY_PROVIDERS: "${id}" is not a provider name`);
    if (typeof provider?.baseUrl !== "string" || typeof provider.key !== "string" || !provider.key)
      throw new Error(`GATEWAY_PROVIDERS: ${id} needs a baseUrl and a key`);
    let url: URL;
    try {
      url = new URL(provider.baseUrl);
    } catch {
      throw new Error(`GATEWAY_PROVIDERS: ${id}'s baseUrl is not an address`);
    }
    if (url.protocol !== "https:" || url.search || url.hash || url.username)
      throw new Error(`GATEWAY_PROVIDERS: ${id}'s baseUrl must be a plain https address`);
    if (provider.auth !== undefined && provider.auth !== "x-api-key" && provider.auth !== "bearer")
      throw new Error(`GATEWAY_PROVIDERS: ${id}'s auth must be "x-api-key" or "bearer"`);
    providers[id] = {
      baseUrl: provider.baseUrl.replace(/\/+$/, ""),
      key: provider.key,
      auth: provider.auth ?? (id === "anthropic" ? "x-api-key" : "bearer"),
    };
  }
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1 || !providers[model.slice(0, slash)])
    throw new Error(
      "GATEWAY_MODEL must be provider/model-id, with a provider in GATEWAY_PROVIDERS",
    );
  const described = env.GATEWAY_MODEL_CONFIG?.trim();
  if (!described) return { providers, model };
  let modelConfig: unknown;
  try {
    modelConfig = JSON.parse(described);
  } catch {
    modelConfig = null;
  }
  if (typeof modelConfig !== "object" || modelConfig === null || Array.isArray(modelConfig))
    throw new Error("GATEWAY_MODEL_CONFIG must be a JSON object");
  return { providers, model, modelConfig: modelConfig as Record<string, unknown> };
}

const TOKEN = /^hwk_([a-z0-9]{1,64})\.([A-Za-z0-9_-]{43})$/;
const PRESENCE_MS = 30_000;

/** Request headers that go on to the provider. Everything else, the caller's address and cookies among it, stays here. */
const FORWARDED_REQUEST = new Set([
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "user-agent",
]);
/** Response headers that do not go back: the connection's own, and what only made sense between the provider and us. */
const WITHHELD_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "set-cookie",
  "alt-svc",
  "server",
  "strict-transport-security",
]);

const failure = (status: number, type: string, message: string, headers: HeadersInit = {}) =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export class ModelGateway {
  /** Workspaces known to be there, and until when that is believed: the control plane's records are not asked every request. */
  private readonly present = new Map<string, number>();
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly db: ControlStore,
    private readonly publicUrl: string,
    private readonly secret: string,
    private readonly settings: GatewaySettings,
    private readonly limiter: SignInLimiter,
  ) {
    this.fetcher = settings.fetch ?? ((input, init) => fetch(input, init));
  }

  private mac(workspaceId: string) {
    return createHmac("sha256", `hive-model-gateway:${this.secret}`)
      .update(workspaceId)
      .digest("base64url");
  }

  /** The key a workspace calls the gateway with. It can be made again at any time, and is worth nothing anywhere else. */
  tokenFor(workspaceId: string): string {
    return `hwk_${workspaceId}.${this.mac(workspaceId)}`;
  }

  /** The workspace a token was made for, or null for any token that was not made here. */
  workspaceOf(token: string | undefined): string | null {
    const match = TOKEN.exec(token ?? "");
    if (!match) return null;
    const [, id = "", given = ""] = match;
    const expected = Buffer.from(this.mac(id));
    const actual = Buffer.from(given);
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? id : null;
  }

  /**
   * What a new workspace is told so its agent uses the gateway: the model, and for each provider
   * where to call and the workspace's own key. The provider's key is not among it.
   */
  environmentFor(workspaceId: string): Record<string, string> {
    const token = this.tokenFor(workspaceId);
    const provider: Record<string, unknown> = {};
    const modelProvider = this.modelProvider;
    for (const id of Object.keys(this.settings.providers))
      provider[id] = {
        options: { baseURL: `${this.publicUrl}/v1/gateway/${id}`, apiKey: token },
        // The model has one name here whatever it is; the gateway puts the real one in its place.
        ...(id === modelProvider
          ? { models: { [MODEL_ALIAS]: this.settings.modelConfig ?? DEFAULT_MODEL_CONFIG } }
          : {}),
      };
    return {
      MODEL: `${modelProvider}/${MODEL_ALIAS}`,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider }),
    };
  }

  private async isPresent(workspaceId: string): Promise<boolean> {
    const now = Date.now();
    if ((this.present.get(workspaceId) ?? 0) > now) return true;
    const workspace = await this.db.get<{ status?: string }>(HOME, "workspaces", workspaceId);
    // One being removed, or one that never started, has no use for the model.
    const there = workspace?.status === "ready" || workspace?.status === "provisioning";
    if (!there) {
      this.present.delete(workspaceId);
      return false;
    }
    if (this.present.size >= 5_000) this.present.clear();
    this.present.set(workspaceId, now + (this.settings.presenceMs ?? PRESENCE_MS));
    return true;
  }

  private get modelProvider(): string {
    return this.settings.model.slice(0, this.settings.model.indexOf("/"));
  }
  private get modelId(): string {
    return this.settings.model.slice(this.settings.model.indexOf("/") + 1);
  }

  /**
   * The request's body with the model it names swapped for the gateway's. A body that is not JSON, has
   * no model, or is for a call that does not name one goes on as it came, byte for byte.
   */
  private async withModel(request: Request, rest: string): Promise<ArrayBuffer | string> {
    const bytes = await request.arrayBuffer();
    if (!NAMES_A_MODEL.test(rest)) return bytes;
    try {
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body) &&
        typeof (body as { model?: unknown }).model === "string"
      )
        return JSON.stringify({ ...body, model: this.modelId });
    } catch {
      // Not JSON: the provider will say so.
    }
    return bytes;
  }

  async handle(request: Request, providerId: string): Promise<Response> {
    // A workspace may call by any provider's name it was made with; the model that answers is the gateway's.
    if (!this.settings.providers[providerId])
      return failure(404, "not_found_error", "No such model provider.");
    const provider = this.settings.providers[this.modelProvider] as GatewayProvider;
    if (request.method !== "POST" && request.method !== "GET")
      return failure(405, "invalid_request_error", "Method not allowed.");

    const authorization = request.headers.get("authorization");
    const workspaceId = this.workspaceOf(
      request.headers.get("x-api-key") ??
        (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined),
    );
    if (!workspaceId)
      return failure(401, "authentication_error", "This workspace's model key is not valid.");
    if (!(await this.limiter.allow(workspaceId)))
      return failure(
        429,
        "rate_limit_error",
        "This workspace is sending requests too fast. Slow down.",
        { "retry-after": "10" },
      );
    if (!(await this.isPresent(workspaceId)))
      return failure(403, "permission_error", "This workspace has been removed.");

    const target = this.targetFor(provider, providerId, new URL(request.url));
    if (!target) return failure(400, "invalid_request_error", "That is not a model address.");

    const headers = new Headers();
    request.headers.forEach((value, name) => {
      if (FORWARDED_REQUEST.has(name)) headers.set(name, value);
    });
    // Plain bytes, so what comes back needs no decoding on the way and can go straight on.
    headers.set("accept-encoding", "identity");
    if (provider.auth === "x-api-key") headers.set("x-api-key", provider.key);
    else headers.set("authorization", `Bearer ${provider.key}`);

    let upstream: Response;
    try {
      upstream = await this.fetcher(target, {
        method: request.method,
        headers,
        body:
          request.method === "GET"
            ? undefined
            : await this.withModel(request, new URL(request.url).pathname),
        // The caller going away (the agent stopped a run) ends the provider's work and the cost.
        signal: request.signal,
      });
    } catch {
      return failure(502, "api_error", "The model service could not be reached. Try again.");
    }
    const answer = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!WITHHELD_RESPONSE.has(name) && !name.startsWith("cf-")) answer.set(name, value);
    });
    return new Response(upstream.body, { status: upstream.status, headers: answer });
  }

  /** The provider's address for a request, or null for a path that would reach anything else. */
  private targetFor(provider: GatewayProvider, providerId: string, url: URL): string | null {
    const prefix = `/v1/gateway/${providerId}/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const rest = url.pathname.slice(prefix.length);
    if (
      !rest ||
      /%(?:2e|2f|5c)|\\/i.test(rest) ||
      rest.split("/").some((s) => s === "." || s === "..")
    )
      return null;
    const base = new URL(provider.baseUrl);
    const target = new URL(`${provider.baseUrl}/${rest}${url.search}`);
    const basePath = base.pathname.replace(/\/+$/, "");
    return target.origin === base.origin && target.pathname.startsWith(`${basePath}/`)
      ? target.toString()
      : null;
  }
}
