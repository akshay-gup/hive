import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const DIGEST = `sha256:${"a".repeat(64)}`;

let root: string;
let health: Server;
let wanted = { tag: "", digest: "", force: false };

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
  };
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
    const child = spawn("bash", [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
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
    if (request.url?.startsWith("/wanted")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(wanted));
      return;
    }
    const app = join(root, name, "app");
    if (!existsSync(app) || existsSync(join(app, "BROKEN"))) {
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
