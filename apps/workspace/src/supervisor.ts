import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

type Env = Record<string, string | undefined>;

/** Where `opencode serve` listens inside the workspace: nothing outside the machine can reach it. */
export const OPENCODE_HOST = "127.0.0.1";
export const OPENCODE_PORT = 4096;
export const OPENCODE_URL = `http://${OPENCODE_HOST}:${OPENCODE_PORT}`;

export interface WorkspaceSecrets {
  /** Encrypts the credentials the workspace keeps (TOKEN_ENCRYPTION_KEY). */
  tokenEncryptionKey: string;
  /** What the workspace server uses to talk to the agent, and nothing else does (OPENCODE_SERVER_PASSWORD). */
  opencodePassword: string;
}

/**
 * The secrets a workspace makes for itself the first time it starts, kept on its volume. They are
 * made here rather than passed in, so they exist nowhere else: not in the machine's settings and
 * not in the control plane. Losing them loses what they encrypt, so a file that cannot be read is
 * an error and never a reason to make new ones.
 */
export function loadSecrets(dir: string): WorkspaceSecrets {
  const file = join(dir, "secrets.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fresh: WorkspaceSecrets = {
    tokenEncryptionKey: randomBytes(32).toString("base64"),
    opencodePassword: randomBytes(32).toString("hex"),
  };
  try {
    writeFileSync(file, JSON.stringify(fresh), { flag: "wx", mode: 0o600 });
    return fresh;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let stored: Partial<WorkspaceSecrets>;
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    stored = {};
  }
  if (
    typeof stored.tokenEncryptionKey !== "string" ||
    Buffer.from(stored.tokenEncryptionKey, "base64").length !== 32 ||
    typeof stored.opencodePassword !== "string" ||
    stored.opencodePassword.length < 32
  )
    throw new Error(
      `${file} is damaged. It is not replaced, because the credentials it protects could not be ` +
        "read again; restore it from a backup of the volume.",
    );
  return {
    tokenEncryptionKey: stored.tokenEncryptionKey,
    opencodePassword: stored.opencodePassword,
  };
}

/**
 * Settings kept in a file instead of the environment, for a workspace on a machine of its own: a
 * JSON object of strings, written where only root can read it. A file that cannot be used stops
 * the workspace, and what it says is never repeated in the message, since it holds provider keys.
 */
export function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `${path} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== "string")
  )
    throw new Error(`${path} must be a JSON object of strings`);
  return parsed as Record<string, string>;
}

/**
 * The environment with the file HIVE_ENV_FILE names laid over it. What the file says wins over the
 * machine's own defaults, since the file is the one thing written for this workspace.
 */
export function withEnvFile(env: Env): Env {
  const path = env.HIVE_ENV_FILE?.trim();
  if (!path) return env;
  const { HIVE_ENV_FILE: _named, ...rest } = env;
  return { ...rest, ...readEnvFile(path) };
}

/** Settings that belong to the workspace server and are not for the agent, which can print its environment. */
const SERVER_ONLY = [
  "TOKEN_ENCRYPTION_KEY",
  "DATABASE_URL",
  "GOOGLE_CLIENT_SECRET",
  "WORKER_TOKEN",
  "CPK_INTELLIGENCE_API_KEY",
  "TYPESAFE_API_KEY",
];

const defined = (env: Env): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >;

/**
 * What the agent runs with: the machine's settings (its model and provider keys among them),
 * minus the server's own, and a place on the volume to keep its sessions. It is pinned to the
 * version in the image and does not share what it does.
 */
export function agentEnv(
  env: Env,
  secrets: WorkspaceSecrets,
  volumeDir: string,
  home?: string,
): Record<string, string> {
  const own = defined(env);
  for (const name of SERVER_ONLY) delete own[name];
  return {
    ...own,
    ...(home ? { HOME: home } : {}),
    XDG_DATA_HOME: join(volumeDir, "opencode", "data"),
    XDG_STATE_HOME: join(volumeDir, "opencode", "state"),
    OPENCODE_SERVER_PASSWORD: secrets.opencodePassword,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_SHARE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
  };
}

/** What the workspace server runs with: the machine's settings, its secrets, and where the agent is. */
export function serverEnv(
  env: Env,
  secrets: WorkspaceSecrets,
  home?: string,
): Record<string, string> {
  return {
    ...defined(env),
    ...(home ? { HOME: home } : {}),
    TOKEN_ENCRYPTION_KEY: secrets.tokenEncryptionKey,
    OPENCODE_SERVER_URL: OPENCODE_URL,
    OPENCODE_SERVER_PASSWORD: secrets.opencodePassword,
  };
}

export interface ChildSpec {
  name: string;
  command: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface SupervisorSpec {
  /** Started first; the server is not started until it answers `healthUrl`. */
  agent: ChildSpec & { healthUrl: string; headers?: Record<string, string> };
  server: ChildSpec;
  /** How long the agent gets to answer before the workspace gives up and exits. */
  healthTimeoutMs: number;
  /** How long a process gets to stop when asked, before it is killed. */
  graceMs: number;
  pollMs?: number;
  /** The supervisor's own notes, and every line the two processes print, each with who said it. */
  log: (line: string) => void;
}

interface Running {
  name: string;
  child: ChildProcess;
  done: boolean;
  exited: Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs a workspace's two processes: the agent, then the server once the agent answers. If either
 * stops by itself the other is stopped and the supervisor ends in failure, so the machine's
 * restart policy starts the pair again from a clean slate. When asked to stop, the server goes
 * first, so it can end its runs and close its database while the agent is still there.
 */
export class Supervisor {
  private requested = false;
  private wake: () => void = () => {};
  private readonly stopRequested = new Promise<void>((resolve) => {
    this.wake = resolve;
  });
  constructor(private readonly spec: SupervisorSpec) {}

  stop(reason: string) {
    if (this.requested) return;
    this.requested = true;
    this.spec.log(`[supervisor] stopping: ${reason}`);
    this.wake();
  }

  /** Resolves with the exit code once both processes have stopped: 0 for a stop that was asked for. */
  async run(): Promise<number> {
    const agent = this.launch(this.spec.agent);
    let server: Running | undefined;
    let code = 0;
    try {
      if (!(await this.waitForAgent(agent))) return this.requested ? 0 : 1;
      server = this.launch(this.spec.server);
      const first = await Promise.race([
        this.stopRequested.then(() => "stop" as const),
        agent.exited.then(() => agent.name),
        server.exited.then(() => server?.name ?? ""),
      ]);
      if (first !== "stop") {
        this.spec.log(`[supervisor] ${first} stopped on its own`);
        code = 1;
      }
      return code;
    } finally {
      if (server) await this.terminate(server);
      await this.terminate(agent);
    }
  }

  private async waitForAgent(agent: Running): Promise<boolean> {
    const until = Date.now() + this.spec.healthTimeoutMs;
    while (Date.now() < until && !this.requested && !agent.done) {
      if (await this.answers()) return true;
      await sleep(this.spec.pollMs ?? 250);
    }
    if (agent.done) this.spec.log(`[supervisor] ${agent.name} stopped before it was ready`);
    else if (!this.requested)
      this.spec.log(
        `[supervisor] ${agent.name} did not answer in ${Math.round(this.spec.healthTimeoutMs / 1000)}s`,
      );
    return false;
  }

  private async answers(): Promise<boolean> {
    try {
      const response = await fetch(this.spec.agent.healthUrl, {
        headers: this.spec.agent.headers,
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private launch(spec: ChildSpec): Running {
    const [command, ...args] = spec.command;
    const child = spawn(command as string, args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const running: Running = {
      name: spec.name,
      child,
      done: false,
      exited: new Promise<void>((resolve) => {
        child.once("close", (code, signal) => {
          running.done = true;
          this.spec.log(`[supervisor] ${spec.name} exited (${signal ?? `code ${code}`})`);
          resolve();
        });
        child.once("error", (error) => {
          this.spec.log(`[supervisor] could not run ${spec.name}: ${error.message}`);
          running.done = true;
          resolve();
        });
      }),
    };
    this.relay(child.stdout, spec.name);
    this.relay(child.stderr, spec.name);
    return running;
  }

  /** Pass a process's output on a line at a time, so two processes' lines never run together. */
  private relay(stream: Readable | null, name: string) {
    if (!stream) return;
    stream.setEncoding("utf8");
    let rest = "";
    stream.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) this.spec.log(`[${name}] ${line}`);
    });
    stream.on("end", () => {
      if (rest) this.spec.log(`[${name}] ${rest}`);
    });
  }

  private async terminate(running: Running) {
    if (running.done) return;
    running.child.kill("SIGTERM");
    const impatient = setTimeout(() => {
      this.spec.log(`[supervisor] ${running.name} did not stop in time; killing it`);
      running.child.kill("SIGKILL");
    }, this.spec.graceMs);
    await running.exited;
    clearTimeout(impatient);
  }
}
