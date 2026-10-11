import { chownSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  agentEnv,
  loadSecrets,
  OPENCODE_HOST,
  OPENCODE_PORT,
  OPENCODE_URL,
  Supervisor,
  serverEnv,
  withEnvFile,
} from "./supervisor.ts";

// Read before root is given up: a workspace on a machine of its own is set up by a file only root can read.
const env = withEnvFile(process.env);
const volumeDir = env.VOLUME_DIR ?? "/data";

// A new machine mounts its volume owned by root. It starts as root only to hand the volume to the
// workspace's own user, then becomes that user, so everything it runs, the agent included, is not root.
if (process.getuid?.() === 0) {
  const uid = Number(env.WORKSPACE_UID ?? 10001);
  const gid = Number(env.WORKSPACE_GID ?? 10001);
  mkdirSync(volumeDir, { recursive: true });
  chownSync(volumeDir, uid, gid);
  process.setgroups?.([gid]);
  process.setgid?.(gid);
  process.setuid?.(uid);
}

const home = env.WORKSPACE_HOME?.trim() || undefined;
const secrets = loadSecrets(volumeDir);
const password = secrets.opencodePassword;

const supervisor = new Supervisor({
  agent: {
    name: "opencode",
    command: ["opencode", "serve", "--hostname", OPENCODE_HOST, "--port", String(OPENCODE_PORT)],
    env: agentEnv(env, secrets, volumeDir, home),
    cwd: volumeDir,
    healthUrl: `${OPENCODE_URL}/global/health`,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  },
  server: {
    name: "hive",
    command: [
      process.execPath,
      fileURLToPath(new URL("../../server/src/index.js", import.meta.url)),
    ],
    env: serverEnv(env, secrets, home),
  },
  healthTimeoutMs: 90_000,
  graceMs: 25_000,
  log: (line) => process.stdout.write(`${line}\n`),
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => supervisor.stop(signal));

process.exit(await supervisor.run());
