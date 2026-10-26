import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Whether something the agent is about to do reaches what belongs to the machine and not to the agent:
 * the workspace's database and keys, the files kept for the whole workspace, other channels' folders,
 * the machine's settings and environment. The agent has the machine, so this does not stop anything: it
 * reads what a tool was asked to open, or the words of a shell command, and says what it would touch.
 * A command that hides its target (built up in pieces, read out of a script file) is not seen; the
 * known misses are listed in `tests/agent-watch-classify.test.ts` so nobody takes this for a lock.
 */

export type WatchRuleName =
  | "database"
  | "keys"
  | "files"
  | "other-channel"
  | "environment"
  | "obfuscation";
type Severity = "low" | "medium" | "high";

export interface Finding {
  rule: WatchRuleName;
  severity: Severity;
  /** What would be touched, as a full path ("(command)" for a command that hides what it opens). */
  target: string;
  source: "command" | "file-tool";
}

export interface WatchSetup {
  /** The workspace server's data directory. */
  dataDir: string;
  /** The folders this run works in and may open: its channel's folder, a task's own. */
  allowedDirs: string[];
}

export interface ProtectedRoot {
  path: string;
  rule: WatchRuleName;
  severity: Severity;
}

/** What is kept apart, by where it lives. Also what the stricter mode refuses the agent's file tools. */
export function protectedRoots(dataDir: string): ProtectedRoot[] {
  const base = realOrSelf(resolve(dataDir));
  return [
    { path: join(base, "postgres"), rule: "database", severity: "high" },
    { path: join(base, "session-signing-key"), rule: "keys", severity: "high" },
    { path: "/etc/hive", rule: "keys", severity: "high" },
    { path: "/var/lib/hive", rule: "keys", severity: "medium" },
    { path: join(base, "files"), rule: "files", severity: "medium" },
    { path: join(base, "task-files"), rule: "files", severity: "medium" },
    { path: join(base, "browser-shots"), rule: "files", severity: "medium" },
    { path: join(base, "owners"), rule: "other-channel", severity: "medium" },
  ];
}

export function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const within = (path: string, root: string) => path === root || path.startsWith(root + sep);

/** The rule a full path falls under, if any. */
function ruleOf(path: string, roots: ProtectedRoot[], allowed: string[]): ProtectedRoot | null {
  if (/^\/proc\/(?:\d+|self|thread-self)\/environ$/.test(path))
    return { path, rule: "environment", severity: "high" };
  if (allowed.some((dir) => within(path, dir))) return null;
  return roots.find((root) => within(path, root.path)) ?? null;
}

/** `~`, `$HOME` and the like worked out, then made full and clean against where the command is. */
function fullPath(
  raw: string,
  cwd: string,
  env: Record<string, string | undefined>,
): string | null {
  let word = raw;
  if (word === "~" || word.startsWith("~/")) word = (env.HOME ?? "~") + word.slice(1);
  word = word.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, a: string, b: string) => {
    const value = env[a ?? b];
    return value === undefined ? whole : value;
  });
  if (word.includes("$") || word.includes("\0")) return null;
  const full = isAbsolute(word) ? resolve(word) : resolve(cwd, word);
  return realOrSelf(full);
}

const hasGlob = (word: string) => /[*?[]/.test(word);

/** One piece of a glob as a pattern for the same piece of a path. */
const pieceMatcher = (piece: string) =>
  new RegExp(
    `^${piece
      .replace(/[.+^${}()|\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")}$`,
  );

/** Whether a word with wildcards could name a path at or below a protected one. */
function globReaches(word: string, cwd: string, roots: ProtectedRoot[]): ProtectedRoot | null {
  const pattern = isAbsolute(word) ? word : join(cwd, word);
  const parts = pattern.split("/");
  return (
    roots.find((root) => {
      const wanted = root.path.split("/");
      if (parts.length < wanted.length) return false;
      return wanted.every((piece, i) => pieceMatcher(parts[i] ?? "").test(piece));
    }) ?? null
  );
}

/** The words of a shell command: quotes taken off, split at spaces, `;`, `|`, `&`, brackets and redirections. */
function words(command: string): string[][] {
  const segments: string[][] = [[]];
  let word = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  const end = () => {
    if (started) segments[segments.length - 1]?.push(word);
    word = "";
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      started = true;
    } else if (c === ";" || c === "|" || c === "&" || c === "\n") {
      end();
      segments.push([]);
    } else if (/[\s()`<>{}]/.test(c)) {
      end();
    } else {
      word += c;
      started = true;
    }
  }
  end();
  return segments.filter((segment) => segment.length > 0);
}

/** Absolute and home paths written anywhere in the text, even inside a quoted script. */
const pathsIn = (text: string): string[] =>
  text.match(/(?:~|\$HOME|\$\{HOME\})?\/[\w.@+\-/*?[\]]+|~(?=\s|$)/g) ?? [];

const HIDES = /\b(?:base64|xxd|openssl\s+enc|eval|python\d?\s+-c|perl\s+-e|ruby\s+-e|node\s+-e)\b/;
const PROTECTED_WORDS = /postgres|session-signing-key|task-files|\/etc\/hive|environ|\/owners\//;

const FILE_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "patch",
  "apply_patch",
  "grep",
  "glob",
  "list",
]);

export function classify(args: {
  tool: string;
  input: unknown;
  cwd: string;
  env: Record<string, string | undefined>;
  setup: WatchSetup;
}): Finding[] {
  const { tool, cwd, env, setup } = args;
  const input = (args.input && typeof args.input === "object" ? args.input : {}) as Record<
    string,
    unknown
  >;
  const roots = protectedRoots(setup.dataDir);
  const allowed = setup.allowedDirs.map((dir) => realOrSelf(resolve(dir)));
  const found = new Map<string, Finding>();
  const add = (finding: Finding) => {
    const key = `${finding.rule}:${finding.target}`;
    if (!found.has(key)) found.set(key, finding);
  };
  const base = realOrSelf(resolve(setup.dataDir));
  /** What the command being read does with a folder it is given: only list it, or walk everything under it. */
  let listing = false;
  let walking = false;
  const check = (word: string, from: string, source: Finding["source"]) => {
    if (!word) return;
    if (hasGlob(word)) {
      // A pattern inside a folder the run may open stays there.
      const literal = word.split("/").slice(0, word.split("/").findIndex(hasGlob)).join("/");
      const base = isAbsolute(word) ? resolve(literal || "/") : resolve(from, literal);
      if (allowed.some((dir) => within(realOrSelf(base), dir))) return;
      const root = globReaches(word, from, roots);
      if (root) add({ rule: root.rule, severity: root.severity, target: word, source });
      return;
    }
    const full = fullPath(word, from, env);
    if (!full) return;
    const root = ruleOf(full, roots, allowed);
    if (root) {
      add({ rule: root.rule, severity: root.severity, target: full, source });
    } else if (source === "command" && !listing && full === base) {
      // The whole data folder handed to a command that is not just looking at its names.
      add({ rule: "files", severity: "medium", target: full, source });
    } else if (
      walking &&
      !allowed.some((dir) => within(full, dir)) &&
      (full === base || roots.some((r) => r.path.startsWith(`${full === "/" ? "" : full}${sep}`)))
    ) {
      add({ rule: "files", severity: "low", target: full, source });
    }
  };

  const name = tool.toLowerCase();
  if (FILE_TOOLS.has(name)) {
    walking = name === "grep" || name === "glob";
    for (const key of ["filePath", "path", "file", "directory"]) {
      const value = input[key];
      if (typeof value === "string") check(value, cwd, "file-tool");
    }
    // A search or a pattern that names a full path reaches it as well.
    for (const key of ["pattern", "include"]) {
      const value = input[key];
      if (typeof value === "string" && value.startsWith("/")) check(value, cwd, "file-tool");
    }
    return [...found.values()];
  }
  if (name !== "bash" && name !== "shell") return [];

  const command = typeof input.command === "string" ? input.command : "";
  if (!command) return [];
  let here = cwd;
  for (const segment of words(command)) {
    const [first = "", ...rest] = segment;
    const flags = rest.filter((word) => /^-[A-Za-z]/.test(word));
    const has = (letter: string) =>
      flags.some((word) => !word.startsWith("--") && word.includes(letter));
    walking =
      [
        "find",
        "tree",
        "du",
        "tar",
        "zip",
        "rsync",
        "cp",
        "scp",
        "locate",
        "mlocate",
        "rg",
        "ag",
      ].includes(first) ||
      (["grep", "egrep", "fgrep"].includes(first) &&
        (has("r") || has("R") || rest.includes("--recursive"))) ||
      (first === "ls" && has("R"));
    listing = ["ls", "cd", "pwd", "stat", "test", "["].includes(first) && !walking;
    if (first === "cd" || first === "pushd") {
      const next = rest.find((word) => !word.startsWith("-")) ?? env.HOME ?? here;
      const full = fullPath(next, here, env);
      if (full) here = full;
      check(next, here, "command");
      continue;
    }
    const dumpsEnvironment =
      first === "printenv" ||
      (first === "env" && rest.every((word) => word.startsWith("-"))) ||
      ((first === "export" || first === "declare") && rest[0] === "-p") ||
      (first === "set" && rest.length === 0);
    if (dumpsEnvironment)
      add({ rule: "environment", severity: "medium", target: "(environment)", source: "command" });
    // Paths written inside a quoted script count as well.
    for (const written of pathsIn(segment.join(" "))) check(written, here, "command");
    for (const word of segment) {
      check(word, here, "command");
      // An option's value: --file=/path
      const equals = word.indexOf("=");
      if (word.startsWith("-") && equals > 0) check(word.slice(equals + 1), here, "command");
    }
  }
  if (HIDES.test(command) && PROTECTED_WORDS.test(command) && found.size === 0)
    add({ rule: "obfuscation", severity: "low", target: "(command)", source: "command" });
  return [...found.values()];
}

const PATH_ASKS = new Set([
  "read",
  "edit",
  "write",
  "patch",
  "apply_patch",
  "grep",
  "glob",
  "list",
  "external_directory",
]);

/**
 * The same, for what the agent has asked leave to do before doing it: a permission names a tool and the
 * paths or the command it wants. Only here can anything be turned down before it happens.
 */
export function classifyAsk(args: {
  permission: string;
  patterns: string[];
  metadata?: unknown;
  cwd: string;
  env: Record<string, string | undefined>;
  setup: WatchSetup;
}): Finding[] {
  const { permission, patterns, cwd, env, setup } = args;
  const meta = (args.metadata ?? {}) as { command?: unknown; filepath?: unknown };
  const found = new Map<string, Finding>();
  const keep = (list: Finding[]) => {
    // One finding to a rule: the command and the folder it was asked as are one thing.
    for (const finding of list) if (!found.has(finding.rule)) found.set(finding.rule, finding);
  };
  const asRead = (path: string) =>
    classify({ tool: "read", input: { filePath: path }, cwd, env, setup });
  const asBash = (command: string) =>
    classify({ tool: "bash", input: { command }, cwd, env, setup });
  // A shell command that reaches outside the folder it works in is asked about as that folder, with the
  // command it came from alongside: the command says more than the folder does.
  if (typeof meta.command === "string") keep(asBash(meta.command));
  else if (permission === "bash") keep(asBash(patterns.join(" ; ")));
  if (typeof meta.filepath === "string") keep(asRead(meta.filepath));
  if (PATH_ASKS.has(permission))
    for (const pattern of patterns) {
      keep(asRead(pattern));
      // OpenCode leaves the first slash off the path of a file it asks to read.
      if (!/^[/~.]/.test(pattern)) keep(asRead(`/${pattern}`));
    }
  return [...found.values()];
}
