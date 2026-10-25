import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LIVE_RUNS_FILE, publishLiveRuns } from "../apps/server/src/live-runs.ts";

test("how many runs are going is written where the thing that restarts the workspace can read it", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-runs-"));
  try {
    const file = join(dir, "data", LIVE_RUNS_FILE);
    publishLiveRuns(join(dir, "data"), 3);
    assert.equal(readFileSync(file, "utf8").trim(), "3");
    publishLiveRuns(join(dir, "data"), 0);
    assert.equal(readFileSync(file, "utf8").trim(), "0");
    assert.equal(existsSync(`${file}.new`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a place it cannot write to does not stop anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-runs-"));
  try {
    writeFileSync(join(dir, "file"), "");
    assert.doesNotThrow(() => publishLiveRuns(join(dir, "file", "inside"), 1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
