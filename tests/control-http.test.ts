import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { retryingFetch, waitUntilAnswering } from "../apps/control/src/http.ts";
import { ProvisionError } from "../apps/control/src/provisioner.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, call: number) => void;
const servers: ReturnType<typeof createServer>[] = [];

async function serve(handler: Handler) {
  let calls = 0;
  const server = createServer((req, res) => handler(req, res, ++calls));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls: () => calls,
  };
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

test("a busy or failing service is tried again, and the answer that finally comes is returned", async () => {
  const api = await serve((_req, res, call) => {
    res.writeHead(call < 3 ? 503 : 200).end("{}");
  });
  const response = await retryingFetch(api.url, {}, 5);
  assert.equal(response.status, 200);
  assert.equal(api.calls(), 3);
});

test("a request that is refused for good is not tried again", async () => {
  const api = await serve((_req, res) => {
    res.writeHead(403).end("no");
  });
  assert.equal((await retryingFetch(api.url, {}, 5)).status, 403);
  assert.equal(api.calls(), 1);
});

test("a service that keeps failing gets four tries and its last answer is handed back", async () => {
  const api = await serve((_req, res, call) => {
    res.writeHead(502).end(`answer ${call}`);
  });
  const started = Date.now();
  const response = await retryingFetch(api.url, {}, 5);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "answer 4");
  assert.equal(api.calls(), 4);
  // The pauses are 5, 10 and 20 ms: none after the last try.
  assert.ok(Date.now() - started < 1000);
});

test("a service that says when its limit resets is waited for until then", async () => {
  const api = await serve((_req, res, call) => {
    if (call === 1) {
      // DigitalOcean sends the reset as a Unix time in seconds.
      res.writeHead(429, { "RateLimit-Reset": String(Date.now() / 1000 + 0.3) }).end("slow down");
    } else res.writeHead(200).end("{}");
  });
  const started = Date.now();
  assert.equal((await retryingFetch(api.url, {}, 5)).status, 200);
  assert.ok(Date.now() - started >= 250, "it waited for the reset, not the 5 ms default");
  assert.equal(api.calls(), 2);
});

test("a reset time that has already passed is not waited for", async () => {
  const api = await serve((_req, res, call) => {
    if (call === 1) res.writeHead(429, { "RateLimit-Reset": "1000000000" }).end("");
    else res.writeHead(200).end("{}");
  });
  const started = Date.now();
  assert.equal((await retryingFetch(api.url, {}, 5)).status, 200);
  assert.ok(Date.now() - started < 500);
});

test("a connection that cannot be made is tried again, then the error is raised", async () => {
  const api = await serve((_req, res) => res.end());
  const closed = api.url;
  await new Promise((resolve) => servers[0]?.close(resolve));
  await assert.rejects(retryingFetch(closed, {}, 5));
});

test("waiting for a workspace ends when its health check names it", async () => {
  const api = await serve((req, res, call) => {
    assert.equal(req.url, "/api/health");
    if (call < 3) return void res.writeHead(502).end("");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, workspace: "w1" }));
  });
  await waitUntilAnswering(api.url, "w1", { waitSeconds: 5, pollMs: 10 });
  assert.equal(api.calls(), 3);
});

test("a workspace that answers as another one is not the one waited for", async () => {
  const api = await serve((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, workspace: "someone-else" }));
  });
  await assert.rejects(
    waitUntilAnswering(api.url, "w1", { waitSeconds: 1, pollMs: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof ProvisionError);
      assert.match(error.message, /different workspace/);
      assert.match(error.userMessage, /Try again/);
      return true;
    },
  );
});

test("one that never answers fails with what it last said", async () => {
  const api = await serve((_req, res) => {
    res.writeHead(503).end("");
  });
  await assert.rejects(
    waitUntilAnswering(api.url, "w1", { waitSeconds: 1, pollMs: 10 }),
    /did not answer in 1s \(status 503\)/,
  );
});

const answer = (res: ServerResponse, body: object) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, workspace: "w1", ...body }));
};

test("a machine that has not taken up its build is waited for, and then let in once it has", async () => {
  const api = await serve((_req, res, call) =>
    answer(res, { version: call < 3 ? "sha-old" : "sha-new" }),
  );
  await waitUntilAnswering(api.url, "w1", { waitSeconds: 5, pollMs: 10, build: "sha-new" });
  assert.equal(api.calls(), 3);
});

test("a machine whose update failed is let in on the build it has", async () => {
  const api = await serve((_req, res) =>
    answer(res, { version: "sha-old", update: { state: "failed" } }),
  );
  await waitUntilAnswering(api.url, "w1", { waitSeconds: 5, pollMs: 10, build: "sha-new" });
  assert.equal(api.calls(), 1);
});

test("one that stays on another build fails with which", async () => {
  const api = await serve((_req, res) => answer(res, { version: "sha-old" }));
  await assert.rejects(
    waitUntilAnswering(api.url, "w1", { waitSeconds: 1, pollMs: 10, build: "sha-new" }),
    /still on sha-old, updating to sha-new/,
  );
});

test("its agent is waited for a short while and then let go, so a chat service that is down keeps no one out", async () => {
  const connecting = await serve((_req, res, call) =>
    answer(res, { version: "sha-new", chatRunner: { connected: call >= 3 } }),
  );
  await waitUntilAnswering(connecting.url, "w1", {
    waitSeconds: 5,
    pollMs: 10,
    build: "sha-new",
    agentSeconds: 2,
  });
  assert.equal(connecting.calls(), 3);
  const down = await serve((_req, res) =>
    answer(res, { version: "sha-new", chatRunner: { connected: false } }),
  );
  const started = Date.now();
  await waitUntilAnswering(down.url, "w1", {
    waitSeconds: 5,
    pollMs: 10,
    build: "sha-new",
    agentSeconds: 0.2,
  });
  assert.ok(Date.now() - started < 2000);
});
