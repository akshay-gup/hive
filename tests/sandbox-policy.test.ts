import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildSessionRuleset,
  taskSessionRuleset,
} from "../apps/server/src/opencode/permissions.ts";
import { SandboxPolicy } from "../apps/server/src/opencode/sandbox.ts";
import type { Channel } from "../packages/domain/src/agent.ts";

const channel = (id: string, visibility?: "public" | "private"): Channel => ({
  id,
  name: id,
  status: "active",
  createdBy: "olive",
  createdAt: "2026-10-22T00:00:00Z",
  updatedAt: "2026-10-22T00:00:00Z",
  workerPid: null,
  lastActiveAt: "2026-10-22T00:00:00Z",
  ...(visibility ? { visibility } : {}),
});

function setup(channels: Channel[]) {
  const dir = mkdtempSync(join(tmpdir(), "hive-policy-"));
  const dataDir = join(dir, "vol", "hive");
  const file = join(dataDir, "sandbox-policy.json");
  const list = [...channels];
  const policy = new SandboxPolicy({ dataDir, file, volume: join(dir, "vol") }, async () => list);
  return {
    dir,
    dataDir,
    file,
    list,
    policy,
    read: () => JSON.parse(readFileSync(file, "utf8")),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a workspace with no private channel confines nothing and holds no session to anything", async () => {
  const s = setup([channel("general", "public"), channel("older")]);
  try {
    assert.deepEqual(await s.policy.rules(), []);
    assert.deepEqual(s.read(), { version: 1, confine: false, dataDir: s.dataDir, private: [] });
  } finally {
    s.done();
  }
});

test("a private channel's folder is named in the policy, and the file tools may not go beyond the channel", async () => {
  const s = setup([channel("general", "public"), channel("plans", "private")]);
  try {
    const rules = await s.policy.rules();
    assert.deepEqual(rules, [
      { permission: "external_directory", pattern: `${join(s.dir, "vol")}/*`, action: "deny" },
    ]);
    assert.deepEqual(s.read(), {
      version: 1,
      confine: true,
      dataDir: s.dataDir,
      private: [join(s.dataDir, "owners", "shared", "channels", "plans")],
    });
    // The deny is the last rule, so what a channel says about itself does not undo it.
    const built = buildSessionRuleset(
      [{ permission: "external_directory", pattern: "*", action: "allow" }],
      "auto",
      rules,
    );
    assert.deepEqual(built.at(-1), rules[0]);
    assert.deepEqual(taskSessionRuleset(rules).at(-1), rules[0]);
  } finally {
    s.done();
  }
});

test("the policy follows the channels when one becomes private or is opened again", async () => {
  const s = setup([channel("plans", "public")]);
  try {
    await s.policy.sync();
    assert.equal(s.read().confine, false);
    s.list[0] = channel("plans", "private");
    await s.policy.sync();
    assert.equal(s.read().confine, true);
    s.list[0] = channel("plans", "public");
    assert.deepEqual(await s.policy.rules(), []);
    assert.equal(s.read().confine, false);
    // Nothing is left behind of the writes: only the policy is in the folder.
    assert.deepEqual(readdirSync(s.dataDir), ["sandbox-policy.json"]);
  } finally {
    s.done();
  }
});

test("a machine that was not given a policy file confines nothing and writes none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-policy-"));
  try {
    const policy = new SandboxPolicy({ dataDir: join(dir, "hive") }, async () => [
      channel("plans", "private"),
    ]);
    assert.deepEqual(await policy.rules(), []);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a policy that cannot be written stops the run instead of letting it go unconfined", async () => {
  const s = setup([channel("plans", "private")]);
  try {
    // The folder it would go in is a file.
    const blocked = new SandboxPolicy(
      { dataDir: s.dataDir, file: join(s.dir, "vol", "x", "p.json") },
      async () => [channel("plans", "private")],
    );
    await s.policy.sync();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(s.dir, "vol", "x"), "");
    await assert.rejects(() => blocked.rules());
  } finally {
    s.done();
  }
});
