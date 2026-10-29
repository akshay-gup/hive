import assert from "node:assert/strict";
import { test } from "node:test";
import { people, wired } from "./helpers/chat-wired.ts";

test("the real channel tool bridge reads all four board kinds and refreshes a session when its readers change", async (t) => {
  const answers: unknown[] = [];
  const routines: unknown[] = [];
  const f = await wired(t, async ({ tools, call, say }) => {
    assert.ok(tools.includes("read_board"));
    assert.ok(!tools.includes("agent_status"));
    assert.ok(!tools.includes("search_mail"));
    answers.push(await call("read_board", { limit: 50 }));
    routines.push(await call("list_routines"));
    say("Checked the shared board.");
  });
  const open = await f.channel("max", "Shared board");
  const secret = await f.core.work.createProject(people.max.id, {
    name: "HIDDEN-project",
    access: "private",
  });
  await f.core.work.createTask(people.max.id, {
    title: "HIDDEN-task",
    kind: "manual",
    input: {},
    projectId: secret.id,
  });
  await f.core.goals.create(people.max.id, {
    title: "HIDDEN-goal",
    description: "Secret",
    category: "work",
    milestones: [],
    scope: { type: "person" },
  });
  await f.core.routines.create(people.max.id, {
    title: "HIDDEN-routine",
    note: "Secret",
    schedule: { kind: "every", minutes: 60 },
    scope: { type: "person" },
  });
  await f.core.work.createTask(people.max.id, { title: "Shared task", kind: "manual", input: {} });
  await f.core.goals.create(people.max.id, {
    title: "Shared goal",
    description: "Shared",
    category: "work",
    milestones: [],
    scope: { type: "team" },
  });
  await f.core.routines.create(
    people.max.id,
    {
      title: "Shared routine",
      note: "Shared",
      schedule: { kind: "every", minutes: 60 },
      scope: { type: "team" },
    },
    { channelId: open.id },
  );
  const first = await f.post("max", open.id, "@hive look up tasks, projects, goals and routines");
  await f.finished(first.id);
  for (const title of ["Shared task", "General", "Shared goal", "Shared routine"])
    assert.ok(JSON.stringify(answers[0]).includes(title));
  assert.doesNotMatch(JSON.stringify([answers[0], routines[0]]), /HIDDEN/);

  const privateChannel = await f.channel("max", "Private board", "private");
  await f.call("max", "PATCH", `/v1/channels/${privateChannel.id}`, { agent: true });
  const own = await f.post("max", privateChannel.id, "@hive check what we can see");
  await f.finished(own.id);
  assert.match(JSON.stringify(answers[1]), /HIDDEN-task/);
  await f.call("max", "POST", `/v1/channels/${privateChannel.id}/members`, {
    add: [people.mia.email],
  });
  const shared = await f.post("max", privateChannel.id, "@hive check again", {
    threadRoot: own.id,
  });
  await f.until(
    "the follow-up lookup to finish",
    () => f.core.runs.byTrigger(shared.id)?.state === "done",
  );
  assert.doesNotMatch(JSON.stringify([answers[2], routines[2]]), /HIDDEN/);
  assert.notEqual(f.opencode.prompts[1]?.sessionID, f.opencode.prompts[2]?.sessionID);
  assert.equal(f.core.runs.byTrigger(shared.id)?.rootId, own.id);
});
