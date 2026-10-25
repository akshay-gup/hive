import { createHash } from "node:crypto";
import { HttpError } from "./errors.ts";
import type { ControlStore } from "./store.ts";

const OWNER = "control";
const KIND = "machine-config";
const DEFAULT_ID = "default";
const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_KEYS = 64;
const MAX_VALUE = 16_384;

/**
 * The shape of what a workspace is told. A workspace that does not know a version leaves its settings
 * as they are and says so, so a version is only ever added to, and a new kind of change takes a new
 * number and a build that understands it.
 */
export const CONFIG_SCHEMA = 1;

/**
 * Settings a machine's own identity and safety rest on: whatever else is changed, these are the ones
 * made when it was created. Kept out here, and again by the workspace itself (remote-settings.ts).
 */
export const PROTECTED_KEYS: ReadonlySet<string> = new Set([
  "WORKSPACE_ID",
  "CONTROL_PLANE_PUBLIC_KEY",
  "WORKSPACE_MODE",
  "HOST",
  "PORT",
  "DATA_DIR",
  "VOLUME_DIR",
  "WORKSPACE_UID",
  "WORKSPACE_GID",
  "WORKSPACE_HOME",
]);

/** What to change in a workspace's settings: a value sets it, `null` takes it away (back to nothing). */
export type Patch = Record<string, string | null>;

interface Stored {
  id: string;
  env: Patch;
  updatedAt: string;
}

/** The short name of a patch, which changes whenever anything in it does. It says nothing of what is in it. */
export function revisionOf(patch: Patch): string {
  const sorted = Object.keys(patch)
    .sort()
    .map((key) => [key, patch[key]]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 24);
}

export function checkPatch(input: unknown): Patch {
  const env = (input as { env?: unknown } | null)?.env;
  if (typeof env !== "object" || env === null || Array.isArray(env))
    throw new HttpError("Send {env: {NAME: value or null}}", 422);
  const entries = Object.entries(env);
  if (entries.length > MAX_KEYS) throw new HttpError(`At most ${MAX_KEYS} settings`, 422);
  const patch: Patch = {};
  for (const [key, value] of entries) {
    if (!KEY.test(key)) throw new HttpError(`${key} is not a setting name`, 422);
    if (PROTECTED_KEYS.has(key))
      throw new HttpError(`${key} cannot be changed after creation`, 422);
    if (value !== null && (typeof value !== "string" || value.length > MAX_VALUE))
      throw new HttpError(`${key} must be a string of up to ${MAX_VALUE} characters, or null`, 422);
    patch[key] = value;
  }
  return patch;
}

/**
 * What each workspace's settings should be, after it was made. The settings a workspace is made with
 * are written once, on its disk; this is how they change later without making it again. It keeps three
 * layers, the later ones winning: what the control plane works out for the workspace itself (the model
 * and the key to reach it by), what an operator sets for every workspace, and what they set for one.
 *
 * It does not say what the settings are, only what to change in them: the workspace keeps what it was
 * made with and puts this over it when it starts, so taking an override away puts the setting back as it was.
 */
export class MachineConfigs {
  constructor(
    private readonly db: ControlStore,
    /** What the control plane works out for a workspace (see `ModelGateway.environmentFor`). */
    private readonly managed?: (workspaceId: string) => Record<string, string>,
  ) {}

  private key = (workspaceId: string) => `workspace:${workspaceId}`;

  private async overrides(id: string): Promise<Patch> {
    return (await this.db.get<Stored>(OWNER, KIND, id))?.env ?? {};
  }

  async patchFor(workspaceId: string): Promise<Patch> {
    const patch: Patch = {
      ...(this.managed?.(workspaceId) ?? {}),
      ...(await this.overrides(DEFAULT_ID)),
      ...(await this.overrides(this.key(workspaceId))),
    };
    for (const key of PROTECTED_KEYS) delete patch[key];
    return patch;
  }

  /** The revision a workspace should be on, with nothing of what is in it. */
  async answerFor(workspaceId: string): Promise<{ v: number; rev: string }> {
    return { v: CONFIG_SCHEMA, rev: revisionOf(await this.patchFor(workspaceId)) };
  }

  /** What a workspace fetches, with its own key. */
  async documentFor(workspaceId: string): Promise<{ v: number; rev: string; env: Patch }> {
    const env = await this.patchFor(workspaceId);
    return { v: CONFIG_SCHEMA, rev: revisionOf(env), env };
  }

  private async save(id: string, env: Patch): Promise<Stored> {
    return this.db.put<Stored>(OWNER, KIND, { id, env, updatedAt: new Date().toISOString() });
  }

  /** What every workspace is given besides what it was made with (replaces what was set before). */
  setDefault(input: unknown): Promise<Stored> {
    return this.save(DEFAULT_ID, checkPatch(input));
  }
  setWorkspace(workspaceId: string, input: unknown): Promise<Stored> {
    return this.save(this.key(workspaceId), checkPatch(input));
  }
  async clearWorkspace(workspaceId: string): Promise<void> {
    await this.db.remove(OWNER, KIND, this.key(workspaceId));
  }

  async overview(): Promise<{ default: Patch; workspaces: Record<string, Patch> }> {
    const all = await this.db.list<Stored>(OWNER, KIND);
    const workspaces: Record<string, Patch> = {};
    for (const item of all)
      if (item.id.startsWith("workspace:"))
        workspaces[item.id.slice("workspace:".length)] = item.env;
    return { default: all.find((item) => item.id === DEFAULT_ID)?.env ?? {}, workspaces };
  }
}
