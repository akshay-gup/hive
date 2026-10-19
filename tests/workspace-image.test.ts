import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dockerfile = readFileSync(new URL("../apps/workspace/Dockerfile", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the image carries the OpenCode the server's SDK is pinned to", () => {
  // The server only checks the major version at boot; the wire protocol is checked against this one.
  const version = /^ARG OPENCODE_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
  assert.equal(version, manifest.dependencies["@opencode-ai/sdk"]);
});

test("the image installs packages with the pnpm the repository is pinned to", () => {
  const pnpm = String(manifest.packageManager).split("@")[1];
  assert.ok(pnpm);
  assert.ok(dockerfile.includes(`pnpm@${pnpm}`), "the Dockerfile installs a different pnpm");
});

test("the image runs the workspace supervisor, behind an init that reaps what the agent leaves", () => {
  assert.match(dockerfile, /^ENTRYPOINT \["tini", "-s", "--"\]$/m);
  assert.match(dockerfile, /^CMD \["node", "dist\/apps\/workspace\/src\/index\.js"\]$/m);
});

test("the image carries the browser worker, and the bake gives the machine the Chromium that matches it", () => {
  assert.match(dockerfile, /^COPY --from=browser \/browser-worker \.\/browser-worker$/m);
  const bake = readFileSync(new URL("../apps/workspace/vm/bake.sh", import.meta.url), "utf8");
  // The browser comes from the Playwright in the image, so the two cannot be different versions.
  assert.match(bake, /browser-worker\/node_modules\/playwright\/cli\.js/);
  assert.match(bake, /install --with-deps/);
  // It is started once before a snapshot is taken, so an image whose browser cannot start is not kept.
  assert.match(bake, /chromium\.launch/);
  const worker = JSON.parse(
    readFileSync(new URL("../apps/worker/package.json", import.meta.url), "utf8"),
  );
  assert.match(worker.dependencies.playwright, /^\d+\.\d+\.\d+$/, "an exact version, not a range");
});
