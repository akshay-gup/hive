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

test("the image carries the browser worker and the scripts that keep a machine up to date", () => {
  assert.match(dockerfile, /^COPY --from=browser \/browser-worker \.\/browser-worker$/m);
  assert.match(dockerfile, /hive-ensure \/src\/apps\/workspace\/vm\/hive-sandbox \.\/machine\/$/m);
  assert.match(dockerfile, /^COPY --from=build \/src\/apps\/workspace\/vm\/hive-update /m);
  const vm = (name: string) =>
    readFileSync(new URL(`../apps/workspace/vm/${name}`, import.meta.url), "utf8");
  // A new machine and an updated one get Chromium from the same script, so they cannot differ.
  assert.match(vm("bake.sh"), /\/app\/machine\/hive-ensure/);
  // The browser comes from the Playwright in the image, so the two cannot be different versions.
  assert.match(vm("hive-ensure"), /browser-worker\/node_modules\/playwright\/cli\.js/);
  assert.match(vm("hive-ensure"), /install --with-deps/);
  // It is started once before a snapshot is taken, so an image whose browser cannot start is not kept.
  assert.match(vm("bake.sh"), /chromium\.launch/);
  // The updater has a fallback to go back to, and the bake puts both on the machine.
  assert.match(vm("hive-update.service"), /^OnFailure=hive-update-fallback\.service$/m);
  assert.match(vm("bake.sh"), /hive-update\.good/);
  // The workspace's own programs run from a copy of node that cannot be read, on a new machine and an updated one.
  assert.match(vm("bake.sh"), /install -m 0711 "\$PAYLOAD\/node" \/usr\/local\/libexec\/hive-node/);
  assert.match(vm("hive-ensure"), /install -m 0711 "\$NODE"/);
  const worker = JSON.parse(
    readFileSync(new URL("../apps/worker/package.json", import.meta.url), "utf8"),
  );
  assert.match(worker.dependencies.playwright, /^\d+\.\d+\.\d+$/, "an exact version, not a range");
});
