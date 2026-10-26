import assert from "node:assert/strict";
import test from "node:test";
import { classify, classifyAsk } from "../apps/server/src/agent-watch/classify.ts";

/**
 * The watch reads what a tool was asked to open, or the words of a shell command, and says whether it
 * reaches what belongs to the machine and not to the agent. It marks; it does not stop. So this lists
 * what it must see, what it must leave alone, and what it is known to miss, so nobody takes it for a lock.
 */
const dataDir = "/data/hive";
const own = `${dataDir}/owners/shared/channels/c1`;
const setup = { dataDir, allowedDirs: [own] };
const env = { HOME: "/home/hive" };
const bash = (command: string, cwd = own) =>
  classify({ tool: "bash", input: { command }, cwd, env, setup });
const rules = (command: string, cwd?: string) => bash(command, cwd).map((f) => f.rule);

test("a shell command that reaches the machine's data is seen", () => {
  const seen: [string, string][] = [
    ["cat /data/hive/postgres/PG_VERSION", "database"],
    ["cat ../../../../postgres/PG_VERSION", "database"],
    ["cd /data/hive && ls postgres", "database"],
    ['cat "/data/hive/session-signing-key"', "keys"],
    ["sudo cat /etc/hive/workspace.json", "keys"],
    ["cat /proc/self/environ", "environment"],
    ["cat /proc/1234/environ", "environment"],
    ["printenv", "environment"],
    ["env | grep KEY", "environment"],
    ["cp -r /data/hive/task-files /tmp/x", "files"],
    ["cat /data/hive/owners/shared/channels/c2/notes.md", "other-channel"],
    ["cat /data/hive/owners/acct-max/channels/orchestrator/threads/t.json", "other-channel"],
    ["cat $HOME/../../data/hive/postgres/x", "database"],
    ["cat ~/../../data/hive/postgres/x", "database"],
    ["x=$(cat /data/hive/postgres/x)", "database"],
    ["cat /data/hive/po*/PG_VERSION", "database"],
    ["cat /data/*/postgres/PG_VERSION", "database"],
    [`python3 -c "print(open('/data/hive/postgres/PG_VERSION').read())"`, "database"],
    [`eval "cat /data/hive/post""gres/x"`, "database"],
    ["tar czf /tmp/all.tgz /data/hive", "files"],
    ["find /data -name PG_VERSION", "files"],
    ["grep -r secret /data/hive", "files"],
  ];
  for (const [command, rule] of seen)
    assert.ok(rules(command).includes(rule as never), `${command} → ${rules(command)}`);
});

test("a command the agent runs in its own folder, or that only looks at names, is left alone", () => {
  for (const command of [
    "ls",
    "cat notes.md",
    "cat *.md",
    "ls *",
    "echo hello > out.txt",
    `cat ${own}/threads/x.json`,
    "ls /data/hive",
    "ls /data/opencode",
    "cd /tmp && ls",
    "sudo apt-get install -y ffmpeg",
    "npm install && npm test",
    "git status",
    "cat /etc/os-release",
    "ls -la /data",
  ])
    assert.deepEqual(bash(command), [], command);
});

test("the agent's file tools are read by the path they are given", () => {
  const tool = (name: string, input: object) =>
    classify({ tool: name, input, cwd: own, env, setup }).map((f) => [f.rule, f.source]);
  assert.deepEqual(tool("read", { filePath: "/data/hive/postgres/PG_VERSION" }), [
    ["database", "file-tool"],
  ]);
  assert.deepEqual(tool("grep", { pattern: "x", path: "/data/hive/owners" }), [
    ["other-channel", "file-tool"],
  ]);
  assert.deepEqual(tool("glob", { pattern: "/data/hive/**/*.json" }), [["database", "file-tool"]]);
  assert.deepEqual(tool("grep", { pattern: "x", path: dataDir }), [["files", "file-tool"]]);
  assert.deepEqual(tool("read", { filePath: "notes.md" }), []);
  assert.deepEqual(tool("read", { filePath: `${own}/notes.md` }), []);
  assert.deepEqual(tool("webfetch", { url: "https://example.com" }), []);
});

test("what it does not see (known misses): a path built up in pieces or read from somewhere else", () => {
  for (const command of [
    // The words never hold the path.
    "p=/data/hive/post; q=gres; cat $p$q/PG_VERSION",
    "echo L2RhdGEvaGl2ZS9wb3N0Z3Jlcw== | base64 -d | xargs cat",
    // The path is in a file the shell is told to run.
    "sh ./script.sh",
    // A different route to the same bytes: a link made earlier, a mount, a process's open files.
    "cat /tmp/link-made-earlier/PG_VERSION",
    "cat /proc/self/cwd/PG_VERSION",
  ])
    assert.deepEqual(bash(command), [], command);
});

test("a command that hides what it opens is marked when it also names something kept apart", () => {
  const found = bash("echo hi | base64 | node -e 'x' # postgres");
  assert.deepEqual(
    found.map((f) => f.rule),
    ["obfuscation"],
  );
});

test("a finding says where and how severe", () => {
  const [one] = bash("cat /data/hive/postgres/PG_VERSION");
  assert.deepEqual(one, {
    rule: "database",
    severity: "high",
    target: "/data/hive/postgres/PG_VERSION",
    source: "command",
  });
  assert.equal(bash("find / -name x")[0]?.severity, "low");
});

test("what the agent asks leave for is read the same way, before it is done", () => {
  const ask = (permission: string, patterns: string[], metadata?: object) =>
    classifyAsk({ permission, patterns, metadata, cwd: own, env, setup }).map((f) => f.rule);
  assert.deepEqual(ask("read", ["/data/hive/postgres/PG_VERSION"]), ["database"]);
  assert.deepEqual(ask("external_directory", ["/data/hive/*"]), ["database"]);
  assert.deepEqual(ask("bash", ["cat /data/hive/session-signing-key"]), ["keys"]);
  assert.deepEqual(ask("bash", ["ls"], { command: "cat /etc/hive/workspace.json" }), ["keys"]);
  assert.deepEqual(ask("read", [`${own}/notes.md`]), []);
  // The shapes real OpenCode 1.18.33 asks in: a command or file outside the working folder is asked as the
  // folder, with the command or the file in the metadata; a file inside has its first slash left off.
  assert.deepEqual(
    ask("external_directory", ["/data/hive/postgres/*"], {
      command: "cat /data/hive/postgres/PG_VERSION && ls",
      directories: ["/data/hive/postgres"],
    }),
    ["database"],
  );
  assert.deepEqual(
    ask("external_directory", ["/data/hive/postgres/*"], {
      filepath: "/data/hive/postgres/PG_VERSION",
      parentDir: "/data/hive/postgres",
    }),
    ["database"],
  );
  assert.deepEqual(ask("read", ["data/hive/owners/shared/channels/c2/note"]), ["other-channel"]);
  assert.deepEqual(ask("read", [`${own.slice(1)}/note`]), []);
  assert.deepEqual(ask("bash", ["npm install"]), []);
  assert.deepEqual(ask("webfetch", ["https://example.com"]), []);
  assert.deepEqual(ask("task", ["anything"]), []);
});
