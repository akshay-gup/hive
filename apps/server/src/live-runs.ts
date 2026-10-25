import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where the number of runs going is kept, for whatever has to restart the workspace (see `workspace/src/remote-settings.ts`, `hive-update`). */
export const LIVE_RUNS_FILE = "runs-live";

/**
 * Writes down how many runs are going, a run waiting for someone's answer among them, so that
 * something outside the server can wait for none before it restarts the workspace. Not being able to
 * write it is not worth stopping a run for: a reader that finds no file takes the workspace as idle.
 */
export function publishLiveRuns(dataDir: string, count: number): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, LIVE_RUNS_FILE);
    writeFileSync(`${file}.new`, `${count}\n`, { mode: 0o644 });
    renameSync(`${file}.new`, file);
  } catch {
    // See above.
  }
}
