import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DigitalOceanApi } from "../apps/control/src/digitalocean-api.ts";
import {
  BakeError,
  type BakeOptions,
  bakeCloudConfig,
  bakeImage,
  chooseBakeSize,
  main,
  shellQuote,
} from "../apps/control/tools/do-image.ts";
import { defaultSizes, fakeDigitalOcean } from "./helpers/fake-do.ts";

let fake: Awaited<ReturnType<typeof fakeDigitalOcean>>;
let lines: string[];
const api = () => new DigitalOceanApi({ token: fake.token, apiUrl: fake.apiUrl, retryMs: 5 });
const options = (over: Partial<BakeOptions> = {}): BakeOptions => ({
  workspaceImage: "ghcr.io/example/hive-workspace:2026-10",
  region: "nyc3",
  name: "hive-workspace-test",
  base: "ubuntu-24-04-x64",
  sshKeys: [],
  bakeMinutes: 1,
  snapshotMinutes: 1,
  pollMs: 20,
  log: (line) => lines.push(line),
  ...over,
});
/** The files a cloud-config puts on the Droplet, by path. */
function filesOf(cloudConfig: string) {
  const files = new Map<string, { mode: string; text: string }>();
  for (const match of cloudConfig.matchAll(
    /- path: (\S+)\n\s+owner: root:root\n\s+permissions: "(\d+)"\n\s+encoding: b64\n\s+content: (\S+)/g,
  ))
    files.set(match[1] as string, {
      mode: match[2] as string,
      text: Buffer.from(match[3] as string, "base64").toString("utf8"),
    });
  return files;
}

beforeEach(async () => {
  fake = await fakeDigitalOcean({ bakeMs: 100, actionDelayMs: 30 });
  lines = [];
});
afterEach(async () => {
  await fake.close();
});

test("the image is made on a Droplet of its own, which is snapshotted and deleted", async () => {
  const image = await bakeImage(api(), options());

  assert.equal(image.name, "hive-workspace-test");
  assert.deepEqual(image.regions, ["nyc3"]);
  const stored = fake.images.get(image.id);
  assert.equal(stored?.type, "snapshot");
  // The smallest disk that has the memory, so that every size can be made from it.
  const made = fake.calls.find((call) => call.method === "POST" && call.path === "/v2/droplets");
  const body = made?.body as { size: string; image: string; tags: string[]; region: string };
  assert.equal(body.size, "s-1vcpu-2gb");
  assert.equal(body.image, "ubuntu-24-04-x64");
  assert.equal(body.region, "nyc3");
  assert.deepEqual(body.tags, ["hive-bake"]);
  assert.equal(image.minDiskSize, 50);
  // It is gone once the snapshot is, and the calls came in the order that makes sense.
  assert.equal(fake.droplets.size, 0);
  const order = fake.calls
    .map((call) => `${call.method} ${call.path.replace(/\d{4,}/g, "N").split("?")[0]}`)
    .filter((call, i, all) => call !== all[i - 1]);
  assert.deepEqual(
    order.filter((call) => !call.startsWith("GET /v2/sizes")),
    [
      "POST /v2/droplets",
      "GET /v2/droplets/N",
      "POST /v2/droplets/N/actions",
      "GET /v2/droplets/N/actions/N",
      "GET /v2/droplets/N/snapshots",
      "DELETE /v2/droplets/N",
    ],
  );
  assert.ok(lines.some((line) => /Taking the snapshot hive-workspace-test/.test(line)));
  assert.ok(lines.some((line) => /Deleting the Droplet/.test(line)));
});

test("the Droplet is sent the scripts, and the DigitalOcean token is not among them", async () => {
  await bakeImage(api(), options({ registry: { user: "puller", token: "registry-secret" } }));
  const made = fake.calls.find((call) => call.method === "POST" && call.path === "/v2/droplets");
  assert.ok(made);
  const userData = (made.body as { user_data: string }).user_data;
  assert.ok(userData.startsWith("#cloud-config\n"));
  const files = filesOf(userData);
  assert.deepEqual([...files.keys()].sort(), [
    "/opt/hive-bake/bake.env",
    "/opt/hive-bake/bake.sh",
    "/opt/hive-bake/hive-workspace.service",
    "/opt/hive-bake/nftables.conf",
  ]);
  const vm = (name: string) =>
    readFileSync(new URL(`../apps/workspace/vm/${name}`, import.meta.url), "utf8");
  assert.equal(files.get("/opt/hive-bake/bake.sh")?.text, vm("bake.sh"));
  assert.equal(
    files.get("/opt/hive-bake/hive-workspace.service")?.text,
    vm("hive-workspace.service"),
  );
  assert.equal(files.get("/opt/hive-bake/nftables.conf")?.text, vm("nftables.conf"));
  assert.equal(files.get("/opt/hive-bake/bake.sh")?.mode, "0755");
  // The registry login is in a file only root can read, and the DigitalOcean token is nowhere.
  assert.equal(files.get("/opt/hive-bake/bake.env")?.mode, "0600");
  assert.match(
    files.get("/opt/hive-bake/bake.env")?.text ?? "",
    /HIVE_REGISTRY_TOKEN='registry-secret'/,
  );
  assert.equal(userData.includes(fake.token), false);
  assert.match(userData, /runcmd:\n {2}- \[bash, \/opt\/hive-bake\/bake\.sh\]/);
  assert.equal(lines.join("\n").includes("registry-secret"), false);
  assert.ok(userData.length < 65536);
});

test("the script finds the files it is sent where it looks for them", () => {
  const script = readFileSync(new URL("../apps/workspace/vm/bake.sh", import.meta.url), "utf8");
  for (const name of ["hive-workspace.service", "nftables.conf"])
    assert.ok(
      script.includes(`"$HERE/${name}"`),
      `bake.sh does not look for ${name} next to itself`,
    );
  assert.ok(script.includes('"$WORK/bake.env"'));
  const sent = filesOf(bakeCloudConfig({ workspaceImage: "x" }));
  assert.ok(sent.has("/opt/hive-bake/bake.env"));
});

test("what is written to the settings file is read back by a shell exactly as it was given", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-bake-env-"));
  try {
    const awkward = {
      user: "pull'er",
      token: `to'ken $(touch ${dir}/pwned) "quoted" \`id\` \\ ; & | #`,
    };
    const env = filesOf(
      bakeCloudConfig({ workspaceImage: "ghcr.io/a/b:c d", registry: awkward }),
    ).get("/opt/hive-bake/bake.env")?.text as string;
    writeFileSync(join(dir, "bake.env"), env);
    const read = (name: string) =>
      execFileSync("bash", ["-c", `set -a; . "${dir}/bake.env"; printf %s "$${name}"`], {
        encoding: "utf8",
      });
    assert.equal(read("HIVE_REGISTRY_USER"), awkward.user);
    assert.equal(read("HIVE_REGISTRY_TOKEN"), awkward.token);
    assert.equal(read("HIVE_WORKSPACE_IMAGE"), "ghcr.io/a/b:c d");
    assert.throws(() => readFileSync(join(dir, "pwned")));
    assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => bakeCloudConfig({ workspaceImage: "a\nb" }), /image has a line break in it/);
  assert.throws(
    () => bakeCloudConfig({ workspaceImage: "a", registry: { user: "u", token: "t\nHIVE_X=1" } }),
    /registry token has a line break/,
  );
});

test("the size is the smallest disk with the memory, then the cheapest, and one that is asked for", () => {
  const sizes = defaultSizes();
  assert.equal(chooseBakeSize(sizes, "nyc3").slug, "s-1vcpu-2gb");
  // v5 sizes have the smallest disks, where they are.
  assert.equal(chooseBakeSize(sizes, "mem1").slug, "s5-2vcpu-4gb-30gb");
  // Not one that is unavailable, too small, not shared, or not in the region.
  const only = (slug: string) => sizes.filter((size) => size.slug === slug);
  assert.throws(() => chooseBakeSize(only("s-1vcpu-1gb"), "nyc3"), /no shared size with 2 GB/);
  assert.throws(() => chooseBakeSize(only("g-2vcpu-8gb"), "nyc3"), /no shared size with 2 GB/);
  assert.throws(() => chooseBakeSize(only("s-4vcpu-8gb"), "nyc3"), /no shared size with 2 GB/);
  assert.throws(() => chooseBakeSize(only("s-1vcpu-2gb"), "fra9"), /no shared size with 2 GB/);
  assert.equal(chooseBakeSize(sizes, "nyc3", "s-2vcpu-4gb").slug, "s-2vcpu-4gb");
  assert.throws(() => chooseBakeSize(sizes, "nyc3", "s-9vcpu"), /no size s-9vcpu/);
  assert.throws(() => chooseBakeSize(sizes, "nyc3", "s-4vcpu-8gb"), /not available in nyc3/);
  assert.throws(() => chooseBakeSize(sizes, "atl1", "s-1vcpu-2gb"), /not available in atl1/);
});

test("a Droplet that never switches itself off is left running, with where to look", async () => {
  await fake.close();
  fake = await fakeDigitalOcean({ actionDelayMs: 10 }); // never bakes
  const error = await bakeImage(api(), options({ bakeMinutes: 0.02 })).catch((e) => e);
  assert.ok(error instanceof BakeError, String(error));
  assert.match(error.message, /did not switch itself off in 0\.02 minutes/);
  assert.match(error.message, /hive-bake\.log/);
  assert.match(error.message, new RegExp(`doctl compute droplet delete ${error.dropletId}`));
  assert.match(error.message, /\(203\.0\.113\.\d+\)/);
  assert.equal(fake.droplets.size, 1, "the Droplet was deleted");
  assert.equal(
    fake.calls.some((call) => /actions$/.test(call.path) && call.method === "POST"),
    false,
    "a snapshot was taken of a machine that had not finished",
  );
});

test("a snapshot that is refused leaves the Droplet, and the message says what DigitalOcean said", async () => {
  fake.failNext(/POST \/v2\/droplets\/\d+\/actions/, 422, 1, undefined, "Droplet is locked");
  const error = await bakeImage(api(), options()).catch((e) => e);
  assert.ok(error instanceof BakeError, String(error));
  assert.match(error.message, /answered 422: Droplet is locked/);
  assert.match(error.message, /is left running/);
  assert.equal(fake.droplets.size, 1);
});

test("a snapshot that does not complete in time is reported", async () => {
  fake.hang("snapshot");
  const error = await bakeImage(api(), options({ snapshotMinutes: 0.02 })).catch((e) => e);
  assert.ok(error instanceof BakeError, String(error));
  assert.match(error.message, /snapshot was not taken in 0\.02 minutes/);
  assert.equal(fake.droplets.size, 1);
});

test("a busy DigitalOcean is waited out and a size it does not have is refused before anything is made", async () => {
  fake.failNext(/GET \/v2\/droplets\/\d+$/, 503, 2);
  const image = await bakeImage(api(), options());
  assert.ok(image.id > 0);
  assert.equal(fake.droplets.size, 0);

  const before = fake.calls.length;
  await assert.rejects(bakeImage(api(), options({ size: "s-9vcpu" })), /no size s-9vcpu/);
  assert.equal(
    fake.calls.slice(before).some((call) => call.method === "POST"),
    false,
  );
});

test("the command line says what is missing, and makes the image from a token and an image name", async () => {
  const env = { DO_API_TOKEN: fake.token, DO_API_URL: fake.apiUrl, DO_REGION: "nyc3" };
  const quiet = { log: () => {}, pollMs: 20, bakeMinutes: 1, snapshotMinutes: 1 };
  await assert.rejects(main(["--image", "x"], {}, quiet), /DO_API_TOKEN is needed/);
  await assert.rejects(main([], env, quiet), /--image names the container image/);
  await assert.rejects(main(["--image", "x", "--bogus", "1"], env, quiet), /No option --bogus/);
  await assert.rejects(main(["--image"], env, quiet), /not an option with a value/);
  await assert.rejects(
    main(["--image", "x"], { ...env, HIVE_REGISTRY_USER: "u" }, quiet),
    /go together/,
  );

  const printed: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void printed.push(args.join(" "));
  try {
    await main(
      ["--image", "ghcr.io/example/hive-workspace:1", "--name", "from-the-cli"],
      env,
      quiet,
    );
  } finally {
    console.log = original;
  }
  const image = [...fake.images.values()].find((one) => one.name === "from-the-cli");
  assert.ok(image);
  assert.ok(printed.includes(`DO_IMAGE=${image.id}`), printed.join("\n"));
  assert.ok(printed.some((line) => /ready in nyc3/.test(line)));
});
