import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface UpdateStatus {
  state?: string;
  version?: string;
  message?: string;
  at?: string;
  /** The last lines the updater said, newest last. */
  log?: string[];
  /** How the last change to the workspace's settings went (see hive-update). */
  config?: { state?: string; rev?: string; message?: string; at?: string };
}

/**
 * How the machine's last update went, for the health answer: what the updater recorded and the end
 * of what it said. A machine that cannot be logged in to has no other way to say why it is not on
 * the build it was told to run. Nothing here is secret: build names and what went wrong. Without
 * the updater's folder (a container, a laptop) there is nothing to say.
 */
export async function readUpdateStatus(
  dir = process.env.HIVE_STATE_DIR ?? "/var/lib/hive",
): Promise<UpdateStatus | undefined> {
  const read = (name: string) => readFile(join(dir, name), "utf8").catch(() => undefined);
  const [recorded, said, settings] = await Promise.all([
    read("last-update.json"),
    read("update.log"),
    read("last-config.json"),
  ]);
  if (!recorded && !said && !settings) return undefined;
  let status: UpdateStatus = {};
  try {
    const value = JSON.parse(recorded ?? "{}") as Record<string, unknown>;
    const text = (key: string) =>
      typeof value[key] === "string" ? (value[key] as string) : undefined;
    status = {
      state: text("state"),
      version: text("version"),
      message: text("message"),
      at: text("at"),
    };
  } catch {
    // A half-written record says nothing; the log still may.
  }
  let config: UpdateStatus["config"];
  try {
    const value = JSON.parse(settings ?? "{}") as Record<string, unknown>;
    const text = (key: string) =>
      typeof value[key] === "string" ? (value[key] as string).slice(0, 300) : undefined;
    if (text("state"))
      config = { state: text("state"), rev: text("rev"), message: text("message"), at: text("at") };
  } catch {
    // As above: nothing to say.
  }
  const log = said
    ?.split("\n")
    .filter(Boolean)
    .slice(-12)
    .map((line) => line.slice(0, 300));
  return { ...status, ...(log?.length ? { log } : {}), ...(config ? { config } : {}) };
}
