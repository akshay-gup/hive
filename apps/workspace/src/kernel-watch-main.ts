import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { kernelRoots, realOrSelf } from "../../server/src/agent-watch/classify.ts";
import { KernelWatcher } from "./kernel-watch.ts";
import { withEnvFile } from "./supervisor.ts";

// Runs as root on a machine of its own (see apps/workspace/vm/hive-watch.service).
const env = withEnvFile(process.env);
const volume = env.VOLUME_DIR ?? "/data";
const dataDir = env.DATA_DIR?.trim() || join(volume, "hive");
const dir = process.env.HIVE_WATCH_DIR ?? "/run/hive-watch";
mkdirSync(dir, { recursive: true });

const run = process.env.HIVE_RUN ?? "/run/hive";
const etc = process.env.HIVE_ETC ?? "/etc/hive";
const roots = kernelRoots(dataDir, etc);

const watcher = new KernelWatcher({
  ctl: (args) => execFileSync("auditctl", args, { encoding: "utf8", timeout: 10_000 }),
  dir,
  roots,
  serverPidFile: process.env.HIVE_SERVER_PID ?? join(run, "server.pid"),
  trustedPidFiles: [join(run, "supervisor.pid")],
  agentPidFile: join(run, "agent.pid"),
  ownersRoot: join(realOrSelf(resolve(dataDir)), "owners"),
  auditLog: process.env.HIVE_AUDIT_LOG ?? "/var/log/audit/audit.log",
  log: (line) => console.log(line),
});

setInterval(() => {
  try {
    watcher.tick();
  } catch (error) {
    console.log(`[kernel-watch] ${String(error)}`);
  }
}, 100);
console.log(`[kernel-watch] watching ${roots.join(", ")}`);
