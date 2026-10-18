import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("web-only code does not call React Native's Image.resolveAssetSource, which react-native-web does not have", () => {
  // It once took the screen after sign-in down: the call threw, and nothing caught it, so the page was blank.
  const root = new URL("../src", import.meta.url).pathname;
  const offenders: string[] = [];
  for (const folder of ["", "hosted"]) {
    for (const name of readdirSync(join(root, folder))) {
      if (!/\.web\.tsx?$/.test(name)) continue;
      const text = readFileSync(join(root, folder, name), "utf8");
      if (/\bresolveAssetSource\b/.test(text)) offenders.push(join(folder, name));
    }
  }
  assert.deepEqual(offenders, []);
});
