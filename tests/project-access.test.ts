import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentTask, AgentWorkspace, Project } from "../packages/domain/src/agent.ts";
import {
  generateWorkspaceKeys,
  signWorkspaceToken,
  type WorkspaceRole,
} from "../packages/integrations/src/workspace-token.ts";

/**
 * A project is open (the team sees and works on it), limited (the team sees it, its members work on it)
 * or private (only its members see it), as in Jira. Those who run the workspace see all of them. The
 * workspace is a managed one, so people come in with tokens the control plane signed.
 */
const keys = generateWorkspaceKeys();
const workspaceId = "w1project";
let db: Store;
let server: Awaited<ReturnType<typeof createApp>>;
let directory: string;

const people = {
  olive: { id: "acct_olive", email: "olive@example.com", name: "Olive", role: "owner" },
  mia: { id: "acct_mia", email: "mia@example.com", name: "Mia", role: "member" },
  ada: { id: "acct_ada", email: "ada@example.com", name: "Ada", role: "admin" },
  max: { id: "acct_max", email: "max@example.com", name: "Max", role: "member" },
  gus: { id: "acct_gus", email: "Gus@Example.com", name: "Gus", role: "guest" },
} as const satisfies Record<
  string,
  { id: string; email: string; name: string; role: WorkspaceRole }
>;
type Who = keyof typeof people;
const sessions = new Map<Who, string>();

const call = (who: Who, method: string, path: string, body?: unknown) =>
  server.app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${sessions.get(who)}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (response: Response) => response.json();

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "hive-projects-"));
  db = await createStore();
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "https://w1project.example.test",
    dataDir: directory,
    encryptionKey: randomBytes(32).toString("base64"),
    googleRedirectUri: "https://w1project.example.test/api/google/callback",
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
});
after(async () => {
  await server.agent.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

const projectsOf = async (who: Who) =>
  ((await json(await call(who, "GET", "/api/agent"))) as AgentWorkspace).projects;
const tasksOf = async (who: Who) =>
  ((await json(await call(who, "GET", "/api/agent"))) as AgentWorkspace).tasks;
const make = async (who: Who, body: object) => {
  const response = await call(who, "POST", "/api/agent/projects", body);
  assert.equal(response.status, 201, await response.clone().text());
  return (await json(response)) as Project;
};
const manual = (project: Project, title: string) => ({
  title,
  kind: "manual",
  projectId: project.id,
  input: {},
});

test("a project is open unless it says otherwise, and whoever makes it runs it", async () => {
  const open = await make("max", { name: "Website" });
  assert.equal(open.access, "open");
  assert.deepEqual(open.members, [{ email: "max@example.com", role: "admin" }]);
  assert.deepEqual(open.you, { role: "admin", canWork: true, canManage: true });
  // The team sees it, and works on it.
  const seen = (await projectsOf("mia")).find((p) => p.id === open.id);
  assert.deepEqual(seen?.you, { role: null, canWork: true, canManage: false });
  const made = await call("mia", "POST", "/api/agent/tasks", manual(open, "Fix the footer"));
  assert.equal(made.status, 201);
  // A guest is only ever in what they are named in.
  assert.equal(
    (await projectsOf("gus")).some((p) => p.id === open.id),
    false,
  );
});

test("a limited project is seen by the team and worked on by its members", async () => {
  const limited = await make("max", { name: "Launch plan", access: "limited" });
  assert.ok((await projectsOf("mia")).some((p) => p.id === limited.id));
  const refused = await call("mia", "POST", "/api/agent/tasks", manual(limited, "Add a slide"));
  assert.equal(refused.status, 403);
  // Max, its admin, puts Mia in as a member, and she may.
  const added = await call("max", "PATCH", `/api/agent/projects/${limited.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "MIA@example.com", role: "member" },
    ],
  });
  assert.equal(added.status, 200);
  assert.equal(
    (await call("mia", "POST", "/api/agent/tasks", manual(limited, "Add a slide"))).status,
    201,
  );
});

test("a private project and its tasks are its members' alone, and those who run the workspace see them", async () => {
  const secret = await make("max", { name: "Reorg", access: "private" });
  const task = (await json(
    await call("max", "POST", "/api/agent/tasks", manual(secret, "Draft the memo")),
  )) as AgentTask;
  assert.equal(
    (await projectsOf("mia")).some((p) => p.id === secret.id),
    false,
  );
  assert.equal(
    (await tasksOf("mia")).some((t) => t.id === task.id),
    false,
  );
  assert.equal((await call("mia", "GET", `/api/agent/tasks/${task.id}`)).status, 404);
  assert.equal(
    (await call("mia", "POST", "/api/agent/tasks", manual(secret, "Sneak in"))).status,
    404,
  );
  assert.equal(
    (await call("mia", "PATCH", `/api/agent/projects/${secret.id}`, { name: "x" })).status,
    404,
  );
  // The owner and the admins see it all.
  for (const who of ["olive", "ada"] as const) {
    assert.ok(
      (await projectsOf(who)).some((p) => p.id === secret.id),
      who,
    );
    assert.ok(
      (await tasksOf(who)).some((t) => t.id === task.id),
      who,
    );
  }
  // A viewer sees it and cannot change what is in it.
  await call("max", "PATCH", `/api/agent/projects/${secret.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "mia@example.com", role: "viewer" },
    ],
  });
  assert.ok((await tasksOf("mia")).some((t) => t.id === task.id));
  assert.equal((await call("mia", "GET", `/api/agent/tasks/${task.id}`)).status, 200);
  assert.equal(
    (await call("mia", "PATCH", `/api/agent/tasks/${task.id}`, { priority: "high" })).status,
    403,
  );
  assert.equal((await call("mia", "DELETE", `/api/agent/tasks/${task.id}`)).status, 403);
  assert.equal((await call("mia", "POST", "/api/agent/tasks", manual(secret, "More"))).status, 403);
});

test("only a project's admins change who is in it, and it always keeps one", async () => {
  const project = await make("max", { name: "Hiring", access: "limited" });
  const mia = { email: "mia@example.com", role: "member" };
  await call("max", "PATCH", `/api/agent/projects/${project.id}`, {
    members: [{ email: "max@example.com", role: "admin" }, mia],
  });
  // A member is not an admin.
  assert.equal(
    (await call("mia", "PATCH", `/api/agent/projects/${project.id}`, { access: "open" })).status,
    403,
  );
  assert.equal((await call("mia", "DELETE", `/api/agent/projects/${project.id}`)).status, 403);
  // A project does not lose its last admin.
  const none = await call("max", "PATCH", `/api/agent/projects/${project.id}`, { members: [mia] });
  assert.equal(none.status, 422);
  // The owner may, though they were never named in it.
  assert.equal(
    (await call("olive", "PATCH", `/api/agent/projects/${project.id}`, { access: "private" }))
      .status,
    200,
  );
  assert.equal((await call("max", "DELETE", `/api/agent/projects/${project.id}`)).status, 200);
});

test("a guest sees a project only when named in it, and moving a task in is refused to those who may not work there", async () => {
  const project = await make("max", { name: "Client work", access: "private" });
  assert.equal(
    (await projectsOf("gus")).some((p) => p.id === project.id),
    false,
  );
  await call("max", "PATCH", `/api/agent/projects/${project.id}`, {
    members: [
      { email: "max@example.com", role: "admin" },
      { email: "gus@example.com", role: "viewer" },
    ],
  });
  assert.ok((await projectsOf("gus")).some((p) => p.id === project.id));
  // A task that is out of any project cannot be moved into one its person may not work in.
  const loose = (await json(
    await call("mia", "POST", "/api/agent/tasks", { title: "Loose", kind: "manual", input: {} }),
  )) as AgentTask;
  const moved = await call("mia", "PATCH", `/api/agent/tasks/${loose.id}`, {
    projectId: project.id,
  });
  assert.equal(moved.status, 404);
});

test("the people a project can name are the workspace's, and a guest is not told who they are", async () => {
  const people = (await json(await call("max", "GET", "/api/agent/projects/people"))) as {
    email: string;
    role: string;
  }[];
  assert.ok(
    people.some((person) => person.email === "mia@example.com" && person.role === "member"),
  );
  assert.equal((await call("gus", "GET", "/api/agent/projects/people")).status, 403);
});
