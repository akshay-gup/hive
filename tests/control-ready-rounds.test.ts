import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { waitUntilAnswering } from "../apps/control/src/http.ts";
import { ProvisionError } from "../apps/control/src/provisioner.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const health = (body: object) =>
  new Response(JSON.stringify({ ok: true, workspace: "w1", ...body }), { status: 200 });

test("a wait that runs out of checks says the machine is still starting, and asks nothing more", async () => {
  let asked = 0;
  globalThis.fetch = (async () => {
    asked++;
    return health({ version: "sha-old" });
  }) as typeof fetch;
  await assert.rejects(
    waitUntilAnswering("https://w1.example.test", "w1", {
      waitSeconds: 60,
      pollMs: 1,
      build: "sha-new",
      maxChecks: 5,
    }),
    (error) => {
      assert.ok(error instanceof ProvisionError);
      assert.equal(error.starting, true);
      assert.match(error.message, /still on sha-old, updating to sha-new/);
      return true;
    },
  );
  assert.equal(asked, 5);
});

test("a machine that answers within the checks is ready, and one whose agent is not yet there is let in on the last", async () => {
  globalThis.fetch = (async () => health({ version: "sha-new" })) as typeof fetch;
  await waitUntilAnswering("https://w1.example.test", "w1", {
    waitSeconds: 60,
    pollMs: 1,
    build: "sha-new",
    maxChecks: 5,
  });
  let asked = 0;
  globalThis.fetch = (async () => {
    asked++;
    return health({ version: "sha-new", chatRunner: { connected: false } });
  }) as typeof fetch;
  await waitUntilAnswering("https://w1.example.test", "w1", {
    waitSeconds: 60,
    pollMs: 1,
    build: "sha-new",
    maxChecks: 4,
  });
  assert.equal(asked, 4);
});
