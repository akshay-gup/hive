import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentNotification, AgentTask, Monitor } from "../packages/domain/src/agent.ts";
import { localBoard } from "./helpers/local-task.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;
const owner = "local-user";
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const request = (path: string, body?: unknown) =>
  server.app.request(`/api/agent${path}`, {
    headers: headers(),
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
async function read<T>(path: string, body?: unknown, status = 200): Promise<T> {
  const response = await request(path, body);
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
type CompareAndSwap = Store["compareAndSwap"];
// Replaces the next tasks CAS that matches `when` with a lost write (null), then restores.
function loseNextTaskWrite(when: (patch: Record<string, unknown>) => boolean) {
  const original: CompareAndSwap = db.compareAndSwap.bind(db);
  let lost = 0;
  db.compareAndSwap = (async (o, kind, id, expected, patch) => {
    if (!lost && kind === "tasks" && when(patch)) {
      lost++;
      return null;
    }
    return original(o, kind, id, expected, patch);
  }) as CompareAndSwap;
  return {
    get lost() {
      return lost;
    },
    restore() {
      db.compareAndSwap = original;
    },
  };
}
async function createMonitor(title: string) {
  return read<Monitor>(
    "/monitors",
    { title, url: "sample://availability", condition: "change", intervalMinutes: 1 },
    201,
  );
}
// Makes the sample page throw until the returned restore() is called.
function failPage() {
  const originalGet = db.get.bind(db);
  db.get = (async (o: string, kind: string, id: string) => {
    if (kind === "sample-pages") throw new Error("Page unavailable");
    return originalGet(o, kind, id);
  }) as Store["get"];
  return () => {
    db.get = originalGet;
  };
}
// Failures back off into the future; make the scheduled retry due now.
const makeDue = (taskId: string) =>
  db.compareAndSwap(
    owner,
    "tasks",
    taskId,
    { status: "scheduled" },
    { nextRunAt: new Date(0).toISOString() },
  );
const maintain = () => (server.agent as unknown as { maintain(): Promise<void> }).maintain();

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-monitor-recovery-"));
  db = await createStore({ dataDir: join(directory, "db") });
  server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  });
  server.agent.board = localBoard(server.agent);
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  token = (await session.json()).token;
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("a page change stays alertable when the task outcome is lost after the baseline moves", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Recovery availability");
  const notifications = async () =>
    (await read<AgentNotification[]>("/notifications")).filter(
      (item) => item.taskId === monitor.taskId,
    );
  await server.agent.worker.tick();
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "scheduled");
  assert.equal((await notifications()).length, 0);

  await read("/sample-page", { text: "One table at 7 pm" });
  await read(`/monitors/${monitor.id}/control`, { action: "check" });
  // The worker's final checkpoint for this run loses its lease after observe() committed
  // the new monitor baseline, as if the process stopped or another worker took over.
  const fault = loseNextTaskWrite(
    (patch) => patch.status === "scheduled" && patch.leaseId === null,
  );
  try {
    await server.agent.worker.tick();
  } finally {
    fault.restore();
  }
  assert.equal(fault.lost, 1);
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "queued");

  // Recovery: the requeued run executes, then a later scheduled check runs as well.
  await server.agent.worker.tick();
  await read(`/monitors/${monitor.id}/control`, { action: "check" });
  await server.agent.worker.tick();

  const found = await notifications();
  assert.equal(found.length, 1, "the No tables -> One table change should notify exactly once");
  assert.match(found[0].body, /One table at 7 pm/);
});

test("the paused alert is delivered when the final failure outcome is lost", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Failing availability");
  await server.agent.worker.tick();
  const restorePage = failPage();
  try {
    for (let failure = 1; failure < 5; failure++) {
      await makeDue(monitor.taskId);
      await server.agent.worker.tick();
      const task = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
      assert.equal(task?.status, "scheduled");
      assert.equal(task?.state.failures, failure);
    }
    await makeDue(monitor.taskId);
    // The fifth failure's paused outcome is lost after the run already recorded the failure.
    const fault = loseNextTaskWrite((patch) => patch.status === "paused" && patch.leaseId === null);
    try {
      await server.agent.worker.tick();
    } finally {
      fault.restore();
    }
    assert.equal(fault.lost, 1);
    assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "queued");
    await server.agent.worker.tick();
  } finally {
    restorePage();
  }

  const task = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
  assert.equal(task?.status, "paused");
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "paused");
  const pausedId = createHash("sha256")
    .update(`watch-error:${monitor.taskId}:1:paused`)
    .digest("hex");
  const paused = (await read<AgentNotification[]>("/notifications")).filter(
    (item) => item.id === pausedId,
  );
  assert.equal(paused.length, 1, "the watch paused alert should be delivered exactly once");

  const resumed = await read<Monitor>(`/monitors/${monitor.id}/control`, { action: "resume" });
  assert.equal(resumed.status, "active");
  assert.equal(resumed.error, null);
  const requeued = await db.get<AgentTask>(owner, "tasks", monitor.taskId);
  assert.equal(requeued?.status, "queued");
  assert.equal(requeued?.state.failures, 0);
  await server.agent.worker.tick();
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "scheduled");
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "active");
});

test("a resume finished by maintenance during the request still succeeds", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Resume with maintenance");
  await server.agent.worker.tick();
  await read(`/monitors/${monitor.id}/control`, { action: "pause" });

  // Maintenance runs right after the request activates the monitor, and queues the task first.
  const originalPut = db.put.bind(db);
  const originalCas: CompareAndSwap = db.compareAndSwap.bind(db);
  let fired = false;
  const afterActivation = async (kind: string, status: unknown) => {
    if (!fired && kind === "monitors" && status === "active") {
      fired = true;
      await maintain();
    }
  };
  db.put = (async (o: string, kind: string, value: { id: string; status?: string }) => {
    const saved = await originalPut(o, kind, value);
    await afterActivation(kind, value.status);
    return saved;
  }) as Store["put"];
  db.compareAndSwap = (async (o, kind, id, expected, patch) => {
    const saved = await originalCas(o, kind, id, expected, patch);
    if (saved) await afterActivation(kind, patch.status);
    return saved;
  }) as CompareAndSwap;
  let response: Response;
  try {
    response = await request(`/monitors/${monitor.id}/control`, { action: "resume" });
  } finally {
    db.put = originalPut;
    db.compareAndSwap = originalCas;
  }
  assert.ok(fired);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "active");
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "queued");
});

test("a stop during a check keeps the watch stopped", async () => {
  await read("/sample-page", { text: "No tables available" });
  const monitor = await createMonitor("Stop during check");
  await server.agent.worker.tick();
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "scheduled");

  // The user stops the watch right before the check reactivates the monitor.
  const originalPut = db.put.bind(db);
  const originalCas: CompareAndSwap = db.compareAndSwap.bind(db);
  let stopping: Response | undefined;
  const beforeActivation = async (kind: string, status: unknown) => {
    if (!stopping && kind === "monitors" && status === "active") {
      db.put = originalPut;
      db.compareAndSwap = originalCas;
      stopping = await request(`/monitors/${monitor.id}/control`, { action: "stop" });
    }
  };
  db.put = (async (o: string, kind: string, value: { id: string; status?: string }) => {
    await beforeActivation(kind, value.status);
    return originalPut(o, kind, value);
  }) as Store["put"];
  db.compareAndSwap = (async (o, kind, id, expected, patch) => {
    await beforeActivation(kind, patch.status);
    return originalCas(o, kind, id, expected, patch);
  }) as CompareAndSwap;
  let response: Response;
  try {
    response = await request(`/monitors/${monitor.id}/control`, { action: "check" });
  } finally {
    db.put = originalPut;
    db.compareAndSwap = originalCas;
  }
  assert.equal(stopping?.status, 200, await stopping?.clone().text());
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await db.get<Monitor>(owner, "monitors", monitor.id))?.status, "stopped");
  assert.equal((await db.get<AgentTask>(owner, "tasks", monitor.taskId))?.status, "cancelled");
});
