import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import type { Store } from "../apps/server/src/db.ts";
import { byteRange, ChannelFiles } from "../apps/server/src/engine/channel-files.ts";
import { channelWorkspaceDir, diskOwnerForChannel } from "../apps/server/src/engine/threads.ts";
import { AppError } from "../packages/chat-core/src/errors.ts";
import { type Channel, ORCHESTRATOR_CHANNEL_ID } from "../packages/domain/src/agent.ts";
import { channelFileLimits } from "../packages/domain/src/workspace-files.ts";

const channels: Record<string, Channel["status"]> = {
  general: "active",
  design: "active",
  old: "archived",
  [ORCHESTRATOR_CHANNEL_ID]: "active",
};

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "hive-channel-files-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { publicUrl: "http://hive.test", dataDir } as Config;
  const auth = new Auth({} as Store, config, "test-signing-key");
  const service = new ChannelFiles(
    config,
    { signToken: (o, s) => auth.signToken(o, s), verifyToken: (token) => auth.verifyToken(token) },
    async (_owner, id) => (id in channels ? ({ id, status: channels[id] } as Channel) : null),
  );
  /** The folder the agent works in for a channel, as `owner` sees it. */
  const workspace = async (channelId = "general", owner = "alice") => {
    const dir = channelWorkspaceDir(dataDir, diskOwnerForChannel(channelId, owner), channelId);
    await mkdir(dir, { recursive: true });
    return dir;
  };
  const put = async (dir: string, path: string, text = "hello") => {
    await mkdir(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(dir, path), text);
  };
  return { dataDir, service, workspace, put, auth };
}

const refused = (status: number) => (error: unknown) =>
  error instanceof AppError && error.status === status;

test("a channel's files are listed from its workspace, folders first, without Hive's own folders", async (t) => {
  const { service, workspace, put } = await fixture(t);
  const dir = await workspace();
  await put(dir, "report.md", "# Q3");
  await put(dir, "data.csv", "a,b\n1,2");
  await put(dir, "site/index.html", "<h1>hi</h1>");
  await put(dir, "slides/deck.pdf", "%PDF-1.7");
  // Hive's own places, hidden files and what installing code leaves behind are not for browsing.
  await put(dir, "threads/abc.json", "{}");
  await put(dir, "attachments/task-1/form.pdf", "%PDF-1.7");
  await put(dir, ".env", "SECRET=1");
  await put(dir, ".opencode/state.json", "{}");
  await put(dir, "node_modules/left-pad/index.js", "x");
  const listing = await service.list("alice", "general");
  assert.deepEqual(
    listing.entries.map((e) => `${e.type}:${e.name}`),
    ["folder:site", "folder:slides", "file:data.csv", "file:report.md"],
  );
  assert.equal(listing.truncated, false);
  assert.equal(listing.path, "");
  const report = listing.entries.find((e) => e.name === "report.md");
  assert.equal(report?.kind, "markdown");
  assert.equal(report?.mimeType, "text/markdown");
  assert.equal(report?.size, 4);
  assert.match(
    report?.url ?? "",
    /^http:\/\/hive\.test\/api\/agent\/channels\/general\/view\/[\w.-]+\/report\.md$/,
  );
  assert.equal(listing.entries.find((e) => e.name === "site")?.url, undefined);
  // The same names are fine one folder down: only the top of the workspace is Hive's.
  await put(dir, "docs/threads/notes.txt", "x");
  assert.deepEqual(
    (await service.list("alice", "general", "docs")).entries.map((e) => e.name),
    ["threads"],
  );
  assert.deepEqual(
    (await service.list("alice", "general", "site/")).entries.map((e) => e.path),
    ["site/index.html"],
  );
});

test("a new channel has an empty workspace, and a missing one is an error", async (t) => {
  const { service } = await fixture(t);
  assert.deepEqual((await service.list("alice", "design")).entries, []);
  await assert.rejects(service.list("alice", "nowhere"), refused(404));
  await assert.rejects(service.list("alice", "design", "missing"), refused(404));
  await assert.rejects(service.info("alice", "design", "missing.txt"), refused(404));
});

test("a path cannot leave the workspace or name a hidden or internal place", async (t) => {
  const { service, workspace, put } = await fixture(t);
  const dir = await workspace();
  await put(dir, "ok.txt");
  await put(dir, "threads/abc.json", "{}");
  await put(dir, ".env", "SECRET=1");
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "a\\b", "a\0b", "a\nb", "x/".repeat(600)])
    await assert.rejects(service.info("alice", "general", bad), refused(400), JSON.stringify(bad));
  for (const hidden of [
    "threads/abc.json",
    ".env",
    "attachments",
    "Threads/abc.json",
    "a/.git/config",
  ])
    await assert.rejects(
      service.info("alice", "general", hidden),
      (e) => e instanceof AppError && [400, 404].includes(e.status),
      hidden,
    );
  await assert.rejects(service.list("alice", "general", "threads"), refused(404));
  await assert.rejects(service.list("alice", "general", "ok.txt"), refused(400));
  await assert.rejects(service.info("alice", "general", ""), refused(400));
  // Dots that stand for the current folder are harmless.
  assert.equal((await service.info("alice", "general", "./ok.txt")).path, "ok.txt");
});

test("a link left in the workspace is never followed out of it", async (t) => {
  const { dataDir, service, workspace, put } = await fixture(t);
  const dir = await workspace();
  const elsewhere = join(dataDir, "elsewhere");
  await put(elsewhere, "secret.txt", "private");
  await put(dir, "threads/abc.json", "{}");
  await symlink(join(elsewhere, "secret.txt"), join(dir, "peek.txt"));
  await symlink(elsewhere, join(dir, "outside"));
  await symlink(join(dir, "threads"), join(dir, "bindings"));
  await symlink(join(dir, "missing"), join(dir, "dangling"));
  await put(dir, "real.txt", "fine");
  await symlink(join(dir, "real.txt"), join(dir, "alias.txt"));
  // Links are not listed at all.
  assert.deepEqual(
    (await service.list("alice", "general")).entries.map((e) => e.name),
    ["real.txt"],
  );
  assert.deepEqual(
    (await service.recent("alice", "general")).entries.map((e) => e.name),
    ["real.txt"],
  );
  // And asking for them by name gets nothing from outside, or from Hive's own folders.
  await assert.rejects(service.info("alice", "general", "peek.txt"), refused(404));
  await assert.rejects(service.info("alice", "general", "outside/secret.txt"), refused(404));
  await assert.rejects(service.list("alice", "general", "outside"), refused(404));
  await assert.rejects(service.list("alice", "general", "bindings"), refused(404));
  await assert.rejects(service.info("alice", "general", "dangling"), refused(404));
  // The same holds for a link someone holds: it names a path, which is checked again when it is used.
  const file = await service.info("alice", "general", "real.txt");
  const token = (file.url as string).split("/view/")[1].split("/")[0];
  await rm(join(dir, "real.txt"));
  await symlink(join(elsewhere, "secret.txt"), join(dir, "real.txt"));
  await assert.rejects(service.byLink(token, "general", "real.txt"), refused(404));
});

test("a file has a link, and the start of it if it is text", async (t) => {
  const { service, workspace, put } = await fixture(t);
  const dir = await workspace();
  await put(dir, "notes.md", `# Plan\n\n${"word ".repeat(1000)}`);
  await put(dir, "blank.txt", "   \n");
  await put(dir, "blob.txt", "text\0binary");
  await put(dir, "photo.png", "\x89PNG");
  const notes = await service.info("alice", "general", "notes.md");
  assert.equal(notes.kind, "markdown");
  assert.equal(notes.excerpt?.startsWith("# Plan"), true);
  assert.equal(notes.excerpt?.length, channelFileLimits.excerptChars);
  assert.equal((await service.info("alice", "general", "blank.txt")).excerpt, undefined);
  assert.equal((await service.info("alice", "general", "blob.txt")).excerpt, undefined);
  assert.equal((await service.info("alice", "general", "photo.png")).excerpt, undefined);
  assert.equal((await service.info("alice", "general", "photo.png")).kind, "image");
});

test("a link is good for its file, and a web page's link for the folder it sits in", async (t) => {
  const { service, workspace, put, auth } = await fixture(t);
  const dir = await workspace();
  await put(dir, "reports/q3.pdf", "%PDF-1.7");
  await put(dir, "reports/q4.pdf", "%PDF-1.7");
  await put(dir, "site/index.html", "<link rel=stylesheet href=css/site.css>");
  await put(dir, "site/css/site.css", "body{}");
  await put(dir, "site/img/a b.png", "x");
  await put(dir, "other/secret.txt", "x");
  await put(dir, "top.html", "<p>top</p>");
  const tokenOf = (url: string) => url.split("/view/")[1].split("/")[0];

  const pdf = await service.info("alice", "general", "reports/q3.pdf");
  const opened = await service.byLink(tokenOf(pdf.url as string), "general", "reports/q3.pdf");
  assert.equal(opened.owner, "alice");
  assert.equal(opened.file.name, "q3.pdf");
  assert.equal(opened.file.size, 8);
  // A file's link does not open its neighbours, another channel, or a different path.
  for (const [channel, path] of [
    ["general", "reports/q4.pdf"],
    ["general", "reports"],
    ["design", "reports/q3.pdf"],
  ])
    await assert.rejects(service.byLink(tokenOf(pdf.url as string), channel, path), refused(403));

  const page = await service.info("alice", "general", "site/index.html");
  const token = tokenOf(page.url as string);
  for (const path of ["site/index.html", "site/css/site.css", "site/img/a b.png"])
    assert.equal((await service.byLink(token, "general", path)).file.path, path);
  for (const path of ["other/secret.txt", "reports/q3.pdf", "top.html"])
    await assert.rejects(service.byLink(token, "general", path), refused(403), path);
  await assert.rejects(service.byLink(token, "general", "site/../other/secret.txt"), refused(400));
  // A page at the top of the workspace is good for the whole workspace, but never Hive's own folders.
  const top = await service.info("alice", "general", "top.html");
  assert.equal(
    (await service.byLink(tokenOf(top.url as string), "general", "other/secret.txt")).file.name,
    "secret.txt",
  );
  await assert.rejects(
    service.byLink(tokenOf(top.url as string), "general", "threads/x.json"),
    refused(404),
  );
  // The path in a link is encoded, and a name with spaces or accents survives the trip.
  assert.match(
    (await service.info("alice", "general", "site/img/a b.png")).url as string,
    /\/site\/img\/a%20b\.png$/,
  );
  // A token is not enough on its own: it is for one person and one kind of use.
  await assert.rejects(service.byLink("not-a-token", "general", "site/index.html"), refused(401));
  await assert.rejects(
    service.byLink(auth.signToken("alice", "nonsense"), "general", "site/index.html"),
    refused(403),
  );
});

test("the newest files anywhere in the workspace come first", async (t) => {
  const { service, workspace, put } = await fixture(t);
  const dir = await workspace();
  const files = ["old.txt", "a/b/c/deep.txt", "mid.txt", "new.txt", "a/sibling.txt"];
  for (const [index, path] of files.entries()) {
    await put(dir, path);
    await utimes(join(dir, path), new Date(2026, 0, 1 + index), new Date(2026, 0, 1 + index));
  }
  await put(dir, ".hidden/x.txt");
  await put(dir, "threads/x.json", "{}");
  await put(dir, "node_modules/a/b.js", "x");
  const recent = await service.recent("alice", "general", 3);
  assert.deepEqual(
    recent.entries.map((e) => e.path),
    ["a/sibling.txt", "new.txt", "mid.txt"],
  );
  assert.equal(recent.truncated, true);
  assert.equal(
    recent.entries.every((e) => e.type === "file" && e.url),
    true,
  );
  assert.equal((await service.recent("alice", "general")).entries.length, 5);
  assert.equal((await service.recent("alice", "design")).entries.length, 0);
});

test("a person's upload is kept as named, unless the name is taken", async (t) => {
  const { service, workspace } = await fixture(t);
  const dir = await workspace();
  const bytes = new TextEncoder().encode("brand colours");
  const first = await service.save("alice", "general", undefined, "Brand guide.pdf", bytes);
  assert.equal(first.path, "uploads/Brand guide.pdf");
  assert.equal(first.kind, "pdf");
  assert.equal(first.size, bytes.length);
  assert.ok(first.url);
  const second = await service.save(
    "alice",
    "general",
    "",
    "Brand guide.pdf",
    new TextEncoder().encode("v2"),
  );
  assert.equal(second.path, "uploads/Brand guide (2).pdf");
  assert.equal(await readFile(join(dir, "uploads/Brand guide.pdf"), "utf8"), "brand colours");
  assert.equal(await readFile(join(dir, "uploads/Brand guide (2).pdf"), "utf8"), "v2");
  // Names are cleaned: no path, no odd characters, nothing that would hide the file.
  const odd = await service.save("alice", "general", "refs/2026", "../../etc/pass:wd*.txt", bytes);
  assert.equal(odd.path, "refs/2026/pass_wd_.txt");
  assert.equal(
    (await service.save("alice", "general", undefined, ".env", bytes)).path,
    "uploads/env",
  );
  assert.equal((await service.save("alice", "general", undefined, "///", bytes)).name, "file");
  assert.equal(
    (await service.save("alice", "general", undefined, "node_modules", bytes)).name,
    "_node_modules",
  );
  const long = await service.save("alice", "general", undefined, `${"x".repeat(300)}.png`, bytes);
  assert.equal(long.name.length, 104);
  // Folders are made as needed, but not Hive's own or hidden ones.
  for (const folder of ["threads", ".secret", "attachments/task-1", "a/../b"])
    await assert.rejects(
      service.save("alice", "general", folder, "x.txt", bytes),
      (e) => e instanceof AppError && [400, 422].includes(e.status),
      folder,
    );
  await assert.rejects(
    service.save("alice", "general", undefined, "empty.txt", new Uint8Array()),
    refused(422),
  );
  await assert.rejects(
    service.save(
      "alice",
      "general",
      undefined,
      "big.bin",
      new Uint8Array(channelFileLimits.uploadBytes + 1),
    ),
    refused(413),
  );
  await assert.rejects(service.save("alice", "old", undefined, "x.txt", bytes), refused(409));
  await assert.rejects(service.save("alice", "nowhere", undefined, "x.txt", bytes), refused(404));
  // Nothing was left behind by the refused ones.
  assert.deepEqual(
    (await readdir(join(dir, "uploads"))).sort(),
    [
      "Brand guide (2).pdf",
      "Brand guide.pdf",
      "_node_modules",
      `${"x".repeat(100)}.png`,
      "env",
      "file",
    ].sort(),
  );
});

test("an upload never goes through a link out of the workspace", async (t) => {
  const { dataDir, service, workspace } = await fixture(t);
  const dir = await workspace();
  const elsewhere = join(dataDir, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, join(dir, "uploads"));
  const bytes = new TextEncoder().encode("x");
  await assert.rejects(service.save("alice", "general", undefined, "a.txt", bytes), refused(422));
  await assert.rejects(
    service.save("alice", "general", "uploads/new", "a.txt", bytes),
    refused(422),
  );
  assert.deepEqual(await readdir(elsewhere), []);
  // A link already sitting at the file's name is not written through either.
  await mkdir(join(dir, "docs"));
  await writeFile(join(elsewhere, "target.txt"), "keep");
  await symlink(join(elsewhere, "target.txt"), join(dir, "docs/a.txt"));
  const saved = await service.save("alice", "general", "docs", "a.txt", bytes);
  assert.equal(saved.path, "docs/a (2).txt");
  assert.equal(await readFile(join(elsewhere, "target.txt"), "utf8"), "keep");
});

test("an agent without file tools of its own can write a text file", async (t) => {
  const { service, workspace } = await fixture(t);
  const dir = await workspace();
  const made = await service.write("alice", "general", "plans/q3.md", "# Q3 plan");
  assert.equal(made.path, "plans/q3.md");
  assert.equal(made.kind, "markdown");
  assert.equal(await readFile(join(dir, "plans/q3.md"), "utf8"), "# Q3 plan");
  const again = await service.write("alice", "general", "plans/q3.md", "# Q3 plan, revised");
  assert.equal(again.size, 18);
  assert.equal(await readFile(join(dir, "plans/q3.md"), "utf8"), "# Q3 plan, revised");
  for (const path of ["", ".env", "threads/x.json", "../x.md", "/abs.md"])
    await assert.rejects(
      service.write("alice", "general", path, "x"),
      (e) => e instanceof AppError && [400, 404].includes(e.status),
      path,
    );
  await assert.rejects(service.write("alice", "general", "empty.md", ""), refused(422));
  await assert.rejects(
    service.write("alice", "general", "huge.md", "x".repeat(channelFileLimits.writeBytes + 1)),
    refused(413),
  );
  await assert.rejects(service.write("alice", "old", "x.md", "x"), refused(409));
  // Writing over a folder or through a link is refused.
  await assert.rejects(service.write("alice", "general", "plans", "x"), refused(422));
  const outside = join(dir, "..", "outside.txt");
  await writeFile(outside, "keep");
  await symlink(outside, join(dir, "link.md"));
  await assert.rejects(service.write("alice", "general", "link.md", "overwritten"), refused(422));
  assert.equal(await readFile(outside, "utf8"), "keep");
});

test("a path can be given from the top of the workspace or in full", async (t) => {
  const { service, workspace, put } = await fixture(t);
  const dir = await workspace();
  await put(dir, "reports/q3.pdf");
  assert.equal(await service.pathOf("alice", "general", "reports/q3.pdf"), "reports/q3.pdf");
  assert.equal(await service.pathOf("alice", "general", "./reports//q3.pdf"), "reports/q3.pdf");
  assert.equal(
    await service.pathOf("alice", "general", join(dir, "reports/q3.pdf")),
    "reports/q3.pdf",
  );
  await assert.rejects(service.pathOf("alice", "general", "/etc/passwd"), refused(422));
  await assert.rejects(service.pathOf("alice", "general", dir), refused(422));
  await assert.rejects(service.pathOf("alice", "general", `${dir}/../x`), refused(422));
  await assert.rejects(service.pathOf("alice", "general", "../x"), refused(400));
});

test("a shared channel's files are everyone's, an orchestrator's are its person's", async (t) => {
  const { service } = await fixture(t);
  const bytes = new TextEncoder().encode("x");
  await service.save("alice", "general", undefined, "team.txt", bytes);
  await service.save("alice", ORCHESTRATOR_CHANNEL_ID, undefined, "mine.txt", bytes);
  assert.deepEqual(
    (await service.recent("bob", "general")).entries.map((e) => e.path),
    ["uploads/team.txt"],
  );
  assert.deepEqual(
    (await service.recent("alice", ORCHESTRATOR_CHANNEL_ID)).entries.map((e) => e.path),
    ["uploads/mine.txt"],
  );
  assert.deepEqual((await service.recent("bob", ORCHESTRATOR_CHANNEL_ID)).entries, []);
  // A link made for one person opens that person's orchestrator, whoever holds it.
  const link = (await service.info("alice", ORCHESTRATOR_CHANNEL_ID, "uploads/mine.txt"))
    .url as string;
  const token = link.split("/view/")[1].split("/")[0];
  assert.equal(
    (await service.byLink(token, ORCHESTRATOR_CHANNEL_ID, "uploads/mine.txt")).owner,
    "alice",
  );
  assert.ok(
    (
      await stat(
        join((await service.byLink(token, ORCHESTRATOR_CHANNEL_ID, "uploads/mine.txt")).real),
      )
    ).isFile(),
  );
});

test("a byte range is read the way a browser asks for it", () => {
  assert.deepEqual(byteRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(byteRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(byteRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(byteRange("bytes=-5000", 1000), { start: 0, end: 999 });
  assert.deepEqual(byteRange("bytes=990-5000", 1000), { start: 990, end: 999 });
  assert.equal(byteRange("bytes=1000-", 1000), "unsatisfiable");
  assert.equal(byteRange("bytes=50-10", 1000), "unsatisfiable");
  assert.equal(byteRange("bytes=0-0", 0), "unsatisfiable");
  // Anything it cannot read means the whole file.
  for (const header of [
    undefined,
    "",
    "bytes=",
    "bytes=-",
    "items=0-1",
    "bytes=0-1,5-6",
    "bytes=a-b",
  ])
    assert.equal(byteRange(header, 1000), undefined, String(header));
});
