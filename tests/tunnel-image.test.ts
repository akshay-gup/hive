import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cloudConfig } from "../apps/control/src/digitalocean.ts";

const vm = (name: string) =>
  readFileSync(new URL(`../apps/workspace/vm/${name}`, import.meta.url), "utf8");

test("what the control plane writes at first boot is what the tunnel's unit reads and starts", () => {
  const unit = vm("hive-tunnel.service");
  const config = cloudConfig({ A: "b" }, { tunnelToken: "a-token" });

  // The file the token is in, and the service started, are the ones the image has.
  assert.match(
    config,
    /path: \/etc\/hive\/tunnel-token\n {4}owner: root:root\n {4}permissions: "0600"/,
  );
  assert.match(config, /\[systemctl, start, --no-block, hive-tunnel\.service\]/);
  assert.match(unit, /^ConditionPathExists=\/etc\/hive\/tunnel-token$/m);
  assert.match(unit, /^LoadCredential=tunnel-token:\/etc\/hive\/tunnel-token$/m);

  // A machine given no token starts no tunnel and writes no file for one.
  const without = cloudConfig({ A: "b" });
  assert.equal(without.includes("tunnel"), false);
});

test("the tunnel's token is read from a file and never put on a command line", () => {
  const unit = vm("hive-tunnel.service");
  const start = /^ExecStart=(.*)$/m.exec(unit)?.[1] ?? "";
  assert.match(start, /\btunnel run --token-file %d\/tunnel-token$/);
  // `--token <value>` would show in the process list to everyone on the machine.
  assert.doesNotMatch(start, /--token(?!-file)/);
  // The connector is not the workspace's user, and cannot be given more than it has.
  assert.match(unit, /^DynamicUser=yes$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
});

test("the image installs cloudflared from a pinned, checked package, and enables the unit", () => {
  const script = vm("bake.sh");
  const version = /^CLOUDFLARED_VERSION=\$\{HIVE_CLOUDFLARED_VERSION:-(\d{4}\.\d+\.\d+)\}$/m.exec(
    script,
  );
  const sha = /^CLOUDFLARED_SHA256=\$\{HIVE_CLOUDFLARED_SHA256:-([0-9a-f]{64})\}$/m.exec(script);
  assert.ok(version, "a version is pinned");
  assert.ok(sha, "a checksum is pinned");
  // Checked before it is installed.
  const check = script.indexOf("sha256sum --check --strict -");
  const install = script.indexOf('apt install -y --no-install-recommends "$deb"');
  assert.ok(check > 0 && install > check, "the package is checked before it is installed");
  assert.ok(script.includes('"$HERE/hive-tunnel.service"'));
  assert.ok(script.includes("systemctl enable hive-tunnel.service"));
  assert.ok(script.includes("cloudflared --version"));
});
