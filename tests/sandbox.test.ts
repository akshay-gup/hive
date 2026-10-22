import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const sandbox = new URL("../apps/workspace/vm/hive-sandbox", import.meta.url).pathname;

/** Landlock is in every kernel of the machines a workspace runs on; a box that lacks it cannot test it. */
const landlock =
  spawnSync("python3", [
    "-c",
    "import ctypes,sys;sys.exit(0 if ctypes.CDLL(None).syscall(444,None,0,1)>0 else 1)",
  ]).status === 0;

/**
 * A volume the way a workspace keeps one: an open channel, a private one, a person's own agent, and
 * what the workspace keeps for itself. Each holds a file called `note`.
 */
function volume() {
  // Not under /tmp, which a command may write to: the volume is the one place it may not.
  const base = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "hive-sandbox-"));
  const root = join(dir, "vol");
  const data = join(root, "hive");
  const folder = (...parts: string[]) => {
    const path = join(data, "owners", ...parts);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "note"), parts.join("/"));
    return path;
  };
  const places = {
    open: folder("shared", "channels", "open"),
    other: folder("shared", "channels", "other"),
    secret: folder("shared", "channels", "secret"),
    ada: folder("ada", "channels", "orchestrator"),
  };
  mkdirSync(join(root, "opencode"), { recursive: true });
  writeFileSync(join(root, "secrets.json"), "the keys");
  writeFileSync(join(data, "records.db"), "the records");
  const home = join(dir, "home");
  mkdirSync(home);
  const policy = join(root, "policy.json");
  const write = (value: object) => writeFileSync(policy, JSON.stringify(value));
  write({ version: 1, confine: true, dataDir: data, private: [places.secret] });
  const run = (cwd: string, command: string, env: Record<string, string> = {}) =>
    spawnSync("python3", [sandbox, "-c", command], {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        HIVE_SANDBOX_POLICY: policy,
        HIVE_SANDBOX_VOLUME: root,
        ...env,
      },
    });
  return {
    dir,
    root,
    data,
    home,
    places,
    policy,
    write,
    run,
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a channel's command reads and writes its own folder and reads the open channels", {
  skip: !landlock,
}, () => {
  const v = volume();
  try {
    const ran = v.run(
      v.places.open,
      `cat note && echo more > made && cat made && cat ${v.places.other}/note`,
    );
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, "shared/channels/open" + "more\n" + "shared/channels/other");
    // It can write where it is, and read what the open channel next to it holds, and not write there.
    const write = v.run(v.places.open, `echo no > ${v.places.other}/note`);
    assert.notEqual(write.status, 0);
    assert.equal(readFileSync(join(v.places.other, "note"), "utf8"), "shared/channels/other");
  } finally {
    v.done();
  }
});

test("a command cannot reach a private channel, another person's agent, or what the workspace keeps", {
  skip: !landlock,
}, () => {
  const v = volume();
  try {
    const files = [
      join(v.places.secret, "note"),
      join(v.places.ada, "note"),
      join(v.root, "secrets.json"),
      join(v.data, "records.db"),
    ];
    for (const target of files) {
      const ran = v.run(v.places.open, `cat ${target}`);
      assert.notEqual(ran.status, 0, `${target} was read: ${ran.stdout}`);
      assert.equal(ran.stdout, "");
    }
    // Nor can what is in a folder be listed (the name of a file is not shut away, its contents are).
    for (const target of [v.places.secret, v.places.ada, join(v.root, "opencode"), v.data]) {
      const ran = v.run(v.places.open, `ls -A ${target}`);
      assert.notEqual(ran.status, 0, `${target} was listed: ${ran.stdout}`);
      assert.equal(ran.stdout, "");
    }
    // Not by writing either, nor by making a name in the folder of the private channel.
    const write = v.run(v.places.open, `echo x > ${v.places.secret}/new`);
    assert.notEqual(write.status, 0);
    assert.equal(existsSync(join(v.places.secret, "new")), false);
  } finally {
    v.done();
  }
});

test("a private channel's command has its own folder and no other private one", {
  skip: !landlock,
}, () => {
  const v = volume();
  try {
    const own = v.run(v.places.secret, "cat note && echo x > made");
    assert.equal(own.status, 0, own.stderr);
    assert.equal(own.stdout, "shared/channels/secret");
    // A person's own agent keeps what it is told to itself as well.
    const mine = v.run(v.places.ada, `cat note; cat ${v.places.secret}/note`);
    assert.equal(mine.stdout, "ada/channels/orchestrator");
    assert.notEqual(mine.status, 0);
  } finally {
    v.done();
  }
});

test("a command may use its home, /tmp, the programs on the machine and the network's own tools", {
  skip: !landlock,
}, () => {
  const v = volume();
  try {
    const ran = v.run(
      v.places.open,
      `echo a > "$HOME/file" && cat "$HOME/file" && d=$(mktemp -d) && echo b > $d/f && cat $d/f && python3 -c 'print(1+1)' && ls /usr/bin >/dev/null && (echo hi | sed s/hi/ok/) && ln -s note link && ls -l link >/dev/null`,
    );
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, "a\nb\n2\nok\n");
  } finally {
    v.done();
  }
});

test("a command does not have the machine's keys, and cannot use sudo to get past all of this", {
  skip: !landlock,
}, () => {
  const v = volume();
  try {
    const ran = v.run(v.places.open, "env", {
      OPENCODE_SERVER_PASSWORD: "open-sesame",
      ANTHROPIC_API_KEY: "sk-ant",
      WORKER_TOKEN: "w",
      XDG_DATA_HOME: join(v.root, "opencode"),
      KEEP_ME: "yes",
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /KEEP_ME=yes/);
    for (const gone of ["open-sesame", "sk-ant", "WORKER_TOKEN", "XDG_DATA_HOME", "HIVE_SANDBOX"])
      assert.doesNotMatch(ran.stdout, new RegExp(gone));
    // Setuid programs are switched off in a confined command, so `sudo` and `su` do nothing there.
    const status = v.run(v.places.open, "grep NoNewPrivs /proc/self/status");
    assert.match(status.stdout, /NoNewPrivs:\s+1/);
  } finally {
    v.done();
  }
});

test("a link out of the channel is removed when the command that made it is done", {
  skip: !landlock,
}, () => {
  const v = volume();
  try {
    const ran = v.run(
      v.places.open,
      `ln -s ${v.places.secret}/note out && ln -s /usr/bin/env tool && ln -s note inside && ls`,
    );
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stderr, /removed out, a link out of this channel/);
    assert.equal(existsSync(join(v.places.open, "out")), false);
    // A link to a program, and one to a file in the channel, are what a project is made of.
    assert.ok(existsSync(join(v.places.open, "tool")));
    assert.ok(existsSync(join(v.places.open, "inside")));
  } finally {
    v.done();
  }
});

test("a file cannot be linked into a channel from outside it", { skip: !landlock }, () => {
  const v = volume();
  try {
    const ran = v.run(v.places.open, `ln ${v.places.other}/note stolen; cat stolen`);
    assert.equal(existsSync(join(v.places.open, "stolen")), false);
    assert.notEqual(ran.status, 0);
  } finally {
    v.done();
  }
});

test("the command's own exit code and its output come back as they were", {
  skip: !landlock,
}, () => {
  const v = volume();
  try {
    const ran = v.run(v.places.open, "echo out; echo err >&2; exit 7");
    assert.equal(ran.status, 7);
    assert.equal(ran.stdout, "out\n");
    assert.match(ran.stderr, /err/);
    const killed = v.run(v.places.open, "kill -TERM $$");
    assert.equal(killed.status, 128 + 15);
  } finally {
    v.done();
  }
});

test("with nothing private, the command runs open, as it did before", () => {
  const v = volume();
  try {
    v.write({ version: 1, confine: false, dataDir: v.data, private: [] });
    const ran = v.run(v.places.open, `cat ${v.places.secret}/note; cat ${v.root}/secrets.json`, {
      ANTHROPIC_API_KEY: "sk-ant",
    });
    assert.equal(ran.stdout, "shared/channels/secretthe keys");
    assert.equal(
      v.run(v.places.open, "echo $ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: "k" }).stdout,
      "k\n",
    );
    // And with no policy at all, as on a machine whose server has not written one.
    rmSync(v.policy);
    assert.equal(v.run(v.places.open, "echo fine").stdout, "fine\n");
  } finally {
    v.done();
  }
});

test("a policy that is there and cannot be read stops the command instead of opening it", () => {
  const v = volume();
  try {
    writeFileSync(v.policy, "{not json");
    const ran = v.run(v.places.open, "echo ran");
    assert.equal(ran.status, 126);
    assert.equal(ran.stdout, "");
    assert.match(ran.stderr, /could not be read/);
  } finally {
    v.done();
  }
});

test("a link that was already there to a place in the volume is taken off the channel, and the rest stay", {
  skip: !landlock,
}, () => {
  const v = volume();
  try {
    symlinkSync(join(v.data, "records.db"), join(v.places.open, "records"));
    const ran = v.run(v.places.open, "true");
    assert.equal(ran.status, 0);
    assert.equal(existsSync(join(v.places.open, "records")), false);
  } finally {
    v.done();
  }
});
