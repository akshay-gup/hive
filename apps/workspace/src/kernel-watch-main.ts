import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { kernelRoots } from "../../server/src/agent-watch/classify.ts";
import { KernelWatcher } from "./kernel-watch.ts";
import { withEnvFile } from "./supervisor.ts";

// Runs as root on a machine of its own (see apps/workspace/vm/hive-watch.service).
const env = withEnvFile(process.env);
const volume = env.VOLUME_DIR ?? "/data";
const dataDir = env.DATA_DIR?.trim() || join(volume, "hive");
const dir = process.env.HIVE_WATCH_DIR ?? "/run/hive-watch";
mkdirSync(dir, { recursive: true });

const watcher = new KernelWatcher({
  ctl: (args) => execFileSync("auditctl", args, { encoding: "utf8", timeout: 10_000 }),
  dir,
  roots: kernelRoots(dataDir),
  serverPidFile: process.env.HIVE_SERVER_PID ?? "/run/hive/server.pid",
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
console.log(`[kernel-watch] watching ${kernelRoots(dataDir).join(", ")}`);
