import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

/**
 * Runs apps/workspace/vm/hive-update on a folder standing in for a machine: a fake `crane` that hands
 * out a build made for the test, a fake `systemctl` that writes down what it was asked, and a server
 * standing in for the workspace, which answers /api/health with the version in /app/VERSION (and
 * refuses when the build is marked broken).
 */
const SCRIPT = new URL("../apps/workspace/vm/hive-update", import.meta.url).pathname;
const WATCHDOG = new URL("../apps/workspace/vm/hive-update-watchdog", import.meta.url).pathname;
const FALLBACK = new URL("../apps/workspace/vm/hive-update-fallback", import.meta.url).pathname;
const DIGEST = `sha256:${"a".repeat(64)}`;

let root: string;
let health: Server;
let wanted = { tag: "", digest: "", force: false };
/** What the control plane says about settings: the revision in its answer, and the document behind it. */
let configAnswer: unknown;
let configDoc: unknown;
let configAuth = "";

const file = (path: string, content: string, mode = 0o644) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
};

/** A fresh machine on version v1, with a fake build waiting to be fetched as `fetched`. */
function machine(name: string, options: { broken?: boolean; digest?: string } = {}) {
  const dir = join(root, name);
  const m = {
    dir,
    app: join(dir, "app"),
    bin: join(dir, "bin"),
    etc: join(dir, "etc"),
    state: join(dir, "state"),
    data: join(dir, "data"),
    log: join(dir, "systemctl.log"),
    /** The updater on this machine, a copy of the real one. */
    self: join(dir, "hive-update"),
  };
  file(m.self, readFileSync(SCRIPT, "utf8"), 0o755);
  file(join(m.app, "VERSION"), "v1\n");
  file(join(m.app, "package.json"), "{}");
  file(join(m.bin, "node"), "node v1", 0o755);
  file(join(m.bin, "opencode"), "opencode v1", 0o755);
  mkdirSync(m.etc, { recursive: true });
  file(join(m.data, "keep.txt"), "the workspace's own");
  // The build `crane export` will stream.
  const build = join(dir, "build");
  file(join(build, "app", "package.json"), "{}");
  file(join(build, "app", "marker"), "from v2");
  if (options.broken) file(join(build, "app", "BROKEN"), "");
  file(join(build, "usr", "local", "bin", "node"), "node v2", 0o755);
  file(join(build, "usr", "local", "bin", "opencode"), "opencode v2", 0o755);
  file(
    join(dir, "crane"),
    `#!/usr/bin/env bash
case "$1" in
  digest) echo "${options.digest ?? DIGEST}" ;;
  export) tar -c -C "${build}" app usr ;;
esac
`,
    0o755,
  );
  file(join(dir, "systemctl"), `#!/usr/bin/env bash\necho "$@" >> "${m.log}"\n`, 0o755);
  return m;
}

function run(
  m: ReturnType<typeof machine>,
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [extra.HIVE_RUN ?? m.self, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HIVE_SELF: m.self,
        HIVE_APP: m.app,
        HIVE_BIN: m.bin,
        HIVE_ETC: m.etc,
        HIVE_STATE: m.state,
        HIVE_SYSTEMCTL: join(m.dir, "systemctl"),
        HIVE_CRANE: join(m.dir, "crane"),
        HIVE_HEALTH: `http://127.0.0.1:${(health.address() as AddressInfo).port}/${m.dir.split("/").pop()}`,
        HIVE_IMAGE_REPO: "ghcr.io/example/hive-workspace",
        HIVE_HEALTH_WAIT: "4",
        HIVE_MIN_FREE_MB: "1",
        ...extra,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

const read = (path: string) => readFileSync(path, "utf8").trim();
const state = (m: ReturnType<typeof machine>) =>
  JSON.parse(readFileSync(join(m.state, "last-update.json"), "utf8"));

before(async () => {
  root = mkdtempSync(join(tmpdir(), "hive-update-"));
  health = createServer((request, response) => {
    // /<machine>: the version of that machine's /app, unless the build there is marked broken.
    const name = (request.url ?? "").split("/")[1];
    if (request.url === "/wanted/config") {
      configAuth = request.headers.authorization ?? "";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(configDoc));
      return;
    }
    if (request.url?.startsWith("/wanted")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ...wanted, config: configAnswer }));
      return;
    }
    const app = join(root, name, "app");
    const settings = join(root, name, "etc", "workspace.json");
    // A workspace whose settings say CRASH does not come up.
    const crashes = existsSync(settings) && readFileSync(settings, "utf8").includes('"CRASH"');
    if (!existsSync(app) || existsSync(join(app, "BROKEN")) || crashes) {
      response.statusCode = 503;
      response.end("{}");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, version: read(join(app, "VERSION")) }));
  });
  await new Promise<void>((done) => health.listen(0, "127.0.0.1", done));
});
after(() => health.close());

test("--to puts the new build on and leaves the workspace's own data alone", async () => {
  const m = machine("update");
  const { code, out } = await run(m, ["--to", "v2"]);
  assert.equal(code, 0, out);
  assert.equal(read(join(m.app, "VERSION")), "v2");
  assert.equal(read(join(m.app, "marker")), "from v2");
  assert.equal(read(join(m.bin, "node")), "node v2");
  assert.equal(read(join(m.bin, "opencode")), "opencode v2");
  assert.equal(read(join(m.data, "keep.txt")), "the workspace's own");
  assert.deepEqual(
    readFileSync(m.log, "utf8").trim().split("\n"),
    ["stop hive-workspace.service", "start hive-workspace.service"],
    "the service is stopped, then started",
  );
  assert.equal(state(m).state, "updated");
  assert.equal(state(m).version, "v2");
  // The old program is kept until the next update succeeds.
  assert.equal(read(join(`${m.app}.prev`, "VERSION")), "v1");
});

test("running on the version it is asked for does nothing", async () => {
  const m = machine("same");
  const { code } = await run(m, ["--to", "v1"]);
  assert.equal(code, 0);
  assert.equal(existsSync(m.log), false, "the service was not touched");
  assert.equal(read(join(m.app, "VERSION")), "v1");
});

test("a build that does not come up is taken back off, and the old one comes back", async () => {
  const m = machine("broken", { broken: true });
  const { code, out } = await run(m, ["--to", "v2"]);
  assert.equal(code, 1, out);
  assert.equal(read(join(m.app, "VERSION")), "v1");
  assert.equal(existsSync(join(m.app, "marker")), false);
  assert.equal(read(join(m.bin, "node")), "node v1");
  assert.equal(read(join(m.bin, "opencode")), "opencode v1");
  assert.equal(read(join(m.data, "keep.txt")), "the workspace's own");
  assert.equal(state(m).state, "failed");
  assert.equal(
    readFileSync(m.log, "utf8").trim().split("\n").at(-1),
    "start hive-workspace.service",
    "the old build is started again",
  );
});

test("a tag that is not the digest asked for is refused before anything changes", async () => {
  const m = machine("digest", { digest: `sha256:${"b".repeat(64)}` });
  const { code } = await run(m, ["--to", "v2", "--digest", DIGEST]);
  assert.equal(code, 1);
  assert.equal(read(join(m.app, "VERSION")), "v1");
  assert.equal(existsSync(m.log), false, "the service was not touched");
  assert.equal(state(m).state, "failed");
});

test("a digest that matches is used to fetch the build", async () => {
  const m = machine("digest-ok");
  const { code, out } = await run(m, ["--to", "v2", "--digest", DIGEST]);
  assert.equal(code, 0, out);
  assert.equal(read(join(m.app, "VERSION")), "v2");
});

test("a tag or digest that is not well formed is refused", async () => {
  const m = machine("malformed");
  assert.equal((await run(m, ["--to", "../etc"])).code, 1);
  assert.equal((await run(m, ["--to", "v2", "--digest", "nope"])).code, 1);
  assert.equal(read(join(m.app, "VERSION")), "v1");
});

test("without settings and without --to the timer does nothing", async () => {
  const m = machine("quiet");
  const { code } = await run(m, []);
  assert.equal(code, 0);
  assert.equal(existsSync(m.log), false);
});

test("it asks the control plane which build to run, and goes to it", async () => {
  const m = machine("asks");
  file(
    join(m.etc, "updater.json"),
    JSON.stringify({
      wantedUrl: `http://127.0.0.1:${(health.address() as AddressInfo).port}/wanted`,
    }),
  );
  wanted = { tag: "v2", digest: DIGEST, force: false };
  const { code, out } = await run(m, []);
  assert.equal(code, 0, out);
  assert.equal(read(join(m.app, "VERSION")), "v2");
});

test("a busy workspace is left alone, and the update waits", async () => {
  const m = machine("busy");
  file(join(m.etc, "idle-check"), "#!/usr/bin/env bash\nexit 1\n", 0o755);
  const { code } = await run(m, ["--to", "v2"], { HIVE_IDLE_WAIT: "0" });
  assert.equal(code, 0);
  assert.equal(read(join(m.app, "VERSION")), "v1");
  assert.equal(state(m).state, "waiting");
});

test("--force does not wait for an idle workspace", async () => {
  const m = machine("force");
  file(join(m.etc, "idle-check"), "#!/usr/bin/env bash\nexit 1\n", 0o755);
  const { code, out } = await run(m, ["--to", "v2", "--force"]);
  assert.equal(code, 0, out);
  assert.equal(read(join(m.app, "VERSION")), "v2");
});

test("a request file from the server with 'force' skips the wait and is used up", async () => {
  const m = machine("request");
  file(join(m.etc, "idle-check"), "#!/usr/bin/env bash\nexit 1\n", 0o755);
  file(join(m.state, "update-request"), "force");
  const { code, out } = await run(m, ["--to", "v2"]);
  assert.equal(code, 0, out);
  assert.equal(read(join(m.app, "VERSION")), "v2");
  assert.equal(existsSync(join(m.state, "update-request")), false);
});

/** Puts `content` in the build the fake crane hands out, where the real image has its machine scripts. */
const inBuild = (m: ReturnType<typeof machine>, name: string, content: string) =>
  file(join(m.dir, "build", "app", "machine", name), content, 0o755);

test("the updater takes the newer one that came with the build, and finishes the update as that one", async () => {
  const m = machine("selfupdate");
  inBuild(m, "hive-update", `${readFileSync(SCRIPT, "utf8")}\n# the newer updater\n`);
  const { code, out } = await run(m, ["--to", "v2"]);
  assert.equal(code, 0, out);
  assert.match(out, /taking the updater that came with v2/);
  assert.match(readFileSync(m.self, "utf8"), /# the newer updater/);
  assert.equal(read(join(m.app, "VERSION")), "v2");
  // It fetched once: the new updater was handed what the old one had fetched.
  assert.equal((out.match(/fetching /g) ?? []).length, 1);
  assert.equal(readFileSync(`${m.self}.good`, "utf8"), readFileSync(m.self, "utf8"));
});

test("a newer updater that fails its own test is not taken, and the update goes on with the old one", async () => {
  const m = machine("badupdater");
  const before = readFileSync(m.self, "utf8");
  inBuild(m, "hive-update", "#!/usr/bin/env bash\nexit 1\n");
  const { code, out } = await run(m, ["--to", "v2"]);
  assert.equal(code, 0, out);
  assert.match(out, /does not pass its own test/);
  assert.equal(readFileSync(m.self, "utf8"), before);
  assert.equal(read(join(m.app, "VERSION")), "v2");

  const m2 = machine("brokenupdater");
  inBuild(m2, "hive-update", "#!/usr/bin/env bash\nif then\n");
  const second = await run(m2, ["--to", "v2"]);
  assert.equal(second.code, 0, second.out);
  assert.equal(read(join(m2.app, "VERSION")), "v2");
});

test("what the build needs from the machine is made before the workspace is stopped", async () => {
  const m = machine("ensure");
  inBuild(
    m,
    "hive-ensure",
    `#!/usr/bin/env bash\n[ -e "${m.log}" ] && echo late >"${m.dir}/ensure" || echo early >"${m.dir}/ensure"\n`,
  );
  const { code, out } = await run(m, ["--to", "v2"]);
  assert.equal(code, 0, out);
  assert.equal(read(join(m.dir, "ensure")), "early");
});

test("if the machine cannot be made ready, nothing is changed", async () => {
  const m = machine("ensurefails");
  inBuild(m, "hive-ensure", "#!/usr/bin/env bash\nexit 1\n");
  const { code } = await run(m, ["--to", "v2"]);
  assert.equal(code, 1);
  assert.equal(read(join(m.app, "VERSION")), "v1");
  assert.equal(existsSync(m.log), false, "the workspace was never stopped");
  assert.equal(state(m).state, "failed");
});

test("when the updater fails, the last one that worked is tried and becomes the updater again", async () => {
  const m = machine("fallback");
  const good = readFileSync(SCRIPT, "utf8");
  file(`${m.self}.good`, good, 0o755);
  file(m.self, "#!/usr/bin/env bash\nexit 1\n", 0o755);
  file(
    join(m.etc, "updater.json"),
    JSON.stringify({
      wantedUrl: `http://127.0.0.1:${(health.address() as AddressInfo).port}/wanted`,
    }),
  );
  wanted = { tag: "v2", digest: DIGEST, force: false };
  const { code, out } = await run(m, [], { HIVE_RUN: FALLBACK });
  assert.equal(code, 0, out);
  assert.equal(read(join(m.app, "VERSION")), "v2");
  assert.equal(readFileSync(m.self, "utf8"), good, "the one that worked is in use again");
});

test("the fallback does not take a newer updater from the image, or go back to the one already in use", async () => {
  const m = machine("fallbacknoloop");
  const good = readFileSync(SCRIPT, "utf8");
  file(`${m.self}.good`, good, 0o755);
  file(m.self, good, 0o755);
  const idle = await run(m, [], { HIVE_RUN: FALLBACK });
  assert.equal(idle.code, 0);
  assert.match(idle.out, /nothing else to try/);

  // The updater in use differs, and so does the image's: the good one still does not switch to it.
  const m2 = machine("fallbacknoswitch");
  file(`${m2.self}.good`, good, 0o755);
  file(m2.self, "#!/usr/bin/env bash\nexit 1\n", 0o755);
  inBuild(m2, "hive-update", `${good}\n# the newer updater\n`);
  const result = await run(m2, ["--to", "v2"], {
    HIVE_RUN: `${m2.self}.good`,
    HIVE_NO_SELF_UPDATE: "1",
  });
  assert.equal(result.code, 0, result.out);
  assert.doesNotMatch(readFileSync(m2.self, "utf8"), /the newer updater/);
  assert.equal(read(join(m2.app, "VERSION")), "v2");
});

/** A machine whose updater does nothing and says nothing, with a good one to fall back to. */
function silentMachine(name: string, asks = "wanted") {
  const m = machine(name);
  const good = readFileSync(SCRIPT, "utf8");
  file(`${m.self}.good`, good, 0o755);
  file(m.self, "#!/usr/bin/env bash\nexit 0\n", 0o755);
  file(
    join(m.etc, "updater.json"),
    JSON.stringify({
      wantedUrl: `http://127.0.0.1:${(health.address() as AddressInfo).port}/${asks}`,
    }),
  );
  wanted = { tag: "v2", digest: DIGEST, force: false };
  return { m, good };
}
const watch = (m: ReturnType<typeof machine>) => run(m, [], { HIVE_RUN: WATCHDOG });

test("an updater that does nothing is noticed on the second check, and the good one does the update", async () => {
  const { m, good } = silentMachine("watchdog");
  assert.equal((await watch(m)).code, 0);
  assert.equal(read(join(m.app, "VERSION")), "v1", "one check is not enough");
  const second = await watch(m);
  assert.equal(second.code, 0, second.out);
  assert.equal(read(join(m.app, "VERSION")), "v2");
  assert.equal(readFileSync(m.self, "utf8"), good, "the good one is the updater again");
});

test("the watchdog leaves a build alone that already failed on this machine", async () => {
  const { m } = silentMachine("watchdogfailed");
  file(
    join(m.state, "last-update.json"),
    JSON.stringify({
      state: "failed",
      version: "v1",
      message: "v2 did not come up; went back to v1",
    }),
  );
  await watch(m);
  await watch(m);
  assert.equal(read(join(m.app, "VERSION")), "v1");
});

test("the watchdog waits while the workspace is busy and the update is waiting its turn", async () => {
  const { m } = silentMachine("watchdogbusy");
  file(
    join(m.state, "last-update.json"),
    JSON.stringify({ state: "waiting", version: "v1", message: "busy" }),
  );
  await watch(m);
  await watch(m);
  assert.equal(read(join(m.app, "VERSION")), "v1");
});

test("the watchdog does nothing when it cannot get a clear answer, or the machine is on the right build", async () => {
  const unreachable = silentMachine("watchdogoffline");
  file(
    join(unreachable.m.etc, "updater.json"),
    JSON.stringify({ wantedUrl: "http://127.0.0.1:9/wanted" }),
  );
  await watch(unreachable.m);
  await watch(unreachable.m);
  assert.equal(read(join(unreachable.m.app, "VERSION")), "v1");

  const right = silentMachine("watchdogright");
  wanted = { tag: "v1", digest: DIGEST, force: false };
  await watch(right.m);
  await watch(right.m);
  assert.equal(existsSync(right.m.log), false, "nothing was touched");
  assert.equal(existsSync(join(right.m.state, "watchdog.json")), false);
});

test("the watchdog has nothing to try when the updater in use is the good one", async () => {
  const { m, good } = silentMachine("watchdoggood");
  file(m.self, good, 0o755);
  await watch(m);
  const second = await watch(m);
  assert.equal(second.code, 0);
  assert.equal(read(join(m.app, "VERSION")), "v1");
});

test("the watchdog gives up after three tries and spaces them out", async () => {
  const { m } = silentMachine("watchdogtries");
  // The good updater is made to fail, so each try leaves the machine on v1.
  file(`${m.self}.good`, "#!/usr/bin/env bash\nexit 1\n", 0o755);
  const memory = join(m.state, "watchdog.json");
  await watch(m);
  await watch(m);
  const first = JSON.parse(readFileSync(memory, "utf8"));
  assert.equal(first.tries, 1);
  await watch(m);
  assert.equal(JSON.parse(readFileSync(memory, "utf8")).tries, 1, "not again so soon");
  // Pretend the wait has passed, up to the third try.
  for (const tries of [1, 2]) {
    writeFileSync(
      memory,
      JSON.stringify({ tag: "v2", seen: 5, tries, triedAt: Math.floor(Date.now() / 1000) - 99999 }),
    );
    await watch(m);
    assert.equal(JSON.parse(readFileSync(memory, "utf8")).tries, tries + 1);
  }
  const before = readFileSync(memory, "utf8");
  writeFileSync(
    memory,
    JSON.stringify({
      tag: "v2",
      seen: 5,
      tries: 3,
      triedAt: Math.floor(Date.now() / 1000) - 99999,
    }),
  );
  const out = await watch(m);
  assert.match(out.out, /tried 3 times/);
  assert.notEqual(before, "");
});

// Settings: the workspace's own settings kept as the control plane wants them.

const REV1 = "a".repeat(24);
const REV2 = "b".repeat(24);
const KEY = "hwk_wset.secretpart";
const MADE_WITH = {
  WORKSPACE_ID: "wset",
  PORT: "8787",
  TASK_WORKER_ENABLED: "true",
  MODEL: "p/hive-default",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { p: { options: { apiKey: KEY } } } }),
};
const settingsOf = (m: ReturnType<typeof machine>) =>
  JSON.parse(readFileSync(join(m.etc, "workspace.json"), "utf8"));
const services = (m: ReturnType<typeof machine>) =>
  existsSync(m.log) ? readFileSync(m.log, "utf8").trim().split("\n") : [];

/** A machine that is on the build it is told to run, with the settings it was made with, that asks where to. */
function askingMachine(name: string, options: { broken?: boolean } = {}) {
  const m = machine(name, options);
  file(join(m.etc, "workspace.json"), JSON.stringify(MADE_WITH), 0o600);
  file(
    join(m.etc, "updater.json"),
    JSON.stringify({
      wantedUrl: `http://127.0.0.1:${(health.address() as AddressInfo).port}/wanted`,
    }),
  );
  wanted = { tag: "v1", digest: DIGEST, force: false };
  return m;
}

test("a change to the settings is put over the ones the machine was made with, and the workspace restarted on them", async () => {
  const m = askingMachine("cfg-apply");
  configAnswer = { v: 1, rev: REV1 };
  configDoc = {
    v: 1,
    rev: REV1,
    env: { TASK_WORKER_ENABLED: "false", NEW_ONE: "x", WORKSPACE_ID: "someone-else", PORT: "1" },
  };
  const { code, out } = await run(m, []);
  assert.equal(code, 0, out);
  const now = settingsOf(m);
  assert.equal(now.TASK_WORKER_ENABLED, "false");
  assert.equal(now.NEW_ONE, "x");
  assert.equal(now.WORKSPACE_ID, "wset", "who it is is not up for change");
  assert.equal(now.PORT, "8787");
  assert.equal(now.MODEL, MADE_WITH.MODEL, "what was not changed is as it was");
  assert.equal(configAuth, `Bearer ${KEY}`, "it asked with its own key");
  assert.deepEqual(services(m), ["restart hive-workspace.service"]);
  assert.equal(read(join(m.state, "config.rev")), REV1);
  assert.equal(JSON.parse(read(join(m.state, "last-config.json"))).state, "updated");
  assert.equal(statSync(join(m.etc, "workspace.json")).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(read(join(m.etc, "workspace.base.json"))), MADE_WITH);

  // Asked again with nothing new: nothing happens.
  assert.equal((await run(m, [])).code, 0);
  assert.deepEqual(services(m), ["restart hive-workspace.service"]);

  // A change taken away puts the setting back as it was made.
  configAnswer = { v: 1, rev: REV2 };
  configDoc = { v: 1, rev: REV2, env: {} };
  assert.equal((await run(m, [])).code, 0);
  assert.deepEqual(settingsOf(m), MADE_WITH);
  assert.equal(services(m).length, 2);
});

test("settings that come to the same as the machine has are noted and the workspace is left running", async () => {
  const m = askingMachine("cfg-same");
  configAnswer = { v: 1, rev: REV1 };
  configDoc = { v: 1, rev: REV1, env: { TASK_WORKER_ENABLED: "true" } };
  assert.equal((await run(m, [])).code, 0);
  assert.deepEqual(services(m), []);
  assert.equal(read(join(m.state, "config.rev")), REV1);
});

test("settings in a form this updater does not know are left alone", async () => {
  const m = askingMachine("cfg-newer");
  configAnswer = { v: 2, rev: REV1 };
  configDoc = { v: 2, rev: REV1, env: { TASK_WORKER_ENABLED: "false" }, files: [] };
  const { code, out } = await run(m, []);
  assert.equal(code, 0, out);
  assert.match(out, /does not know/);
  assert.deepEqual(settingsOf(m), MADE_WITH);
  assert.deepEqual(services(m), []);
});

test("an old control plane that says nothing of settings changes nothing", async () => {
  const m = askingMachine("cfg-none");
  configAnswer = undefined;
  assert.equal((await run(m, [])).code, 0);
  assert.deepEqual(settingsOf(m), MADE_WITH);
  assert.equal(existsSync(join(m.etc, "workspace.base.json")), false);
});

test("settings that are not what was said, or are not strings, are refused", async () => {
  const m = askingMachine("cfg-bad");
  configAnswer = { v: 1, rev: REV1 };
  for (const doc of [
    { v: 1, rev: REV2, env: { A: "1" } },
    { v: 1, rev: REV1, env: { A: 1 } },
    { v: 1, rev: REV1, env: { "bad name": "1" } },
    { v: 1, rev: REV1, env: [] },
  ]) {
    configDoc = doc;
    assert.equal((await run(m, [])).code, 0);
    assert.deepEqual(settingsOf(m), MADE_WITH);
  }
  assert.deepEqual(services(m), []);
});

test("settings the workspace does not come up on are taken back, and not tried again", async () => {
  const m = askingMachine("cfg-broken");
  // These settings make the workspace not answer its health check.
  configAnswer = { v: 1, rev: REV1 };
  configDoc = { v: 1, rev: REV1, env: { CRASH: "1" } };
  const { code } = await run(m, []);
  assert.equal(code, 0);
  assert.deepEqual(settingsOf(m), MADE_WITH);
  assert.equal(services(m).length, 2, "restarted on them, then restarted on the old ones");
  assert.equal(JSON.parse(read(join(m.state, "last-config.json"))).state, "failed");
  assert.equal(read(join(m.state, "config.failed")), REV1);
  await run(m, []);
  assert.equal(services(m).length, 2, "the same revision is not tried again");
});
