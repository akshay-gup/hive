import assert from "node:assert/strict";
import { test } from "node:test";
import { fitTo, fitted, resizable, worthShrinking } from "../src/chat-image.ts";

test("a picture is fitted on its longer side, and one that already fits is left", () => {
  assert.deepEqual(fitTo(4000, 3000, 2048), { width: 2048 });
  assert.deepEqual(fitTo(3000, 4000, 2048), { height: 2048 });
  assert.deepEqual(fitTo(3000, 3000, 400), { width: 400 });
  assert.equal(fitTo(2048, 1000, 2048), null);
  assert.equal(fitTo(100, 100, 400), null);
  assert.equal(fitTo(0, 100, 400), null, "a size that is not known is left alone");
  assert.deepEqual(fitted(4000, 3000, 2048), { width: 2048, height: 1536 });
  assert.deepEqual(fitted(100, 50, 400), { width: 100, height: 50 });
});

test("only pictures of the usual kinds are made smaller", () => {
  for (const mime of ["image/png", "image/jpeg", "image/JPG", "image/webp", "image/heic"])
    assert.ok(resizable(mime), mime);
  for (const mime of ["image/gif", "image/svg+xml", "application/pdf", "video/mp4"])
    assert.equal(resizable(mime), false, mime);
});

test("a small picture is sent as it is, a big or heavy one is shrunk", () => {
  assert.equal(worthShrinking(1200, 800, 400_000), false);
  assert.equal(worthShrinking(4000, 3000, 400_000), true);
  assert.equal(worthShrinking(1200, 800, 3 * 1024 ** 2), true);
});
