import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { channelWorkspaceDir } from "../apps/server/src/engine/threads.ts";
import type { ChannelFile, ChannelFolder } from "../packages/domain/src/workspace-files.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string;
let token: string, other: string;

const authorized = (as = token) => ({ Authorization: `Bearer ${as}` });
const api = (path: string, init: RequestInit = {}, as = token) =>
  server.app.request(`/api/agent${path}`, {
    ...init,
    headers: { ...authorized(as), ...init.headers },
  });
async function json<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
/** Fetch a link the way a browser does: with nothing but the URL. */
const open = (url: string, headers: Record<string, string> = {}) => {
  const { pathname, search } = new URL(url);
  return server.app.request(`${pathname}${search}`, { headers });
};
const upload = (name: string, body: string | Uint8Array, fields: Record<string, string> = {}) => {
  const form = new FormData();
  form.append("file", new File([typeof body === "string" ? body : new Uint8Array(body)], name));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return api("/channels/general/files", { method: "POST", body: form });
};
const workspace = () => channelWorkspaceDir(directory, "shared", "general");
const write = async (path: string, text: string) => {
  await mkdir(join(workspace(), ...path.split("/").slice(0, -1)), { recursive: true });
  await writeFile(join(workspace(), path), text);
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-channel-files-api-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createApp(db, config);
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
  other = (await server.auth.sessionForOwner("google:2")).token;
  await json(
    await api("/channels", { method: "POST", body: JSON.stringify({ name: "General" }) }),
    201,
  );
  await json(
    await api("/channels", { method: "POST", body: JSON.stringify({ name: "Old" }) }),
    201,
  );
  await api("/channels/old/archive", { method: "POST", body: "{}" });
});
after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("files can only be listed, read about and added by someone signed in", async () => {
  for (const [path, init] of [
    ["/channels/general/files", {}],
    ["/channels/general/files?recent=1", {}],
    ["/channels/general/files/info?path=a.txt", {}],
    ["/channels/general/files", { method: "POST", body: new FormData() }],
  ] as [string, RequestInit][])
    assert.equal((await server.app.request(`/api/agent${path}`, init)).status, 401, path);
  assert.equal((await api("/channels/nowhere/files")).status, 404);
});

test("what a person uploads is listed, described and can be opened from its link", async () => {
  const added = await json<ChannelFile>(
    await upload("Brand guide.md", "# Brand\n\nBlue and gold.", { dir: "uploads" }),
    201,
  );
  assert.equal(added.path, "uploads/Brand guide.md");
  assert.equal(added.kind, "markdown");
  assert.equal(added.size, 23);
  assert.match(added.url ?? "", /^http:\/\/localhost:8787\/api\/agent\/channels\/general\/view\//);
  const top = await json<ChannelFolder>(await api("/channels/general/files"));
  assert.deepEqual(
    top.entries.map((e) => `${e.type}:${e.path}`),
    ["folder:uploads"],
  );
  const inside = await json<ChannelFolder>(await api("/channels/general/files?path=uploads"));
  assert.equal(inside.path, "uploads");
  assert.deepEqual(
    inside.entries.map((e) => e.name),
    ["Brand guide.md"],
  );
  const recent = await json<ChannelFolder>(await api("/channels/general/files?recent=1&limit=5"));
  assert.deepEqual(
    recent.entries.map((e) => e.path),
    ["uploads/Brand guide.md"],
  );
  const info = await json<ChannelFile>(
    await api(`/channels/general/files/info?path=${encodeURIComponent("uploads/Brand guide.md")}`),
  );
  assert.equal(info.excerpt, "# Brand\n\nBlue and gold.");
  // Anyone on the team sees the same shared channel.
  assert.equal(
    (await json<ChannelFolder>(await api("/channels/general/files", {}, other))).entries.length,
    1,
  );
  // The link needs no sign-in and shows the file as text, never as something to run.
  const response = await open(info.url as string);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "# Brand\n\nBlue and gold.");
  assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^inline; filename\*=UTF-8''Brand%20guide\.md$/,
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "sandbox");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-length"), "23");
  // Asking for a download is the one thing the link's query string changes.
  const download = await open(`${info.url}?download=1`);
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/);
});

test("uploads are refused when they are empty, too big, hidden away or for an archived channel", async () => {
  const form = new FormData();
  assert.equal((await api("/channels/general/files", { method: "POST", body: form })).status, 400);
  assert.equal((await upload("empty.txt", "")).status, 422);
  assert.equal((await upload("big.bin", new Uint8Array(10 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await upload("x.txt", "x", { dir: "threads" })).status, 422);
  assert.equal((await upload("x.txt", "x", { dir: "../escape" })).status, 400);
  const archived = new FormData();
  archived.append("file", new File(["x"], "x.txt"));
  assert.equal((await api("/channels/old/files", { method: "POST", body: archived })).status, 409);
});

test("each kind of file is sent so that a browser shows it without running anything of Hive's", async () => {
  const files: [string, string, RegExp, string | null][] = [
    [
      "pic.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      /^inline/,
      "sandbox",
    ],
    ["notes.txt", "plain", /^inline/, "sandbox"],
    ["data.json", '{"a":1}', /^inline/, "sandbox"],
    ["tool.js", "alert(1)", /^inline/, "sandbox"],
    ["clip.mp4", "not really video", /^inline/, "sandbox"],
    ["bundle.zip", "PK", /^attachment/, "sandbox"],
    ["mystery.xyz", "??", /^attachment/, "sandbox"],
    ["slides.pdf", "%PDF-1.7", /^inline/, null],
    [
      "page.html",
      "<script>parent.localStorage</script>",
      /^inline/,
      "sandbox allow-scripts allow-forms allow-popups allow-modals",
    ],
  ];
  const types: Record<string, string> = {
    "pic.svg": "image/svg+xml",
    "notes.txt": "text/plain; charset=utf-8",
    "data.json": "application/json; charset=utf-8",
    "tool.js": "text/javascript; charset=utf-8",
    "clip.mp4": "video/mp4",
    "bundle.zip": "application/zip",
    "mystery.xyz": "application/octet-stream",
    "slides.pdf": "application/pdf",
    "page.html": "text/html; charset=utf-8",
  };
  for (const [name, body, disposition, policy] of files) {
    await write(`kinds/${name}`, body);
    const info = await json<ChannelFile>(
      await api(`/channels/general/files/info?path=kinds/${name}`),
    );
    const response = await open(info.url as string);
    assert.equal(response.status, 200, name);
    assert.equal(await response.text(), body, name);
    assert.equal(response.headers.get("content-type"), types[name], name);
    assert.match(response.headers.get("content-disposition") ?? "", disposition, name);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", name);
    assert.equal(response.headers.get("content-security-policy"), policy, name);
  }
});

test("a video can be played and skipped through by asking for part of it", async () => {
  await write("media/clip.mp4", "0123456789");
  const info = await json<ChannelFile>(
    await api("/channels/general/files/info?path=media/clip.mp4"),
  );
  const part = await open(info.url as string, { Range: "bytes=2-5" });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), "2345");
  assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(part.headers.get("content-length"), "4");
  assert.equal(await (await open(info.url as string, { Range: "bytes=-3" })).text(), "789");
  assert.equal(await (await open(info.url as string, { Range: "bytes=8-" })).text(), "89");
  const past = await open(info.url as string, { Range: "bytes=10-" });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get("content-range"), "bytes */10");
  // A viewer that shows only the start of a file can ask for just that.
  const start = await open(`${info.url}?head=4`);
  assert.equal(start.status, 200);
  assert.equal(await start.text(), "0123");
  assert.equal(start.headers.get("content-length"), "4");
  assert.equal(await (await open(`${info.url}?head=500`)).text(), "0123456789");
  assert.equal(await (await open(`${info.url}?head=0`)).text(), "0123456789");
  assert.equal(await (await open(`${info.url}?head=abc`)).text(), "0123456789");
  await write("media/empty.mp4", "");
  const empty = await json<ChannelFile>(
    await api("/channels/general/files/info?path=media/empty.mp4"),
  );
  const response = await open(empty.url as string);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});

test("a web page's link also opens the styles, scripts and images beside it, and nothing else", async () => {
  await write(
    "site/index.html",
    '<link rel="stylesheet" href="css/site.css"><script src="app.js"></script>',
  );
  await write("site/css/site.css", "body { color: red }");
  await write("site/app.js", "console.log(1)");
  await write("private/plan.txt", "secret");
  const page = await json<ChannelFile>(
    await api("/channels/general/files/info?path=site/index.html"),
  );
  const base = page.url as string;
  const sibling = (path: string) => new URL(path, base).toString().replace(/\?.*$/, "");
  // What a browser does with the page's relative links: same place, new file, no query string.
  const css = await open(sibling("css/site.css"));
  assert.equal(css.status, 200);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(await css.text(), "body { color: red }");
  assert.equal(
    (await open(sibling("app.js"))).headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assert.equal((await open(sibling("../private/plan.txt"))).status, 403);
  assert.equal((await open(sibling("../../view/x/y"))).status, 401);
  // A link to a plain file covers only that file.
  const plan = await json<ChannelFile>(
    await api("/channels/general/files/info?path=private/plan.txt"),
  );
  assert.equal((await open(plan.url as string)).status, 200);
  assert.equal((await open((plan.url as string).replace("plan.txt", "other.txt"))).status, 403);
  // Neither can be turned into a way to read another path, however it is spelled.
  const token = (plan.url as string).split("/view/")[1].split("/")[0];
  // (A URL parser folds a bare `%2e%2e` into the token's place, which no longer names a token.)
  for (const path of [
    "..%2Fsite%2Findex.html",
    "%2e%2e/site/index.html",
    "private%2F..%2Fsite%2Findex.html",
  ]) {
    const status = (await server.app.request(`/api/agent/channels/general/view/${token}/${path}`))
      .status;
    assert.ok([400, 401, 403, 404].includes(status), `${path}: ${status}`);
  }
  assert.equal(
    (await server.app.request(`/api/agent/channels/general/view/${token}/%E0%A4%A`)).status,
    400,
  );
});

test("a link works for the channel it was made for, only until it expires, and only as issued", async () => {
  await write("docs/a.txt", "a");
  const info = await json<ChannelFile>(await api("/channels/general/files/info?path=docs/a.txt"));
  const url = info.url as string;
  assert.equal((await open(url.replace("/channels/general/", "/channels/old/"))).status, 403);
  const [head, tail] = url.split("/view/");
  const parts = tail.split("/")[0].split(".");
  const tamper = (edit: (p: string[]) => string[]) =>
    `${head}/view/${edit([...parts]).join(".")}/docs/a.txt`;
  assert.equal(
    (await open(tamper((p) => [p[0], Buffer.from("google:2").toString("base64url"), p[2], p[3]])))
      .status,
    403,
  );
  assert.equal(
    (
      await open(
        tamper((p) => [p[0], p[1], p[2], `${p[3].slice(0, 42)}${p[3].endsWith("A") ? "B" : "A"}`]),
      )
    ).status,
    403,
  );
  assert.equal((await open(tamper((p) => [p[0], p[1], p[2]]))).status, 401);
  assert.equal((await open(`${head}/view/garbage/docs/a.txt`)).status, 401);
  const real = Date.now;
  Date.now = () => real() + 16 * 60 * 1000;
  try {
    const expired = await open(url);
    assert.equal(expired.status, 401);
    assert.match(((await expired.json()) as { error: string }).error, /expired/);
  } finally {
    Date.now = real;
  }
  assert.equal((await open(url)).status, 200);
});

test("a link left in the workspace cannot be used to read outside it", async () => {
  await write("tricks/ok.txt", "ok");
  await writeFile(join(directory, "outside.txt"), "private");
  await symlink(join(directory, "outside.txt"), join(workspace(), "tricks/peek.txt"));
  await symlink(directory, join(workspace(), "tricks/up"));
  for (const path of ["tricks/peek.txt", "tricks/up/outside.txt"])
    assert.equal(
      (await api(`/channels/general/files/info?path=${encodeURIComponent(path)}`)).status,
      404,
      path,
    );
  const folder = await json<ChannelFolder>(await api("/channels/general/files?path=tricks"));
  assert.deepEqual(
    folder.entries.map((e) => e.name),
    ["ok.txt"],
  );
  // A link made while the file was real stops working once it points elsewhere.
  const info = await json<ChannelFile>(
    await api("/channels/general/files/info?path=tricks/ok.txt"),
  );
  await rm(join(workspace(), "tricks/ok.txt"));
  await symlink(join(directory, "outside.txt"), join(workspace(), "tricks/ok.txt"));
  assert.equal((await open(info.url as string)).status, 404);
});

test("a page in a sandbox can load its own fonts and modules, and nothing else is opened to other origins", async () => {
  await write("app/index.html", '<script type="module" src="main.js"></script>');
  await write("app/main.js", "export {}");
  const page = await json<ChannelFile>(
    await api("/channels/general/files/info?path=app/index.html"),
  );
  const script = new URL("main.js", page.url as string).toString().replace(/\?.*$/, "");
  // A sandboxed page has no origin of its own: its requests say `Origin: null`.
  const read = await open(script, { Origin: "null" });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("access-control-allow-origin"), "*");
  const known = await open(script, { Origin: "http://localhost:8081" });
  assert.equal(known.headers.get("access-control-allow-origin"), "http://localhost:8081");
  // Everything else still refuses a stranger.
  for (const path of ["/api/agent/channels/general/files", "/api/health"]) {
    const refused = await server.app.request(path, {
      headers: { ...authorized(), Origin: "null" },
    });
    assert.equal(refused.status, 403, path);
    assert.equal(refused.headers.get("access-control-allow-origin"), null, path);
  }
  const post = await server.app.request("/api/agent/channels/general/files", {
    method: "POST",
    headers: { ...authorized(), Origin: "https://evil.example" },
    body: new FormData(),
  });
  assert.equal(post.status, 403);
});
