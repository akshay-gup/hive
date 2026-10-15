import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../apps/workspace/vm/bake.sh", import.meta.url);

test("bash goes on finding a program it has run after the file is gone, which is why the bake clears what it remembers", () => {
  const dir = mkdtempSync(join(tmpdir(), "bake-hash-"));
  try {
    writeFileSync(join(dir, "fakedocker"), "#!/bin/sh\n", { mode: 0o755 });
    // The way fetch runs docker and seal then removes it, in one shell.
    const found = (clear: string) =>
      execFileSync(
        "bash",
        [
          "-c",
          `PATH="${dir}:$PATH"; fakedocker; rm "${dir}/fakedocker"; ${clear} command -v fakedocker >/dev/null && echo found || echo gone`,
        ],
        { encoding: "utf8" },
      ).trim();
    assert.equal(found(""), "found");
    assert.equal(found("hash -r;"), "gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seal clears what bash remembers before it checks that docker is gone", async () => {
  const { readFileSync } = await import("node:fs");
  const seal = /^seal\(\) \{\n([\s\S]*?)\n\}$/m.exec(readFileSync(script, "utf8"))?.[1] ?? "";
  const clear = seal.indexOf("hash -r");
  const check = seal.indexOf("command -v docker");
  assert.ok(clear !== -1 && check !== -1, "seal clears the hash and checks for docker");
  assert.ok(clear < check, "and clears it first");
});
