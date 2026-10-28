import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { RunAgentInput } from "@ag-ui/core";
import type { ChatCore } from "../apps/chat/src/core.ts";
import { createApp } from "../apps/server/src/app.ts";
import { WorkLink } from "../apps/server/src/chat-runner/work-link.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { conversationTools } from "../apps/server/src/engine/tools.ts";
import type { AgentTask, Channel, Project } from "../packages/domain/src/agent.ts";
import {
  generateWorkspaceKeys,
  signWorkspaceToken,
  type WorkspaceRole,
} from "../packages/integrations/src/workspace-token.ts";
import { chatWorld } from "./helpers/chat-world.ts";

/**
 * The agent works for whoever asked, and its tools show and change only what that person could in the
 * app. The board is the chat service's: the tools ask it, as the person, through the same frames the
 * machine uses, and these tests run them against a real room. Every tool is here, either run as someone who may not see or change the thing it is pointed at,
 * or named as one that never reaches a project's, a task's or a channel's records. A new tool that is
 * in neither list fails the last test, so it cannot be added without saying which it is.
 *
 * (The agent's shell is another matter: it has the machine, and no rule here limits that.)
 */
const keys = generateWorkspaceKeys();
const workspaceId = "w1tools";
let db: Store;
let server: Awaited<ReturnType<typeof createApp>>;
let directory: string;

const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  gus: { id: "acct_gus", email: "gus@example.com", name: "Gus", role: "guest" },
} as const satisfies Record<
  string,
  { id: string; email: string; name: string; role: WorkspaceRole }
>;
type Who = keyof typeof people;
const sessions = new Map<Who, string>();
const owner = (who: Who) => `acct:${people[who].id}`;

const call = (who: Who, method: string, path: string, body?: unknown) =>
  server.app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${sessions.get(who)}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const created = async <T>(response: Response): Promise<T> => {
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as T;
};

/** Max's: a private project with a task, a limited one with a task, and a private channel with a goal. */
let secret: Project;
let secretTask: AgentTask;
let limited: Project;
let limitedTask: AgentTask;
let hush: Channel;
let hushGoalId: string;
let core: ChatCore;
/** Mia's own, in General, to point things from. */
let miaTask: AgentTask;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-tool-access-"));
  db = await createStore();
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "https://w1tools.example.test",
    dataDir: directory,
    encryptionKey: randomBytes(32).toString("base64"),
    googleRedirectUri: "https://w1tools.example.test/api/google/callback",
    allowedOrigins: [],
    managed: { workspaceId, controlPublicKey: keys.publicKey },
  };
  server = await createApp(db, config);
  for (const who of Object.keys(people) as Who[]) {
    const person = people[who];
    const response = await server.app.request("/api/auth/managed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: signWorkspaceToken(keys.privateKey, {
          workspaceId,
          sub: person.id,
          email: person.email,
          name: person.name,
          role: person.role,
        }),
      }),
    });
    assert.equal(response.status, 200);
    sessions.set(who, (await response.json()).token);
  }
  // The room: the same people, under the ids the machine knows them by, and the machine's link to it.
  const room = await chatWorld(
    Object.fromEntries(
      Object.entries(people).map(([who, p]) => [who, { ...p, id: owner(who as Who) }]),
    ),
    {
      link: { key: "link-key", workspaceId },
      runner: () => ({
        send: (text) => link.onFrame(JSON.parse(text)),
        close: () => undefined,
      }),
    },
  );
  core = room.core;
  const link: WorkLink = new WorkLink({
    send: (frame) => {
      void core.agent.onFrame(JSON.stringify(frame));
      return true;
    },
    history: async () => ({}),
  });
  server.agent.board = link.board({
    leaseOf: () => undefined,
    ticketOf: (who) => core.agent.boardTicket(who).ticket,
  });
  const manual = (project: Project, title: string) => ({
    title,
    kind: "manual" as const,
    projectId: project.id,
    input: {},
  });
  secret = await core.work.createProject(owner("max"), { name: "Reorg", access: "private" });
  secretTask = await core.work.createTask(owner("max"), manual(secret, "Draft the layoffs memo"));
  limited = await core.work.createProject(owner("max"), { name: "Roadmap", access: "limited" });
  limitedTask = await core.work.createTask(
    owner("max"),
    manual(limited, "Plan the autumn release"),
  );
  hush = (await (
    await room.call("max", "POST", "/v1/channels", { name: "hush", visibility: "private" })
  ).json()) as Channel;
  hushGoalId = (
    await core.goals.create(
      owner("max"),
      { title: "Quietly replace the vendor", description: "Tell no one" },
      { channelId: hush.id },
    )
  ).id;
  miaTask = await core.work.createTask(owner("mia"), {
    title: "Book the offsite",
    kind: "manual",
    input: {},
  });
});
after(async () => {
  await server.agent.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

const input: RunAgentInput = {
  threadId: "t1",
  runId: "r1",
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
};
type Tool = { name: string; parameters: unknown; execute?: unknown };
const toolsFor = (who: Who): Tool[] =>
  conversationTools(server.agent, owner(who), input, {
    signal: new AbortController().signal,
    requestKey: `access-${who}`,
    guest: people[who].role === "guest",
  }) as unknown as Tool[];

/** What the agent is told when it uses a tool: its result, or the words of the error that stopped it. */
async function use(
  who: Who,
  name: string,
  args: object,
): Promise<{ said: string; failed: boolean }> {
  const tool = toolsFor(who).find((candidate) => candidate.name === name);
  assert.ok(tool, `${who} is offered ${name}`);
  try {
    const parsed = (tool.parameters as { parse(value: unknown): unknown }).parse(args);
    const result = await (tool.execute as (args: unknown) => Promise<unknown>)(parsed);
    return { said: JSON.stringify(result ?? null), failed: false };
  } catch (error) {
    return { said: error instanceof Error ? error.message : String(error), failed: true };
  }
}
const stored = (id: string) => core.tasks.get(id);
let routineId = "";

/** The tools that reach the board or a channel's records, each run as someone who must not get through. */
const reaching: Record<string, () => Promise<void>> = {
  async agent_status() {
    // The goal in the private channel is its people's: the one who made it sees it, and no one else.
    const max = (await use("max", "agent_status", {})).said;
    assert.ok(max.includes("Quietly replace the vendor"), "the goal's maker is shown it");
    const mia = (await use("mia", "agent_status", {})).said;
    for (const secretText of [
      secret.id,
      secretTask.id,
      "layoffs",
      hush.id,
      "Quietly replace the vendor",
    ])
      assert.ok(!mia.includes(secretText), `mia is not shown ${secretText}`);
    // What she may see is there, and the owner sees the rest: the check is the person, not the tool.
    assert.ok(mia.includes("Plan the autumn release"));
    const olive = (await use("olive", "agent_status", {})).said;
    assert.ok(olive.includes("layoffs"));
  },
  async update_task() {
    const hidden = await use("mia", "update_task", { taskId: secretTask.id, title: "Seen" });
    assert.ok(hidden.failed && /not (found|there)/i.test(hidden.said), hidden.said);
    const seen = await use("mia", "update_task", { taskId: limitedTask.id, title: "Mine now" });
    assert.ok(seen.failed && /not change|look at/i.test(seen.said), seen.said);
    assert.equal((await stored(secretTask.id))?.title, "Draft the layoffs memo");
    assert.equal((await stored(limitedTask.id))?.title, "Plan the autumn release");
    // Her own task cannot be moved into a project she cannot work in, nor made to wait on one she cannot see.
    for (const patch of [{ projectId: secret.id }, { projectId: limited.id }]) {
      const moved = await use("mia", "update_task", { taskId: miaTask.id, ...patch });
      assert.ok(moved.failed, JSON.stringify(patch));
    }
    const waits = await use("mia", "update_task", {
      taskId: miaTask.id,
      blockedBy: [secretTask.id],
    });
    assert.ok(waits.failed && /not (found|there)/i.test(waits.said), waits.said);
    const goal = await use("mia", "update_task", { taskId: miaTask.id, goalId: hushGoalId });
    assert.ok(goal.failed && /not (found|there)/i.test(goal.said), goal.said);
    assert.deepEqual((await stored(miaTask.id))?.blockedBy, []);
  },
  async delete_task() {
    for (const task of [secretTask, limitedTask]) {
      const refused = await use("mia", "delete_task", { taskId: task.id });
      assert.ok(refused.failed, task.id);
      assert.ok(await stored(task.id), "the task is still there");
    }
  },
  async delegate_task() {
    for (const project of [secret, limited]) {
      const refused = await use("mia", "delegate_task", {
        title: "Take over",
        prompt: "Do it",
        projectId: project.id,
      });
      assert.ok(refused.failed, project.name);
    }
    const goal = await use("mia", "delegate_task", {
      title: "Plan it",
      prompt: "Do it",
      goalId: hushGoalId,
    });
    assert.ok(goal.failed && /not (found|there)/i.test(goal.said), goal.said);
  },
  async create_issue() {
    const private_ = await use("mia", "create_issue", { title: "Sneak in", projectId: secret.id });
    assert.ok(private_.failed && /not (found|there)/i.test(private_.said), private_.said);
    const look = await use("mia", "create_issue", { title: "Sneak in", projectId: limited.id });
    assert.ok(look.failed && /look at/i.test(look.said), look.said);
    // Naming a task she cannot see as what this waits on would tell her it exists.
    const blocked = await use("mia", "create_issue", {
      title: "Wait on it",
      blockedBy: [secretTask.id],
    });
    assert.ok(blocked.failed && /not (found|there)/i.test(blocked.said), blocked.said);
    const real = await use("mia", "create_issue", {
      title: "Wait on it",
      blockedBy: ["no-such-task"],
    });
    assert.equal(real.said, blocked.said.replace(secretTask.id, "no-such-task"));
    const goal = await use("mia", "create_issue", { title: "For it", goalId: hushGoalId });
    assert.ok(goal.failed && /not (found|there)/i.test(goal.said), goal.said);
    // A guest has no goals to point at, even the workspace's own.
    const own = (await use("max", "create_goal", { title: "Ship it" })).said;
    const guestGoal = await use("gus", "create_issue", {
      title: "For it",
      projectId: limited.id,
      goalId: JSON.parse(own).id,
    });
    assert.ok(guestGoal.failed, guestGoal.said);
  },
  async list_routines() {
    const mine = await core.routines.create(
      owner("max"),
      {
        title: "Check the vendor",
        note: "Look at the vendor's page",
        schedule: { kind: "every", minutes: 60 },
      },
      { channelId: hush.id },
    );
    const mia = await use("mia", "list_routines", {});
    assert.ok(!mia.said.includes(mine.id) && !mia.said.includes("Check the vendor"), mia.said);
    const max = await use("max", "list_routines", {});
    assert.ok(max.said.includes("Check the vendor"));
    routineId = mine.id;
  },
  async update_routine() {
    const refused = await use("mia", "update_routine", { routineId, paused: true });
    assert.ok(refused.failed && /not (found|there)/i.test(refused.said), refused.said);
  },
  async remove_routine() {
    const refused = await use("mia", "remove_routine", { routineId });
    assert.ok(refused.failed && /not (found|there)/i.test(refused.said), refused.said);
    assert.ok(core.entries.get(routineId), "the routine is still there");
  },
  async update_project() {
    for (const project of [secret, limited]) {
      const refused = await use("mia", "update_project", { projectId: project.id, name: "Mine" });
      assert.ok(refused.failed, project.name);
    }
    assert.equal(core.projects.get(secret.id)?.name, "Reorg");
  },
  async delete_project() {
    for (const project of [secret, limited]) {
      const refused = await use("mia", "delete_project", { projectId: project.id });
      assert.ok(refused.failed, project.name);
      assert.ok(core.projects.get(project.id), "the project is still there");
    }
  },
};

/** The tools that never reach a project's, a task's or a channel's records, and why. */
const apart: Record<string, string> = {
  present_choices: "only shows options the agent was given, from pages and mail it read",
  browse_web: "reads a public page",
  search_mail:
    "the workspace's one connected mailbox, which is the whole team's, and not offered to a guest",
  read_mail_thread:
    "the workspace's one connected mailbox, which is the whole team's, and not offered to a guest",
  send_file: "only a file in the folder of the channel the run is in",
  request_upload: "asks the people in the channel the run is in",
  create_project: "makes a project the asker runs",
  create_goal: "writes a goal for the asker and reads nothing",
  create_routine: "makes a routine for the asker, in the place the run is in, and reads nothing",
  routine_memo: "keeps a note on the one routine that woke this run, and on no other",
  remember_fact: "writes a memory for the asker and reads nothing",
};

test("each tool that reaches the board or a channel's records is refused to someone who may not", async () => {
  for (const [name, check] of Object.entries(reaching)) {
    await check().catch((error) => {
      error.message = `${name}: ${error.message}`;
      throw error;
    });
  }
});

test("a guest is offered no tool that reads the board", async () => {
  const guest = toolsFor("gus").map((tool) => tool.name);
  for (const name of ["agent_status", "update_task", "delete_task", "delegate_task"])
    assert.ok(!guest.includes(name), name);
});

test("a tool cannot be added without saying whether it reaches the board or a channel's records", () => {
  const offered = toolsFor("olive").map((tool) => tool.name);
  const named = [...Object.keys(reaching), ...Object.keys(apart)];
  assert.deepEqual(
    offered.filter((name) => !named.includes(name)),
    [],
    "Add the tool to `reaching` with a check run as someone who may not use it, or to `apart` with why it never reaches those records",
  );
  assert.deepEqual(
    Object.keys(reaching).filter((name) => Object.keys(apart).includes(name)),
    [],
  );
  // And nothing is listed that is no longer offered (present_choices needs a conversation to be offered).
  assert.deepEqual(
    named.filter((name) => name !== "present_choices" && !offered.includes(name)),
    [],
  );
});
