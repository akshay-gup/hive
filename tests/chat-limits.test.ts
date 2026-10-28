import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ChatMessage } from "../packages/domain/src/chat.ts";
import { chatWorld } from "./helpers/chat-world.ts";

const people = {
  max: { id: "max", email: "max@example.com", name: "Max", role: "member" },
  ada: { id: "ada", email: "ada@example.com", name: "Ada", role: "admin" },
} as const;

test("the 100-task cap covers concurrent creation and every way of reopening work", async () => {
  const { core, call, ok } = await chatWorld(people);
  const make = (title: string) => core.work.createTask("max", { kind: "manual", title });
  const done = await make("Done");
  const failed = await make("Failed");
  const agent = await core.work.createTask("max", { kind: "agent", prompt: "Try again" });
  core.tasks.change(done.id, { status: "succeeded" });
  core.tasks.change(failed.id, { status: "failed" });
  core.tasks.change(agent.id, { status: "cancelled" });
  const keyed = await core.work.createTask(
    "max",
    { kind: "manual", title: "Once" },
    { key: "once" },
  );
  for (let i = 1; i < 98; i++) await make(`Open ${i}`);
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      call("max", "POST", "/v1/tasks", { kind: "manual", title: `Race ${i}` }),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === 201).length, 2);
  assert.equal(attempts.filter((r) => r.status === 409).length, 6);
  assert.equal(
    (await core.work.createTask("max", { kind: "manual", title: "Once" }, { key: "once" })).id,
    keyed.id,
    "an idempotent repeat consumes no slot",
  );
  const refused: ["max" | "ada", string, string, object][] = [
    ["max", "PATCH", `/v1/tasks/${done.id}`, { status: "queued" }],
    ["ada", "PATCH", `/v1/tasks/${done.id}`, { status: "paused" }],
    ["max", "POST", `/v1/tasks/${failed.id}/control`, { action: "retry" }],
    ["max", "POST", `/v1/tasks/${agent.id}/notes`, { text: "Again", run: true }],
    ["max", "PATCH", `/v1/tasks/${done.id}`, { assignee: "agent" }],
    ["max", "POST", `/v1/tasks/${done.id}/delegate`, { target: "orchestrator" }],
  ];
  for (const [who, method, path, body] of refused) {
    const response = await call(who, method, path, body);
    assert.equal(response.status, 409, `${method} ${path}: ${await response.clone().text()}`);
  }
  assert.equal(core.tasks.get(done.id)?.status, "succeeded");
  assert.equal(core.tasks.get(failed.id)?.status, "failed");
  assert.equal(core.tasks.get(agent.id)?.notes?.length ?? 0, 0, "a refused note is not saved");
  assert.equal(
    (await call("max", "PATCH", `/v1/tasks/${keyed.id}`, { title: "Edited" })).status,
    200,
  );
  assert.equal(
    (await call("max", "POST", `/v1/tasks/${agent.id}/notes`, { text: "For later" })).status,
    201,
  );
  assert.equal(
    (await call("ada", "POST", "/v1/tasks", { kind: "manual", title: "Ada's work" })).status,
    201,
  );
  await ok(await call("max", "PATCH", `/v1/tasks/${keyed.id}`, { status: "succeeded" }));
  await ok(await call("max", "POST", `/v1/tasks/${failed.id}/control`, { action: "retry" }));
  assert.equal(
    (await call("max", "POST", "/v1/tasks", { kind: "manual", title: "Full again" })).status,
    409,
  );
  await ok(await call("max", "PATCH", `/v1/tasks/${failed.id}`, { status: "failed" }));
  const resumed = await ok<AgentTask>(
    await call("max", "POST", `/v1/tasks/${agent.id}/notes`, { text: "Now", run: true }),
    201,
  );
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.notes?.length, 2);
  await ok(await call("max", "POST", `/v1/tasks/${agent.id}/control`, { action: "cancel" }));
  const reopens = await Promise.all([
    call("max", "PATCH", `/v1/tasks/${keyed.id}`, { status: "queued" }),
    call("max", "POST", `/v1/tasks/${failed.id}/control`, { action: "retry" }),
  ]);
  assert.deepEqual(
    reopens.map((r) => r.status).sort(),
    [200, 409],
    "only one reopening takes the last slot",
  );
});

test("posting and editing agree on the message character limit, including emoji", async () => {
  const { call, ok } = await chatWorld(people);
  const channel = await ok<{ id: string }>(
    await call("max", "POST", "/v1/channels", { name: "Long messages", visibility: "private" }),
    201,
  );
  for (const letter of ["a", "🙂"]) {
    const body = letter.repeat(40_000);
    const made = await ok<ChatMessage>(
      await call("max", "POST", `/v1/channels/${channel.id}/messages`, { body }),
      201,
    );
    assert.equal(made.body, body);
    assert.equal(
      (await call("max", "POST", `/v1/channels/${channel.id}/messages`, { body: body + letter }))
        .status,
      422,
    );
    const edited = await ok<ChatMessage>(
      await call("max", "PATCH", `/v1/messages/${made.id}`, { body }),
    );
    assert.equal(edited.body, body);
    assert.equal(
      (await call("max", "PATCH", `/v1/messages/${made.id}`, { body: body + letter })).status,
      422,
    );
    const page = await ok<{ messages: ChatMessage[] }>(
      await call("max", "GET", `/v1/channels/${channel.id}/messages`),
    );
    assert.equal(
      page.messages.find((m) => m.id === made.id)?.body,
      body,
      "a refused edit leaves the body intact",
    );
  }
});
