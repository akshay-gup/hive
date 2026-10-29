import { chownSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { noteStayedUp, startWith, waitIdle, watchSettings } from "./remote-settings.ts";
import {
  agentEnv,
  BROWSER_INTERNAL_PORT,
  BROWSER_PORT,
  browserEnv,
  loadBrowserToken,
  loadSecrets,
  OPENCODE_HOST,
  OPENCODE_PORT,
  OPENCODE_URL,
  Supervisor,
  serverEnv,
  withEnvFile,
} from "./supervisor.ts";

const runDir = process.env.HIVE_RUN ?? "/run/hive";
// The kernel watch, which notes who reads the machine's secrets, is told this process reads them at start and may.
try {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "supervisor.pid"), String(process.pid));
  process.on("exit", () => rmSync(join(runDir, "supervisor.pid"), { force: true }));
} catch {
  // Not a machine with one: nothing watches from outside.
}
// Read before root is given up: a workspace on a machine of its own is set up by a file only root can read.
// What it was made with is laid under what the control plane says its settings are now (see remote-settings.ts).
const made = withEnvFile(process.env);
const volumeDir = made.VOLUME_DIR ?? "/data";
const started = await startWith(made, {
  etc: process.env.HIVE_ETC ?? "/etc/hive",
  state: process.env.HIVE_STATE ?? "/var/lib/hive",
  volume: volumeDir,
});
const env = started.env;

// A new machine mounts its volume owned by root. It starts as root only to hand the volume to the
// workspace's own user, then becomes that user, so what it starts, the agent included, is not root
// (on a machine of its own the agent may still use sudo).
if (process.getuid?.() === 0) {
  const uid = Number(env.WORKSPACE_UID ?? 10001);
  const gid = Number(env.WORKSPACE_GID ?? 10001);
  mkdirSync(volumeDir, { recursive: true });
  chownSync(volumeDir, uid, gid);
  // Where the server's process id is written for the kernel watch, which runs as root and reads it.
  try {
    mkdirSync(runDir, { recursive: true });
    chownSync(runDir, uid, gid);
  } catch {
    // Not a machine with one: nothing watches from outside.
  }
  process.setgroups?.([gid]);
  process.setgid?.(gid);
  process.setuid?.(uid);
}

const home = env.WORKSPACE_HOME?.trim() || undefined;
const secrets = loadSecrets(volumeDir);
const password = secrets.opencodePassword;
// The browser is the workspace's own unless the machine's settings point at another, or it was not put on this image.
const browserDir = fileURLToPath(new URL("../../../../browser-worker/", import.meta.url));
const ownBrowser =
  !env.BROWSER_WORKER_URL?.trim() && env.HIVE_BROWSER !== "off" && existsSync(browserDir);
const browserToken = ownBrowser ? loadBrowserToken(volumeDir) : undefined;

const supervisor = new Supervisor({
  agent: {
    name: "opencode",
    pidFile: join(runDir, "agent.pid"),
    command: ["opencode", "serve", "--hostname", OPENCODE_HOST, "--port", String(OPENCODE_PORT)],
    env: agentEnv(env, secrets, volumeDir, home),
    cwd: volumeDir,
    healthUrl: `${OPENCODE_URL}/global/health`,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  },
  server: {
    name: "hive",
    pidFile: join(runDir, "server.pid"),
    command: [
      process.execPath,
      fileURLToPath(new URL("../../server/src/index.js", import.meta.url)),
    ],
    env: serverEnv(
      env,
      secrets,
      home,
      browserToken,
      // The agent's machine connects to the chat service with a token the control plane gives it for this workspace's key.
      started.where
        ? {
            tokenUrl: started.where.url.replace(/\/config$/, "/runner-token"),
            key: started.where.key,
          }
        : undefined,
    ),
  },
  browser: browserToken
    ? {
        name: "browser",
        command: [process.execPath, "--experimental-strip-types", "src/index.ts"],
        cwd: browserDir,
        listenPort: BROWSER_PORT,
        internalPort: BROWSER_INTERNAL_PORT,
        // Only what it needs: none of the machine's settings, so no provider keys.
        env: browserEnv(env, browserToken, volumeDir, home),
      }
    : undefined,
  healthTimeoutMs: 90_000,
  graceMs: 25_000,
  log: (line) => process.stdout.write(`${line}\n`),
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => supervisor.stop(signal));

// Settings are read at start, so taking new ones is a restart, which the service manager does once this stops.
const STAYED_UP_MS = 45_000;
if (started.rev) {
  const rev = started.rev;
  setTimeout(() => noteStayedUp(volumeDir, rev), STAYED_UP_MS).unref();
}
if (started.where)
  watchSettings(started.where, started.seen, async (rev) => {
    process.stdout.write(
      `settings ${rev} from the control plane; waiting for no run to be going\n`,
    );
    // Runs in progress finish first (the server counts one waiting for an answer), for up to half an hour.
    const idle = await waitIdle(join(env.DATA_DIR?.trim() || join(volumeDir, "hive"), "runs-live"));
    process.stdout.write(`${idle ? "idle" : "still busy"}; restarting to take settings ${rev}\n`);
    process.kill(process.pid, "SIGTERM");
  });

process.exit(await supervisor.run());
