import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../packages/domain/src/chat.ts";
import { chatStack, type Identity } from "./helpers/chat-stack.ts";

const MB = 1024 ** 2;
const olive: Identity = {
  sub: "acct_olive",
  email: "olive@example.com",
  name: "Olive",
  role: "owner",
};
const max: Identity = { sub: "acct_max", email: "max@example.com", name: "Max", role: "member" };
const mia: Identity = { sub: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" };

const limits = { maxFileBytes: 25 * MB, storageBytes: 100 * MB };

/** A workspace with a channel Max is in, and what he can do in it. */
async function setup(stackOptions: Parameters<typeof chatStack>[0] = { limits }) {
  const stack = chatStack(stackOptions);
  const maxer = stack.as(max);
  const channel = (await (await maxer.post("/v1/channels", { name: "Files" })).json()) as {
    id: string;
  };
  const bytes = (n: number) => new Uint8Array(n).fill(7);
  /** Everything for one file: ask where to send it, send it. */
  const upload = async (
    who: ReturnType<typeof stack.as>,
    size: number,
    extra: Record<string, unknown> = {},
  ) => {
    const begun = await who.post("/v1/files/uploads", {
      channelId: channel.id,
      name: "report.pdf",
      mime: "application/pdf",
      bytes: size,
      ...extra,
    });
    if (begun.status !== 201) return { begun };
    const body = (await begun.json()) as { fileId: string; upload: string; thumbUpload?: string };
    const sent = await who.put(body.upload, bytes(size));
    return { begun, body, sent };
  };
  const usage = async () =>
    (await (await maxer.get("/v1/usage")).json()) as {
      bytesUsed: number;
      bytesReserved: number;
      files: number;
    };
  return { stack, maxer, channel, upload, usage, bytes };
}

test("a file is sent to the address the room gives, kept, and shown on the message that carries it", async () => {
  const { stack, maxer, channel, upload, usage } = await setup();
  const { body, sent } = await upload(maxer, 3 * MB);
  assert.equal(sent?.status, 200);
  assert.deepEqual(await usage(), {
    bytesUsed: 3 * MB,
    bytesReserved: 0,
    files: 1,
    maxFileBytes: 25 * MB,
    storageBytes: 100 * MB,
  });
  assert.equal(stack.bucket.objects.get(`w/w1/f/${body?.fileId}`)?.length, 3 * MB);
  const posted = await maxer.post(`/v1/channels/${channel.id}/messages`, {
    body: "the report",
    fileIds: [body?.fileId],
  });
  assert.equal(posted.status, 201);
  const message = (await posted.json()) as ChatMessage;
  assert.deepEqual(
    message.files.map((f) => [f.name, f.mime, f.bytes, f.thumb]),
    [["report.pdf", "application/pdf", 3 * MB, false]],
  );
  // And it is what the channel's page shows.
  const page = (await (await maxer.get(`/v1/channels/${channel.id}/messages`)).json()) as {
    messages: ChatMessage[];
  };
  assert.equal(page.messages[0]?.files[0]?.id, body?.fileId);
});

test("a file can go on its own, with no words", async () => {
  const { maxer, channel, upload } = await setup();
  const { body } = await upload(maxer, 1000);
  const posted = await maxer.post(`/v1/channels/${channel.id}/messages`, {
    body: "",
    fileIds: [body?.fileId],
  });
  assert.equal(posted.status, 201);
  assert.equal((await maxer.post(`/v1/channels/${channel.id}/messages`, { body: "" })).status, 422);
});

test("a file is fetched from a link the room gives someone who may open the channel, and not otherwise", async () => {
  const { stack, maxer, channel, upload } = await setup();
  const mia_ = stack.as(mia);
  const { body } = await upload(maxer, 2000);
  await maxer.post(`/v1/channels/${channel.id}/messages`, {
    body: "here",
    fileIds: [body?.fileId],
  });
  // Anyone in the team can open a public channel, and so can fetch what is in it.
  const link = (await (await mia_.post(`/v1/files/${body?.fileId}/link`)).json()) as {
    path: string;
  };
  const got = await mia_.fetch(link.path);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "application/pdf");
  assert.match(got.headers.get("content-disposition") ?? "", /^inline; filename="report.pdf"/);
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  assert.match(got.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal((await got.arrayBuffer()).byteLength, 2000);
  // A private channel's files are not even linked to those outside it.
  const secret = (await (
    await maxer.post("/v1/channels", { name: "Secret", visibility: "private" })
  ).json()) as { id: string };
  const hidden = await maxer.post("/v1/files/uploads", {
    channelId: secret.id,
    name: "p.txt",
    mime: "text/plain",
    bytes: 10,
  });
  const hiddenFile = (await hidden.json()) as { fileId: string; upload: string };
  await maxer.put(hiddenFile.upload, new Uint8Array(10));
  assert.equal((await mia_.post(`/v1/files/${hiddenFile.fileId}/link`)).status, 404);
  assert.equal((await stack.as(olive).post(`/v1/files/${hiddenFile.fileId}/link`)).status, 404);
  assert.equal((await mia_.post("/v1/files/nope/link")).status, 404);
  const own = (await (await maxer.post(`/v1/files/${hiddenFile.fileId}/link`)).json()) as {
    path: string;
  };
  assert.equal((await maxer.fetch(own.path)).status, 200);
});

test("what is not a picture, a document or a recording is only ever downloaded", async () => {
  const { maxer, channel } = await setup();
  const send = async (name: string, mime: string) => {
    const begun = (await (
      await maxer.post("/v1/files/uploads", { channelId: channel.id, name, mime, bytes: 20 })
    ).json()) as { fileId: string; upload: string };
    await maxer.put(begun.upload, new Uint8Array(20));
    const link = (await (await maxer.post(`/v1/files/${begun.fileId}/link`)).json()) as {
      path: string;
    };
    return maxer.fetch(link.path);
  };
  const page = await send('evil".html', "text/html");
  assert.equal(page.headers.get("content-type"), "application/octet-stream");
  assert.match(page.headers.get("content-disposition") ?? "", /^attachment; filename="evil_.html"/);
  assert.equal(
    (await send("a.svg", "image/svg+xml")).headers.get("content-type"),
    "application/octet-stream",
  );
  assert.equal((await send("a.png", "image/png")).headers.get("content-type"), "image/png");
});

test("part of a file can be fetched", async () => {
  const { stack, maxer, channel } = await setup();
  const begun = (await (
    await maxer.post("/v1/files/uploads", {
      channelId: channel.id,
      name: "n.bin",
      mime: "video/mp4",
      bytes: 100,
    })
  ).json()) as { fileId: string; upload: string };
  await maxer.put(
    begun.upload,
    Uint8Array.from({ length: 100 }, (_, i) => i),
  );
  const link = (await (await maxer.post(`/v1/files/${begun.fileId}/link`)).json()) as {
    path: string;
  };
  void stack;
  const part = await maxer.fetch(link.path, { range: "bytes=10-19" });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 10-19/100");
  assert.deepEqual(
    [...new Uint8Array(await part.arrayBuffer())],
    [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  );
  const tail = await maxer.fetch(link.path, { range: "bytes=-5" });
  assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [95, 96, 97, 98, 99]);
  const open = await maxer.fetch(link.path, { range: "bytes=95-" });
  assert.equal(open.headers.get("content-range"), "bytes 95-99/100");
  assert.equal((await maxer.fetch(link.path, { range: "bytes=500-" })).status, 416);
});

test("a file over the plan's limit is refused, saying what the limit is", async () => {
  const { maxer, channel, upload } = await setup();
  const { begun } = await upload(maxer, 26 * MB);
  assert.equal(begun.status, 413);
  assert.match(((await begun.json()) as { error: string }).error, /up to 25 MB.*26 MB/);
  assert.equal(
    (await maxer.post("/v1/files/uploads", { channelId: channel.id, name: "x", bytes: 0 })).status,
    422,
  );
});

test("the workspace's storage allowance holds, and deleting makes room", async () => {
  const { maxer, channel, upload, usage } = await setup({
    limits: { maxFileBytes: 25 * MB, storageBytes: 30 * MB },
  });
  const first = await upload(maxer, 20 * MB);
  assert.equal(first.sent?.status, 200);
  const second = await upload(maxer, 11 * MB);
  assert.equal(second.begun.status, 413);
  assert.match(
    ((await second.begun.json()) as { error: string }).error,
    /10 MB of file storage left/,
  );
  // The message that carries it goes, and its file with it.
  const posted = (await (
    await maxer.post(`/v1/channels/${channel.id}/messages`, {
      body: "big",
      fileIds: [first.body?.fileId],
    })
  ).json()) as ChatMessage;
  assert.equal((await maxer.del(`/v1/messages/${posted.id}`)).status, 200);
  assert.deepEqual((await usage()).bytesUsed, 0);
  assert.equal((await upload(maxer, 25 * MB)).sent?.status, 200);
});

test("an upload address is for one file, that size, for a while, and is not forged", async () => {
  const { stack, maxer, channel, bytes } = await setup();
  const begun = (await (
    await maxer.post("/v1/files/uploads", {
      channelId: channel.id,
      name: "a",
      mime: "x/y",
      bytes: 100,
    })
  ).json()) as { fileId: string; upload: string };
  const url = new URL(begun.upload, "https://x");
  const tweak = (key: string, value: string) => {
    const copy = new URL(url);
    copy.searchParams.set(key, value);
    return `${copy.pathname}${copy.search}`;
  };
  // Not the size it was made for, a changed expiry, another file, no signature: all refused.
  assert.equal((await maxer.put(tweak("n", "200"), bytes(200))).status, 403);
  assert.equal(
    (await maxer.put(tweak("exp", String(Date.now() + 10 ** 9)), bytes(100))).status,
    403,
  );
  assert.equal(
    (await maxer.put(begun.upload.replace(begun.fileId, "other"), bytes(100))).status,
    403,
  );
  assert.equal((await maxer.put(tweak("sig", "0".repeat(64)), bytes(100))).status, 403);
  // Another workspace's room cannot be reached with it.
  assert.equal((await stack.as(max, "w2").put(begun.upload, bytes(100))).status, 403);
  // Fewer bytes than said does not do.
  assert.equal((await maxer.put(begun.upload, bytes(50), { "content-length": "50" })).status, 400);
  assert.equal((await maxer.put(begun.upload, bytes(100))).status, 200);
  // Once it is done it is done.
  assert.equal((await maxer.put(begun.upload, bytes(100))).status, 409);
  assert.equal(stack.bucket.objects.size, 1);
});

test("an upload that arrives bigger than said is thrown away, and its room is given back", async () => {
  const { stack, maxer, channel, usage, bytes } = await setup();
  const begun = (await (
    await maxer.post("/v1/files/uploads", {
      channelId: channel.id,
      name: "a",
      mime: "x/y",
      bytes: 100,
    })
  ).json()) as { fileId: string; upload: string };
  stack.bucket.lie = (_key, real) => real + 1;
  const sent = await maxer.put(begun.upload, bytes(100));
  assert.equal(sent.status, 413);
  assert.equal(stack.bucket.objects.size, 0, "what was stored is not kept");
  assert.deepEqual([(await usage()).bytesUsed, (await usage()).bytesReserved], [0, 0]);
});

test("an upload never finished gives its room back, and what is deleted is cleared from the bucket", async () => {
  const { stack, maxer, channel, upload, usage } = await setup();
  const begun = (await (
    await maxer.post("/v1/files/uploads", {
      channelId: channel.id,
      name: "a",
      mime: "x/y",
      bytes: 5 * MB,
    })
  ).json()) as { fileId: string };
  assert.equal((await usage()).bytesReserved, 5 * MB);
  stack.clock.now += 16 * 60_000;
  await stack.maintain();
  assert.equal((await usage()).bytesReserved, 0);
  // A file that was sent and then deleted is cleared from the bucket by the upkeep, not at once.
  const { body } = await upload(maxer, 1000);
  const key = `w/w1/f/${body?.fileId}`;
  assert.ok(stack.bucket.objects.has(key));
  assert.equal((await maxer.del(`/v1/files/${body?.fileId}`)).status, 200);
  assert.ok(stack.bucket.objects.has(key), "still there until the upkeep runs");
  assert.ok(stack.woke.length > 0, "and the room asked to be woken for it");
  await stack.maintain();
  assert.equal(stack.bucket.objects.has(key), false);
  void begun;
});

test("only the sender's own, finished files go on a message", async () => {
  const { stack, maxer, channel, upload } = await setup();
  const { body } = await upload(maxer, 100);
  const mia_ = stack.as(mia);
  await mia_.post(`/v1/channels/${channel.id}/members`, { add: ["mia@example.com"] });
  const theirs = await mia_.post(`/v1/channels/${channel.id}/messages`, {
    body: "mine now",
    fileIds: [body?.fileId],
  });
  assert.equal(theirs.status, 422);
  const first = await maxer.post(`/v1/channels/${channel.id}/messages`, {
    body: "one",
    fileIds: [body?.fileId],
  });
  assert.equal(first.status, 201);
  const again = await maxer.post(`/v1/channels/${channel.id}/messages`, {
    body: "two",
    fileIds: [body?.fileId],
  });
  assert.equal(again.status, 422, "not on two messages");
  // The refused message was not made.
  const page = (await (await maxer.get(`/v1/channels/${channel.id}/messages`)).json()) as {
    messages: ChatMessage[];
  };
  assert.deepEqual(
    page.messages.map((m) => m.body),
    ["one"],
  );
});

test("a person who is not in a channel does not send files to it, and an archived one takes none", async () => {
  const { stack, maxer, channel } = await setup();
  const outsider = await stack
    .as(olive)
    .post("/v1/files/uploads", { channelId: channel.id, name: "a", mime: "x/y", bytes: 5 });
  assert.equal(outsider.status, 403);
  await maxer.post(`/v1/channels/${channel.id}/archive`, {});
  assert.equal(
    (
      await maxer.post("/v1/files/uploads", {
        channelId: channel.id,
        name: "a",
        mime: "x/y",
        bytes: 5,
      })
    ).status,
    409,
  );
});

test("a smaller picture is sent after the file, counted, and offered", async () => {
  const { maxer, channel, usage, bytes } = await setup();
  const begun = (await (
    await maxer.post("/v1/files/uploads", {
      channelId: channel.id,
      name: "p.png",
      mime: "image/png",
      bytes: 5000,
      thumbBytes: 800,
      width: 640,
      height: 480,
    })
  ).json()) as { fileId: string; upload: string; thumbUpload: string };
  assert.ok(begun.thumbUpload);
  assert.equal((await maxer.put(begun.upload, bytes(5000))).status, 200);
  assert.equal((await usage()).bytesReserved, 800, "the picture is still set aside");
  assert.equal((await maxer.put(begun.thumbUpload, bytes(800))).status, 200);
  assert.deepEqual([(await usage()).bytesReserved, (await usage()).bytesUsed], [0, 5800]);
  const message = (await (
    await maxer.post(`/v1/channels/${channel.id}/messages`, { body: "", fileIds: [begun.fileId] })
  ).json()) as ChatMessage;
  assert.deepEqual(
    [message.files[0]?.thumb, message.files[0]?.width, message.files[0]?.height],
    [true, 640, 480],
  );
  const link = (await (
    await maxer.post(`/v1/files/${begun.fileId}/link`, { variant: "thumb" })
  ).json()) as { path: string };
  assert.equal((await (await maxer.fetch(link.path)).arrayBuffer()).byteLength, 800);
  assert.equal((await maxer.post("/v1/files/nope/link", { variant: "thumb" })).status, 404);
});

test("a smaller picture is served as the kind it is, a JPEG from a phone included", async () => {
  const { maxer, channel, bytes } = await setup();
  const begun = (await (
    await maxer.post("/v1/files/uploads", {
      channelId: channel.id,
      name: "p.jpg",
      mime: "image/jpeg",
      bytes: 4000,
      thumbBytes: 600,
    })
  ).json()) as { fileId: string; upload: string; thumbUpload: string };
  await maxer.put(begun.upload, bytes(4000));
  assert.equal(
    (await maxer.put(begun.thumbUpload, bytes(600), { "content-type": "image/jpeg" })).status,
    200,
  );
  const link = (await (
    await maxer.post(`/v1/files/${begun.fileId}/link`, { variant: "thumb" })
  ).json()) as { path: string };
  assert.equal((await maxer.fetch(link.path)).headers.get("content-type"), "image/jpeg");
});

test("what a smaller picture says it is cannot make it a page", async () => {
  const { maxer, channel, bytes } = await setup();
  const begun = (await (
    await maxer.post("/v1/files/uploads", {
      channelId: channel.id,
      name: "p.png",
      mime: "image/png",
      bytes: 100,
      thumbBytes: 50,
    })
  ).json()) as { fileId: string; upload: string; thumbUpload: string };
  await maxer.put(begun.upload, bytes(100));
  await maxer.put(begun.thumbUpload, bytes(50), { "content-type": "text/html" });
  const link = (await (
    await maxer.post(`/v1/files/${begun.fileId}/link`, { variant: "thumb" })
  ).json()) as { path: string };
  assert.equal((await maxer.fetch(link.path)).headers.get("content-type"), "image/webp");
});

test("deleting a channel clears its files and gives back their room", async () => {
  const { stack, maxer, channel, upload, usage } = await setup();
  const { body } = await upload(maxer, 4 * MB);
  await maxer.post(`/v1/channels/${channel.id}/messages`, { body: "x", fileIds: [body?.fileId] });
  assert.equal((await stack.as(mia).del(`/v1/channels/${channel.id}`)).status, 403);
  assert.equal((await maxer.del(`/v1/channels/${channel.id}`)).status, 200);
  assert.equal((await usage()).bytesUsed, 0);
  await stack.maintain();
  assert.equal(stack.bucket.objects.size, 0);
  assert.equal((await maxer.get(`/v1/channels/${channel.id}/messages`)).status, 404);
  // A direct message is never deleted.
  const dm = (await (await stack.as(mia).post("/v1/dms", { email: "max@example.com" })).json()) as {
    id: string;
  };
  assert.equal((await stack.as(mia).del(`/v1/channels/${dm.id}`)).status, 409);
});
