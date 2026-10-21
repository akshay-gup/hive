import assert from "node:assert/strict";
import { test } from "node:test";
import { latestJevPanelId } from "../apps/mobile/src/jev-actions.ts";
import type { JevAdapter, JevDecisionInput } from "../apps/server/src/jev/adapter.ts";
import { encodeJevAction, type JevPanel, jevToolResultSchema } from "../packages/domain/src/jev.ts";
import { shimFixture } from "./helpers/shim.ts";

const explore = { id: "explore", label: "Explore exhibits", details: [], sources: [] };
const choices = (options: unknown[] = [explore]) => ({
  message: "Help with the trip",
  context: "A school email",
  title: "What next?",
  control: "clarification",
  options,
});

test("an agent is offered the choice cards, and told when to use them, only when they are on", async (t) => {
  const on = await shimFixture(t, { jevMode: "sample" });
  let offered: string[] = [];
  on.whenPrompted(({ tools, idle }) => {
    offered = tools;
    idle();
  });
  await on.run("@hive hello");
  assert.ok(offered.includes("present_choices"));
  assert.match(on.standIn.prompts[0].parts[0].text, /present_choices/);

  const off = await shimFixture(t);
  off.whenPrompted(({ tools, idle }) => {
    offered = tools;
    idle();
  });
  await off.run("@hive hello");
  assert.ok(!offered.includes("present_choices"));
  assert.doesNotMatch(off.standIn.prompts[0].parts[0].text, /present_choices/);
});

test("a panel reaches the chat whole, however long it is", async (t) => {
  const f = await shimFixture(t, { jevMode: "sample" });
  const many = Array.from({ length: 8 }, (_, index) => ({
    id: `step-${index}`,
    label: `Next step ${index}`,
    details: ["a".repeat(200), "b".repeat(200)],
    sources: [],
  }));
  f.whenPrompted(async ({ call, say, idle }) => {
    await call("present_choices", choices(many));
    say("Pick one.");
    idle();
  });
  const chat = await f.run("@hive Help me plan");
  const shown = chat.tools.find((tool) => tool.name === "present_choices");
  assert.ok(shown);
  // A result cut short is not JSON the card could read.
  assert.ok(shown.content.length > 2_000);
  const result = jevToolResultSchema.parse(shown.result);
  assert.equal(result.panel?.options.length, 8);
  assert.equal(result.panel?.mode, "sample");
  assert.equal(chat.last, "RUN_FINISHED");
});

test("the cards are judged against the person's own words, not the agent's summary of them", async (t) => {
  const seen: JevDecisionInput[] = [];
  const adapter: JevAdapter = {
    decide: async (input) => {
      seen.push(input);
      return { control: "clarification", scores: { explore: 1 } };
    },
  };
  const f = await shimFixture(t, { jevMode: "sample", jevAdapter: adapter });
  f.whenPrompted(async ({ call, idle }) => {
    await call("present_choices", { ...choices(), message: "The agent's own summary" });
    idle();
  });
  await f.run("@hive  Something hands-on, please");
  assert.equal(seen[0].userMessage, "Something hands-on, please");
  assert.equal(seen[0].message, "The agent's own summary");
});

test("live choices reject source pages the agent did not read, and make no panel", async (t) => {
  const adapter: JevAdapter = {
    decide: async () => ({ control: "comparison", scores: { a: 1 } }),
  };
  const f = await shimFixture(t, {
    jevMode: "live",
    jevAdapter: adapter,
    browse: () => ({ status: 502, data: { error: { message: "Read failed" } } }),
  });
  f.whenPrompted(async ({ call, idle }) => {
    await call("present_choices", {
      ...choices(),
      control: "comparison",
      options: [
        {
          id: "a",
          label: "A",
          details: [],
          sources: [{ title: "Source", url: "https://example.org/a" }],
        },
      ],
    });
    idle();
  });
  const chat = await f.run("@hive Compare exhibits");
  const result = jevToolResultSchema.parse(chat.tools[0].result);
  assert.equal(result.panel, null);
  assert.match(result.error ?? "", /Read the source page/);
  assert.deepEqual(await f.db.list("local-user", "jev_panels"), []);
});

const other = { id: "other", label: "Something else", details: [], sources: [] };

test("picking a card summons the agent without a mention, and tells it what was picked", async (t) => {
  const f = await shimFixture(t, { jevMode: "sample" });
  f.whenPrompted(async ({ call, say, idle, index }) => {
    if (index === 1) await call("present_choices", choices([explore, other]));
    say(index === 1 ? "Pick one." : "Great, exploring.");
    idle();
  });
  const first = await f.run("@hive Help me plan");
  const panel = jevToolResultSchema.parse(first.tools[0].result).panel;
  assert.ok(panel);
  const pick = encodeJevAction({
    panelId: panel.id,
    threadId: panel.threadId,
    candidateSetVersion: panel.candidateSetVersion,
    optionId: "explore",
  });
  const conversation = [
    { role: "user", content: "@hive Help me plan" },
    { role: "assistant", content: "Pick one." },
    { role: "user", content: pick },
  ];
  const second = await f.run(conversation);
  assert.equal(second.last, "RUN_FINISHED");
  assert.equal(second.text, "Great, exploring.");
  const told = f.standIn.prompts[1];
  assert.equal(
    told.parts.at(-1)?.text,
    "I choose “Explore exhibits” from clarification choices. Continue with that preference.",
  );
  // The agent catches up on the conversation in words, not as the message the client sent.
  assert.doesNotMatch(told.parts[0].text, /Hive choice/);
  assert.match(told.parts[0].text, /User: I choose “Explore exhibits”/);
  const stored = await f.db.get<{ selectedId: string }>(
    "local-user",
    "jev_threads",
    panel.threadId,
  );
  assert.equal(stored?.selectedId, "explore");
  // Sending it again, as Retry does after a failed reply, is the same pick.
  const retried = await f.run(conversation);
  assert.equal(retried.last, "RUN_FINISHED");
  assert.equal(f.standIn.prompts.length, 3);
});

test("a pick that does not check out is an error, and OpenCode is not asked anything", async (t) => {
  const f = await shimFixture(t, { jevMode: "sample" });
  const unreadable = await f.run("[Hive choice] bad-json");
  assert.equal(unreadable.last, "RUN_ERROR");
  assert.equal(unreadable.events.at(-1)?.message, "The choice could not be read");
  const foreign = await f.run(
    encodeJevAction({
      panelId: "missing",
      threadId: "foreign",
      candidateSetVersion: 1,
      optionId: "a",
    }),
  );
  assert.equal(foreign.last, "RUN_ERROR");
  assert.equal(foreign.events.at(-1)?.message, "This choice belongs to another conversation");
  const unknown = await f.run(
    encodeJevAction({
      panelId: "missing",
      threadId: "thread-1",
      candidateSetVersion: 1,
      optionId: "a",
    }),
  );
  assert.equal(unknown.last, "RUN_ERROR");
  assert.equal(f.standIn.prompts.length, 0);
});

test("with the cards off, a pick is refused rather than quietly ignored", async (t) => {
  const f = await shimFixture(t);
  const chat = await f.run(
    encodeJevAction({ panelId: "p", threadId: "thread-1", candidateSetVersion: 1, optionId: "a" }),
  );
  assert.equal(chat.last, "RUN_ERROR");
  assert.match(String(chat.events.at(-1)?.message), /unavailable/);
  assert.equal(f.standIn.prompts.length, 0);
});

type Fixture = Awaited<ReturnType<typeof shimFixture>>;

/** Show a panel in the thread, as an agent does when asked what to do next. */
async function panelIn(f: Fixture): Promise<JevPanel> {
  f.whenPrompted(async ({ call, idle }) => {
    await call("present_choices", choices([explore, other]));
    idle();
  });
  const chat = await f.run("@hive What next?");
  const panel = jevToolResultSchema.parse(chat.tools[0].result).panel;
  assert.ok(panel);
  return panel;
}
const pickOf = (panel: JevPanel, optionId = "explore") =>
  encodeJevAction({
    panelId: panel.id,
    threadId: panel.threadId,
    candidateSetVersion: panel.candidateSetVersion,
    optionId,
  });
/** The panel no longer takes a pick, in the store and for a client that tries it anyway. */
async function assertRetired(f: Fixture, panel: JevPanel) {
  const head = await f.db.get<{ currentPanelId: string | null }>(
    "local-user",
    "jev_threads",
    panel.threadId,
  );
  assert.equal(head?.currentPanelId, null);
  assert.equal((await f.run(pickOf(panel))).last, "RUN_ERROR");
}

test("a later turn that mentions the agent retires the earlier choices", async (t) => {
  const f = await shimFixture(t, { jevMode: "sample" });
  const panel = await panelIn(f);
  f.whenPrompted(({ say, idle }) => {
    say("Sunny.");
    idle();
  });
  const ordinary = await f.run("@hive Tell me about the weather");
  assert.equal(ordinary.last, "RUN_FINISHED");
  await assertRetired(f, panel);
});

test("so does a message that never reaches the agent, because the transcript shows them stale", async (t) => {
  const f = await shimFixture(t, { jevMode: "sample" });
  // In a person's own chat every message is for the agent; in a channel's thread one that does not
  // mention it is not, and never reaches it.
  const threadId = await teamThread(f);
  f.whenPrompted(async ({ call, idle }) => {
    await call("present_choices", choices([explore, other]));
    idle();
  });
  const first = await f.run("@hive What next?", { threadId, owner: "alice" });
  const panel = jevToolResultSchema.parse(first.tools[0].result).panel;
  assert.ok(panel);
  const chatter = await f.run("What a nice day", { threadId, owner: "alice" });
  assert.equal(chatter.last, "RUN_FINISHED");
  assert.equal(f.standIn.prompts.length, 1, "the agent was not asked anything");
  const transcript = [
    { role: "assistant", toolCalls: [{ id: "call-0", name: "present_choices" }] },
    { role: "tool", toolCallId: "call-0", content: JSON.stringify({ panel }) },
    { role: "user", content: "What a nice day" },
  ];
  assert.equal(latestJevPanelId(transcript, panel.threadId), null);
  const head = await f.db.get<{ currentPanelId: string | null }>("shared", "jev_threads", threadId);
  assert.equal(head?.currentPanelId, null);
  assert.equal((await f.run(pickOf(panel), { threadId, owner: "alice" })).last, "RUN_ERROR");
});

test("a turn that fails still retires the earlier choices", async (t) => {
  const f = await shimFixture(t, { jevMode: "sample" });
  const panel = await panelIn(f);
  f.whenPrompted(() => {
    throw new Error("The model is down");
  });
  const failed = await f.run("@hive Tell me about the weather");
  assert.equal(failed.last, "RUN_ERROR");
  await assertRetired(f, panel);
});

test("cancelling a turn still retires the earlier choices", async (t) => {
  const f = await shimFixture(t, { jevMode: "sample" });
  const panel = await panelIn(f);
  f.whenPrompted(async () => {
    await f.stop();
  });
  const cancelled = await f.run("@hive hello");
  assert.equal(cancelled.last, "RUN_ERROR");
  await assertRetired(f, panel);
});

test("a run that does not end with a person speaking is not a new turn, and keeps the choices", async (t) => {
  const f = await shimFixture(t, { jevMode: "sample" });
  const panel = await panelIn(f);
  f.whenPrompted(({ idle }) => idle());
  await f.run([
    { role: "user", content: "@hive What next?" },
    { role: "assistant", content: "Pick one." },
  ]);
  const head = await f.db.get<{ currentPanelId: string | null }>(
    "local-user",
    "jev_threads",
    panel.threadId,
  );
  assert.equal(head?.currentPanelId, panel.id);
});

test("only the turn that retired a panel may refine it", async (t) => {
  const refine = (panel: JevPanel) => ({
    message: "Refine",
    context: "x",
    title: "Next",
    control: "clarification",
    options: [],
    refinementPanelId: panel.id,
  });
  // The turn that retires a panel can still refine it...
  const f = await shimFixture(t, { jevMode: "sample" });
  const first = await panelIn(f);
  let refined: unknown;
  f.whenPrompted(async ({ call, idle }) => {
    refined = await call("present_choices", refine(first));
    idle();
  });
  await f.run("@hive Something hands-on");
  assert.ok(jevToolResultSchema.parse(refined).panel);

  // ...a later one cannot.
  const g = await shimFixture(t, { jevMode: "sample" });
  const second = await panelIn(g);
  g.whenPrompted(({ idle }) => idle());
  await g.run("@hive Tell me about the weather");
  let late: unknown;
  g.whenPrompted(async ({ call, idle }) => {
    late = await call("present_choices", refine(second));
    idle();
  });
  await g.run("@hive Back to the trip");
  const result = jevToolResultSchema.parse(late);
  assert.equal(result.panel, null);
  assert.match(result.error ?? "", /superseded/);
});

/** A channel the whole team shares, with a thread in it that alice started. */
async function teamThread(f: Fixture, threadId = "design-thread") {
  const channel = await f.agent.createChannel("alice", { name: "design" });
  await f.agent.ensureThreadBinding("alice", threadId, channel.id, "Trip");
  return threadId;
}

test("in a channel's thread the cards belong to the team, so a teammate can pick one", async (t) => {
  const f = await shimFixture(t, { jevMode: "sample" });
  const threadId = await teamThread(f);
  f.whenPrompted(async ({ call, say, idle }) => {
    await call("present_choices", choices([explore, other]));
    say("Pick one.");
    idle();
  });
  const first = await f.run("@hive What next?", { threadId, owner: "alice" });
  const panel = jevToolResultSchema.parse(first.tools[0].result).panel;
  assert.ok(panel);
  // They are kept for the team, not for whoever happened to ask.
  assert.ok(await f.db.get("shared", "jev_threads", threadId));
  assert.equal(await f.db.get("alice", "jev_threads", threadId), null);

  f.whenPrompted(({ say, idle }) => {
    say("Great, exploring.");
    idle();
  });
  const picked = await f.run(pickOf(panel), { threadId, owner: "bob" });
  assert.equal(picked.last, "RUN_FINISHED");
  assert.equal(
    f.standIn.prompts.at(-1)?.parts.at(-1)?.text,
    "I choose “Explore exhibits” from clarification choices. Continue with that preference.",
  );
  const head = await f.db.get<{ selectedId: string }>("shared", "jev_threads", threadId);
  assert.equal(head?.selectedId, "explore");
});

test("a teammate's message makes the team's earlier cards stale, as it does in the transcript", async (t) => {
  const f = await shimFixture(t, { jevMode: "sample" });
  const threadId = await teamThread(f);
  f.whenPrompted(async ({ call, idle }) => {
    await call("present_choices", choices([explore, other]));
    idle();
  });
  const first = await f.run("@hive What next?", { threadId, owner: "alice" });
  const panel = jevToolResultSchema.parse(first.tools[0].result).panel;
  assert.ok(panel);
  await f.run("What a nice day", { threadId, owner: "bob" });
  const head = await f.db.get<{ currentPanelId: string | null }>("shared", "jev_threads", threadId);
  assert.equal(head?.currentPanelId, null);
  assert.equal((await f.run(pickOf(panel), { threadId, owner: "alice" })).last, "RUN_ERROR");
});

test("in the orchestrator chat they stay private: another person cannot pick them", async (t) => {
  const f = await shimFixture(t, { jevMode: "sample" });
  f.whenPrompted(async ({ call, idle }) => {
    await call("present_choices", choices([explore, other]));
    idle();
  });
  const first = await f.run("@hive What next?", { threadId: "alice-main", owner: "alice" });
  const panel = jevToolResultSchema.parse(first.tools[0].result).panel;
  assert.ok(panel);
  assert.ok(await f.db.get("alice", "jev_threads", "alice-main"));
  assert.equal(await f.db.get("shared", "jev_threads", "alice-main"), null);
  // Bob knows the thread and the panel, and still cannot touch them.
  const intruder = await f.run(pickOf(panel), { threadId: "alice-main", owner: "bob" });
  assert.equal(intruder.last, "RUN_ERROR");
  const head = await f.db.get<{ selectedId: string | null }>("alice", "jev_threads", "alice-main");
  assert.ok(!head?.selectedId);
});
