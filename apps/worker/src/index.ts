import { createWorkerServer } from "./server.ts";

const positive = (value: string | undefined, fallback: number) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};
const token = process.env.WORKER_TOKEN ?? "";
const worker = await createWorkerServer({
  token,
  dataDir: process.env.WORKER_DATA_DIR ?? ".hive/browser-profiles",
  maxSessions: positive(process.env.WORKER_MAX_SESSIONS, 3),
  idleTimeoutMs: positive(process.env.WORKER_IDLE_MINUTES, 30) * 60_000,
  replaceIdleMs: process.env.WORKER_REPLACE_IDLE_SECONDS
    ? positive(process.env.WORKER_REPLACE_IDLE_SECONDS, 60) * 1000
    : undefined,
});
worker.server.listen(
  positive(process.env.WORKER_PORT, 8790),
  process.env.WORKER_HOST ?? "127.0.0.1",
  () => {
    console.log("Hive browser worker listening on port 8790");
  },
);
let stopping = false;
// A worker that was started for one job leaves when the job is done: with no browser open and no
// request for a while it only holds memory. Whatever starts it starts it again when it is wanted.
const exitAfterMs = positive(process.env.WORKER_EXIT_IDLE_SECONDS, 0) * 1000;
if (exitAfterMs) {
  let lastRequest = Date.now();
  worker.server.on("request", (request) => {
    if (request.url !== "/health") lastRequest = Date.now();
  });
  setInterval(
    () => {
      if (worker.openSessions() === 0 && Date.now() - lastRequest > exitAfterMs) void stop();
    },
    Math.min(15_000, exitAfterMs),
  ).unref();
}
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 30_000);
  deadline.unref();
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
