import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { beeFrame } from "../src/bee-frame.ts";

const here = dirname(fileURLToPath(import.meta.url));
const asset = (name: string) => join(here, "../assets", name);
const source = (name: string) => join(here, "../src", name);
/** What a loop may weigh: it is fetched while a person waits. */
const MAX_BYTES = 1_300_000;

/** How long each frame shows, in milliseconds, read from the animation's frame chunks. */
function frameDurations(bytes: Buffer): number[] {
  const durations: number[] = [];
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = bytes.readUInt32LE(at + 4);
    if (bytes.toString("ascii", at, at + 4) === "ANMF")
      durations.push(bytes.readUIntLE(at + 8 + 12, 3));
    at += 8 + size + (size % 2);
  }
  return durations;
}

for (const loop of [1, 2, 3]) {
  test(`bee loop ${loop} is a transparent animated WebP, 352 by 288, at the video's 24 frames a second, small enough to load on a screen`, () => {
    const bytes = readFileSync(asset(`bee-idle-${loop}.webp`));
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
    // The extended header says whether it moves, whether it has transparency, and how big the canvas is.
    assert.equal(bytes.toString("ascii", 12, 16), "VP8X");
    assert.ok(bytes[20] & 0x02, "it is animated");
    assert.ok(bytes[20] & 0x10, "it has transparency");
    assert.deepEqual([bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1], [352, 288]);
    const durations = frameDurations(bytes);
    assert.ok(
      durations.length >= 120,
      `${durations.length} frames is too few for a loop of several seconds`,
    );
    // 24 frames a second is 41 or 42 ms a frame; a loop thinned to 12 would show 83.
    const slowest = Math.max(...durations);
    assert.ok(slowest <= 45, `a frame stays ${slowest} ms, which is under 24 frames a second`);
    assert.ok(bytes.length < MAX_BYTES, `${bytes.length} bytes is too heavy for a loading screen`);
  });
}

test("the moving bee is as wide as the still bee at the same size, and sits in the same place", () => {
  for (const size of [28, 72, 96, 154]) {
    const frame = beeFrame(size);
    // The bee fills its frame's height in width, and the still bee is 466 of its 512 pixels wide.
    assert.ok(
      Math.abs(frame.height - (size * 466) / 512) <= 1,
      `size ${size}: ${frame.height} tall`,
    );
    assert.ok(
      Math.abs(frame.width / frame.height - 352 / 288) < 0.02,
      `size ${size}: the frame's shape`,
    );
    assert.ok(
      Math.abs(frame.left + frame.width / 2 - size / 2) <= 1,
      `size ${size}: centred across`,
    );
    assert.ok(
      Math.abs(frame.top + frame.height / 2 - size / 2) <= 0.06 * size,
      `size ${size}: centred down`,
    );
  }
});

test("the web and the phone both play all three loops, the phone through expo-image", () => {
  for (const file of ["animated-bee.web.tsx", "animated-bee.native.tsx"]) {
    const code = readFileSync(source(file), "utf8");
    for (const loop of [1, 2, 3])
      assert.ok(code.includes(`bee-idle-${loop}.webp`), `${file}: loop ${loop}`);
    // Held still, as the plain bee, when the system asks for less motion.
    assert.ok(code.includes("useStill()") && code.includes("<Mascot"), `${file}: holds still`);
  }
  assert.ok(
    readFileSync(source("animated-bee.native.tsx"), "utf8").includes('from "expo-image"'),
    "the phone's image is the one that animates WebP",
  );
});
