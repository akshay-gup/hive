import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const asset = (name: string) => join(here, "../assets", name);
const source = (name: string) => join(here, "../src", name);

for (const loop of [1, 2, 3]) {
  test(`bee loop ${loop} is a transparent animated WebP, 352 by 288, small enough to load on a screen`, () => {
    const bytes = readFileSync(asset(`bee-idle-${loop}.webp`));
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
    // The extended header says whether it moves, whether it has transparency, and how big the canvas is.
    assert.equal(bytes.toString("ascii", 12, 16), "VP8X");
    assert.ok(bytes[20] & 0x02, "it is animated");
    assert.ok(bytes[20] & 0x10, "it has transparency");
    assert.deepEqual([bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1], [352, 288]);
    const frames = bytes.toString("latin1").split("ANMF").length - 1;
    assert.ok(frames >= 60, `${frames} frames is too few for a loop of several seconds`);
    assert.ok(bytes.length < 1_000_000, `${bytes.length} bytes is too heavy for a loading screen`);
  });
}

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
