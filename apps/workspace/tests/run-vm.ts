/**
 * Makes the image a workspace's own machine is made from, in a container that runs systemd, and
 * starts a machine from it the way a Droplet starts: settings arrive in a file, the service runs.
 * It checks what no stand-in can: that the image bake.sh makes starts a workspace, that nothing
 * runs as root and the settings can be read by root alone, that data and what is installed stay
 * across a reboot, that the server stops before the agent, and what the firewall lets through.
 *
 *   pnpm exec tsx apps/workspace/tests/run-vm.ts
 *
 * HIVE_IMAGE            take the workspace out of this container image instead of building one
 * DOCKER_BUILD_ARGS     extra arguments for `docker build`, split on spaces
 * DOCKER_NETWORK=host   give the stage that installs packages the host's network
 * KEEP_IMAGES=1         keep the images made here, which are large, for a faster next run
 *
 * It needs a Docker that runs privileged containers with systemd in them, and what it makes is
 * not a Droplet: cloud-init, the disk and the network of a real one are not here.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateWorkspaceKeys,
  signWorkspaceToken,
} from "../../../packages/integrations/src/workspace-token.ts";
import { plans } from "../../control/src/plans.ts";
import { workspaceSettings } from "../../control/src/workspace-env.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const suffix = randomUUID().slice(0, 8);
const baking = `hive-vm-baking-${suffix}`;
const machine = `hive-vm-machine-${suffix}`;
const IMAGES = {
  base: "hive-vm-test:base",
  prepared: "hive-vm-test:prepared",
  snapshot: "hive-vm-test:snapshot",
};
const work = mkdtempSync(join(tmpdir(), "hive-vm-"));
const workspaceId = "w4k9t2mx7a";
const keys = generateWorkspaceKeys();
const buildArgs = (process.env.DOCKER_BUILD_ARGS ?? "").split(/\s+/).filter(Boolean);
const hostNetwork = process.env.DOCKER_NETWORK === "host" ? ["--network", "host"] : [];

const docker = (args: string[], input?: string) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
  }).trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text: string) => console.log(`\n== ${text}`);

/** Runs a script inside the machine, as root unless a user is named. Fails when the script does. */
const inside = (script: string, user?: string, input?: string) =>
  docker(["exec", "-i", ...(user ? ["--user", user] : []), machine, "bash", "-c", script], input);
/** The same, for scripts whose failure is the answer: gives what they printed and their status. */
const tried = (script: string, user?: string) => {
  const result = spawnSync(
    "docker",
    ["exec", ...(user ? ["--user", user] : []), machine, "bash", "-c", script],
    { encoding: "utf8" },
  );
  return { out: `${result.stdout}${result.stderr}`.trim(), status: result.status };
};

/** A call to the workspace from inside its machine, which has no network but its own. */
function api(path: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const out = docker([
    "exec",
    "-i",
    machine,
    "curl",
    "-sS",
    "-w",
    "\n%{http_code}",
    "-X",
    options.method ?? "GET",
    ...(options.token ? ["-H", `Authorization: Bearer ${options.token}`] : []),
    ...(options.body === undefined
      ? []
      : ["-H", "Content-Type: application/json", "--data-binary", JSON.stringify(options.body)]),
    `http://127.0.0.1:8787${path}`,
  ]);
  const cut = out.lastIndexOf("\n");
  const text = out.slice(0, cut);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: Number(out.slice(cut + 1)), json: json as never, text };
}

async function untilHealthy(seconds = 120) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const health = tried("curl -fsS http://127.0.0.1:8787/api/health");
    if (health.status === 0)
      return JSON.parse(health.out) as { ok: boolean; managed: boolean; workspace: string };
    await sleep(500);
  }
  throw new Error(`The workspace did not answer in ${seconds}s`);
}

const token = (over: { workspace?: string } = {}) =>
  signWorkspaceToken(keys.privateKey, {
    workspaceId: over.workspace ?? workspaceId,
    sub: "acct_ada",
    email: "ada@example.com",
    name: "Ada",
    role: "owner",
  });
const signIn = (value: string) =>
  api("/api/auth/managed", { method: "POST", body: { token: value } });

/** A machine that runs systemd, with the bake folder mounted in it. */
function boot(name: string, image: string, mounts: string[] = []) {
  docker([
    "run",
    "--detach",
    "--name",
    name,
    "--privileged",
    "--network",
    "none",
    "--cgroupns=host",
    "--volume",
    "/sys/fs/cgroup:/sys/fs/cgroup:rw",
    "--tmpfs",
    "/run:mode=755",
    "--tmpfs",
    "/run/lock",
    ...mounts.flatMap((mount) => ["--volume", mount]),
    image,
    "/sbin/init",
  ]);
}
async function untilSystemdIsUp(name: string) {
  for (let i = 0; i < 60; i++) {
    const state = spawnSync("docker", ["exec", name, "systemctl", "is-system-running"], {
      encoding: "utf8",
    }).stdout.trim();
    if (state === "running" || state === "degraded") return;
    await sleep(500);
  }
  throw new Error(`systemd did not come up in ${name}`);
}

try {
  // The workspace to put on the machine: the container image the project builds.
  let image = process.env.HIVE_IMAGE;
  if (!image) {
    image = "hive-workspace:vm-test";
    step(`Building ${image}`);
    execFileSync(
      "docker",
      ["build", ...buildArgs, "-f", "apps/workspace/Dockerfile", "-t", image, "."],
      { cwd: root, stdio: "inherit" },
    );
  }

  // The scripts the image is made with, on their own, as do-image.ts sends them to a Droplet.
  const bake = join(work, "bake");
  mkdirSync(bake);
  cpSync(join(root, "apps/workspace/vm"), bake, { recursive: true });

  step("A machine like the one DigitalOcean gives: Ubuntu 24.04 with systemd, ssh and cloud-init");
  execFileSync("docker", ["build", ...buildArgs, "-t", IMAGES.base, "-"], {
    input: [
      "FROM ubuntu:24.04",
      "ENV DEBIAN_FRONTEND=noninteractive",
      "RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus openssh-server cloud-init iproute2 kmod procps ca-certificates curl && rm -rf /var/lib/apt/lists/*",
      "STOPSIGNAL SIGRTMIN+3",
      'CMD ["/sbin/init"]',
    ].join("\n"),
    stdio: ["pipe", "inherit", "inherit"],
  });

  step("prepare: the packages (this one needs the network)");
  docker([
    "run",
    "--name",
    baking,
    ...hostNetwork,
    "--volume",
    `${bake}:/opt/hive-bake:ro`,
    IMAGES.base,
    "bash",
    "/opt/hive-bake/bake.sh",
    "prepare",
  ]);
  docker(["commit", baking, IMAGES.prepared]);
  docker(["rm", baking]);

  step("fetch: the workspace, out of its image");
  execFileSync("bash", [join(bake, "bake.sh"), "fetch"], {
    env: { ...process.env, HIVE_WORKSPACE_IMAGE: image, HIVE_BAKE_DIR: bake },
    stdio: "inherit",
  });

  step(
    "install and seal: the machine is set up, a workspace is started once, and it is switched off",
  );
  boot(baking, IMAGES.prepared, [`${bake}:/opt/hive-bake:ro`]);
  await untilSystemdIsUp(baking);
  const keep = ["exec", "--env", "HIVE_BAKE_KEEP=1", baking, "bash", "/opt/hive-bake/bake.sh"];
  docker([...keep, "install"]);
  // The machine switches itself off at the end, which takes the exec with it.
  spawnSync("docker", [...keep, "seal"], { stdio: "inherit" });
  docker(["wait", baking]);
  docker(["commit", baking, IMAGES.snapshot]);
  docker(["rm", baking]);

  step("A new machine from that image, before it has been given its settings");
  boot(machine, IMAGES.snapshot);
  await untilSystemdIsUp(machine);
  assert.equal(inside("systemctl is-enabled hive-workspace.service"), "enabled");
  const waiting = tried("systemctl is-active hive-workspace.service");
  assert.equal(waiting.out, "inactive", "it started without settings");
  assert.match(inside("nft list ruleset"), /table inet hive/);
  assert.match(inside("cat /etc/hive/image.json"), /"baked":/);
  assert.equal(tried("ls /etc/ssh/ssh_host_* 2>&1").status, 2, "it kept the image's host keys");
  assert.equal(tried("command -v docker").status, 1, "docker was left on the machine");
  assert.equal(inside("id -u hive"), "10001");
  assert.equal(inside("ls /data | wc -l"), "0");

  step("Its settings arrive, as cloud-init writes them, and the service starts");
  const settings = workspaceSettings(
    {
      workspaceId,
      name: "Test",
      plan: plans.team,
      controlPublicKey: keys.publicKey,
      allowedOrigins: ["https://hive.example.test"],
    },
    `https://${workspaceId}.ws.example.test`,
    { MODEL: "anthropic/test-model", ANTHROPIC_API_KEY: "provider-key-for-the-agent" },
  );
  inside(
    "umask 077 && cat > /etc/hive/workspace.json && systemctl start --no-block hive-workspace.service",
    undefined,
    JSON.stringify(settings),
  );
  const started = Date.now();
  const health = await untilHealthy();
  console.log(`Answered after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  assert.deepEqual(
    { ok: health.ok, managed: health.managed, workspace: health.workspace },
    { ok: true, managed: true, workspace: workspaceId },
  );

  // It signs in the people a control plane vouches for, each token once, and only for this workspace.
  const first = signIn(token());
  assert.equal(first.status, 200);
  const { token: session } = first.json as { token: string };
  assert.equal(signIn(token({ workspace: "w2xyz" })).status, 401);

  // Nothing of the workspace's runs as root, and its settings can be read by root alone.
  const running = inside("ps -eo user:20,args | grep -E 'dist/apps|opencode serve' | grep -v grep")
    .split("\n")
    .map((line) => line.trim().split(/\s+/));
  assert.ok(running.length >= 3, `expected the supervisor, the agent and the server: ${running}`);
  for (const [user, ...command] of running) assert.equal(user, "hive", command.join(" "));
  assert.equal(inside("stat -c '%a %U' /etc/hive/workspace.json"), "600 root");
  const unreadable = tried("cat /etc/hive/workspace.json", "10001");
  assert.notEqual(unreadable.status, 0);
  assert.match(unreadable.out, /Permission denied/);
  assert.doesNotMatch(unreadable.out, /provider-key-for-the-agent/);
  assert.equal(
    inside("stat -c '%a %U' /data /data/secrets.json").replace("\n", " | "),
    "755 hive | 600 hive",
  );

  // The agent has its model's key and a place to keep its sessions, and not the server's secrets.
  const agent = inside(
    "tr '\\0' '\\n' < /proc/$(pgrep -f 'opencode serve' | head -1)/environ",
  ).split("\n");
  assert.ok(agent.includes("ANTHROPIC_API_KEY=provider-key-for-the-agent"));
  assert.ok(agent.includes("HOME=/home/hive"));
  assert.ok(agent.includes("XDG_DATA_HOME=/data/opencode/data"));
  assert.ok(!agent.some((line) => /^(TOKEN_ENCRYPTION_KEY|HIVE_ENV_FILE)=/.test(line)));

  // Something to find again after a reboot: in the workspace, in the agent's home, and on the system.
  const made = api("/api/agent/channels", {
    method: "POST",
    token: session,
    body: { name: "kept-across-reboots" },
  });
  assert.equal(made.status, 201);
  inside("echo kept > /home/hive/kept.txt && chown hive:hive /home/hive/kept.txt");
  inside("echo kept > /usr/local/bin/installed-by-an-administrator");
  const secrets = inside("sha256sum /data/secrets.json");

  if (tried("ip netns add probe").status === 0) {
    step("The firewall");
    inside(`
      set -e
      ip link add v0 type veth peer name v1
      ip link set v1 netns probe
      ip addr add 10.116.0.2/24 dev v0
      ip addr add 169.254.169.1/24 dev v0
      ip link set v0 up
      ip netns exec probe ip addr add 10.116.0.3/24 dev v1
      ip netns exec probe ip addr add 169.254.169.254/24 dev v1
      ip netns exec probe ip link set v1 up
      ip link add w0 type veth peer name w1
      ip link set w1 netns probe
      ip addr add 203.0.113.2/24 dev w0
      ip link set w0 up
      ip netns exec probe ip addr add 203.0.113.3/24 dev w1
      ip netns exec probe ip link set w1 up
      for address in 10.116.0.3 169.254.169.254 203.0.113.3; do
        ip netns exec probe nohup python3 -m http.server 9000 --bind $address >/dev/null 2>&1 &
      done
      nohup python3 -m http.server 9001 --bind 0.0.0.0 >/dev/null 2>&1 &
      sleep 1
    `);
    const get = (address: string, user?: string) =>
      tried(
        `${user ? "setpriv --reuid 10001 --regid 10001 --clear-groups " : ""}curl -sS -m 5 -o /dev/null -w '%{http_code}' http://${address}:9000/`,
      ).out;
    // The machine itself can reach everything; what the workspace's user runs, only the internet.
    for (const address of ["10.116.0.3", "169.254.169.254", "203.0.113.3"])
      assert.equal(get(address), "200", `root to ${address}`);
    const before = Date.now();
    for (const address of ["10.116.0.3", "169.254.169.254"])
      assert.doesNotMatch(get(address, "hive"), /^200/, `the workspace's user reached ${address}`);
    assert.ok(Date.now() - before < 4000, "refusing the agent took as long as a timeout");
    assert.equal(get("203.0.113.3", "hive"), "200");
    // From outside, the workspace's port answers and nothing else the machine happens to listen on.
    assert.equal(
      tried(
        "ip netns exec probe curl -sS -m 3 -o /dev/null -w '%{http_code}' http://10.116.0.2:8787/api/health",
      ).out,
      "200",
    );
    assert.notEqual(
      tried(
        "ip netns exec probe curl -sS -m 3 -o /dev/null -w '%{http_code}' http://10.116.0.2:9001/",
      ).out,
      "200",
    );
    tried("pkill -f 'http.server'; ip netns del probe; ip link del v0; ip link del w0");
  } else {
    console.log("\nThe firewall was not checked: this Docker does not allow network namespaces.");
  }

  step("A reboot: the workspace comes back by itself, with what was in it");
  docker(["restart", "--time", "60", machine]);
  const restarted = Date.now();
  await untilHealthy();
  console.log(`Answered after ${((Date.now() - restarted) / 1000).toFixed(1)}s`);
  assert.equal(inside("sha256sum /data/secrets.json"), secrets);
  assert.equal(
    inside("cat /home/hive/kept.txt /usr/local/bin/installed-by-an-administrator"),
    "kept\nkept",
  );
  const again = signIn(token());
  assert.equal(again.status, 200);
  const channels = api("/api/agent/channels", {
    token: (again.json as { token: string }).token,
  }).json as { name: string }[];
  assert.ok(
    channels.some((channel) => channel.name === "kept-across-reboots"),
    JSON.stringify(channels),
  );
  // The session from before the reboot is still good: sessions are kept on the disk too.
  assert.equal(api("/api/agent/channels", { token: session }).status, 200);

  step("Stopping: the server first, then the agent, and nothing left");
  inside(
    "setpriv --reuid 10001 --regid 10001 --clear-groups bash -c 'nohup sleep 1000 >/dev/null 2>&1 &'",
  );
  const stopping = Date.now();
  inside("systemctl stop hive-workspace.service");
  console.log(`Stopped after ${((Date.now() - stopping) / 1000).toFixed(1)}s`);
  assert.equal(inside("systemctl show -p Result --value hive-workspace.service"), "success");
  const log = inside("journalctl -u hive-workspace.service --no-pager -o cat -n 40");
  const last = log.slice(log.lastIndexOf("stopping: SIGTERM"));
  assert.ok(
    last.indexOf("hive exited") !== -1 &&
      last.indexOf("hive exited") < last.indexOf("opencode exited"),
    last,
  );

  console.log("\nThe workspace machine image is sound");
} catch (error) {
  try {
    console.error(inside("journalctl -u hive-workspace.service --no-pager -o cat -n 40"));
  } catch {}
  throw error;
} finally {
  for (const name of [machine, baking])
    spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
  if (!process.env.KEEP_IMAGES)
    for (const image of Object.values(IMAGES))
      spawnSync("docker", ["image", "rm", "--force", image], { stdio: "ignore" });
  rmSync(work, { recursive: true, force: true });
}
