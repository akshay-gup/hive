import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** The form of the document this program understands. The control plane says which it is sending. */
export const SETTINGS_SCHEMA = 1;

/** What a machine's identity and safety rest on; whatever the control plane says, these stay as it was made with. */
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

const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const REVISION = /^[0-9a-f]{8,64}$/;

export interface SettingsDoc {
  v: number;
  rev: string;
  env: Record<string, string | null>;
}

/** The document, if it is in a form this program accepts; otherwise why not. */
export function readDoc(text: string): { doc: SettingsDoc } | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: "not JSON" };
  }
  const doc = value as Partial<SettingsDoc> | null;
  if (typeof doc !== "object" || doc === null || typeof doc.v !== "number")
    return { problem: "not a settings document" };
  if (doc.v !== SETTINGS_SCHEMA)
    return { problem: `a form (version ${doc.v}) this build does not know; a newer build will` };
  if (typeof doc.rev !== "string" || !REVISION.test(doc.rev)) return { problem: "no revision" };
  const env = doc.env;
  if (typeof env !== "object" || env === null || Array.isArray(env))
    return { problem: "no settings" };
  for (const [key, setting] of Object.entries(env))
    if (!KEY.test(key) || (setting !== null && typeof setting !== "string"))
      return { problem: "a setting that is not a name and a string" };
  return { doc: { v: doc.v, rev: doc.rev, env } };
}

/** The settings the machine was made with, with the document's laid over them (`null` takes one away). */
export function overlay(made: Env, doc: SettingsDoc): Env {
  const out: Env = { ...made };
  for (const [key, setting] of Object.entries(doc.env)) {
    if (PROTECTED_KEYS.has(key)) continue;
    if (setting === null) delete out[key];
    else out[key] = setting;
  }
  return out;
}

/** The workspace's own key: the one it reaches the model gateway with, which the control plane made for it. */
export function keyOf(made: Env): string | undefined {
  try {
    const config = JSON.parse(made.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<string, { options?: { apiKey?: unknown } }>;
    };
    for (const provider of Object.values(config.provider ?? {}))
      if (typeof provider?.options?.apiKey === "string") return provider.options.apiKey;
  } catch {
    // Not JSON: no key to be found in it.
  }
  return undefined;
}

export interface Where {
  /** Where the control plane's settings are asked for, and the key to ask with. */
  url: string;
  key: string;
}

/** Where to ask, from what the machine was told (/etc/hive/updater.json) and made with. Nothing to ask is no error. */
export function whereFrom(etc: string, made: Env): Where | undefined {
  try {
    const told = JSON.parse(readFileSync(join(etc, "updater.json"), "utf8")) as {
      wantedUrl?: unknown;
      tokenFile?: unknown;
    };
    if (typeof told.wantedUrl !== "string" || !told.wantedUrl) return undefined;
    let key: string | undefined;
    if (typeof told.tokenFile === "string") {
      try {
        key = readFileSync(told.tokenFile, "utf8").trim() || undefined;
      } catch {
        // Falls back to the gateway key below.
      }
    }
    key ??= keyOf(made);
    return key ? { url: `${told.wantedUrl.replace(/\/+$/, "")}/config`, key } : undefined;
  } catch {
    return undefined;
  }
}

export async function ask(
  where: Where,
  fetcher: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<{ doc: SettingsDoc } | { problem: string }> {
  try {
    const response = await fetcher(where.url, {
      headers: { authorization: `Bearer ${where.key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { problem: `the control plane answered ${response.status}` };
    return readDoc(await response.text());
  } catch {
    return { problem: "the control plane could not be reached" };
  }
}

/** What a start came to: the settings to run with, and the revision they are (none if they are as made). */
export interface Started {
  env: Env;
  /** The revision it is running on (none if as made). */
  rev?: string;
  /** The revision the control plane last said, even one it did not take, so it is not restarted for that one again. */
  seen?: string;
  where?: Where;
}

interface Paths {
  /** Root's: the last settings that kept the workspace up (/etc/hive), and the account of how it went (/var/lib/hive). */
  etc: string;
  state: string;
  /** The workspace's own volume, where it says it stayed up. */
  volume: string;
}

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

function write(path: string, text: string, mode: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.new`, text, { mode });
  renameSync(`${path}.new`, path);
}

/** For the workspace's health answer (the updater's record of its own work is beside it). */
function record(paths: Paths, state: string, rev: string | undefined, message: string): void {
  try {
    write(
      join(paths.state, "last-config.json"),
      `${JSON.stringify({ state, rev: rev ?? "", message, at: new Date().toISOString() })}\n`,
      0o644,
    );
  } catch {
    // The record is for people to read; not having it never stops the workspace.
  }
}

const stayedUp = (paths: Paths) => join(paths.volume, ".settings-stayed-up");

/** Written once the workspace has been up a while on a revision, by the workspace itself (it is not root by then). */
export function noteStayedUp(volume: string, rev: string): void {
  try {
    writeFileSync(join(volume, ".settings-stayed-up"), rev, { mode: 0o600 });
  } catch {
    // Without it the next start does not take this revision as good, which is the safe way round.
  }
}

/**
 * The settings to start with: the machine's own (what it was made with), with the control plane's
 * laid over them, as they were just asked for. When the control plane cannot be reached the last
 * settings that kept the workspace up are used, and a machine that has none starts as it was made.
 * A revision the workspace did not stay up on is never tried again until the control plane says
 * something else, so a bad value cannot keep a workspace from starting.
 *
 * It runs as root, before the workspace gives that up (the files are root's).
 */
export async function startWith(
  made: Env,
  paths: Paths,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<Started> {
  const where = whereFrom(paths.etc, made);
  if (!where) return { env: made };

  const goodFile = join(paths.etc, "settings.good.json");
  const trying = join(paths.state, "settings.trying");
  const failed = join(paths.state, "settings.failed");

  // What the last start was running on, and whether it stayed up.
  const last = read(trying)?.trim();
  if (last) {
    if (read(stayedUp(paths))?.trim() === last) {
      const pending = read(join(paths.etc, "settings.pending.json"));
      if (pending) write(goodFile, pending, 0o600);
    } else {
      write(failed, last, 0o644);
    }
    rmSync(join(paths.etc, "settings.pending.json"), { force: true });
    rmSync(trying, { force: true });
  }

  const answer = await ask(where, options.fetcher, options.timeoutMs);
  let seen: string | undefined;
  if ("doc" in answer) {
    const { doc } = answer;
    seen = doc.rev;
    if (read(failed)?.trim() === doc.rev) {
      record(
        paths,
        "failed",
        doc.rev,
        "did not stay up on these settings; using the last that did",
      );
    } else {
      write(join(paths.etc, "settings.pending.json"), JSON.stringify(doc), 0o600);
      write(trying, doc.rev, 0o644);
      record(paths, "updated", doc.rev, "settings from the control plane");
      return { env: overlay(made, doc), rev: doc.rev, seen, where };
    }
  } else {
    record(paths, "unchanged", undefined, answer.problem);
  }

  // Not the control plane's word this time: what last kept the workspace up, else as it was made.
  const kept = read(goodFile);
  const good = kept ? readDoc(kept) : undefined;
  if (good && "doc" in good)
    return { env: overlay(made, good.doc), rev: good.doc.rev, seen, where };
  return { env: made, seen, where };
}

/**
 * Asks now and then whether the control plane has other settings than the ones the workspace is
 * running on, and says so once it has. Settings are read when the workspace starts, so the way to
 * take new ones is to start again; `onChange` is how it asks to be.
 */
export function watchSettings(
  where: Where,
  running: string | undefined,
  onChange: (rev: string) => void,
  options: { everyMs?: number; fetcher?: typeof fetch; timeoutMs?: number } = {},
): () => void {
  let stopped = false;
  const timer = setInterval(
    async () => {
      const answer = await ask(where, options.fetcher, options.timeoutMs);
      if (stopped || !("doc" in answer) || answer.doc.rev === running) return;
      stopped = true;
      clearInterval(timer);
      onChange(answer.doc.rev);
    },
    options.everyMs ?? 5 * 60_000,
  );
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
