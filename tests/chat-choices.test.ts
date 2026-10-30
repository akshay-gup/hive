import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { JevAdapter, JevDecisionInput } from "../apps/server/src/jev/adapter.ts";
import { encodeJevAction, type JevPanel, jevToolResultSchema } from "../packages/domain/src/jev.ts";
import { people, wired } from "./helpers/chat-wired.ts";
import type { FakeTurn } from "./helpers/fake-opencode.ts";

/** The choice cards an agent shows in a person's own chat and in a channel, and what a pick does. */

const max = people.max.id;
const explore = { id: "explore", label: "Explore exhibits", details: [], sources: [] };
const other = { id: "other", label: "Something else", details: [], sources: [] };
const choices = (options: unknown[] = [explore, other]) => ({
  message: "Help with the trip",
  context: "A school email",
  title: "What next?",
  control: "clarification",
  options,
});
const showing =
  (arg: unknown = choices()) =>
  async ({ call, say }: FakeTurn) => {
    await call("present_choices", arg);
    say("Pick one.");
  };

type Behave = Parameters<typeof wired>[1];
type Options = NonNullable<Parameters<typeof wired>[2]>;

/** A room with the agent, and the person's own chat open. */
async function chatting(t: TestContext, behave: Behave, options: Options = { jevMode: "sample" }) {
  const f = await wired(t, behave, options);
  return { ...f, mine: await f.own() };
}
type Chatting = Awaited<ReturnType<typeof chatting>>;

const panelOf = (shown: { name: string; result: unknown }[]): JevPanel => {
  const call = shown.findLast((tool) => tool.name === "present_choices");
  assert.ok(call, "the agent asked for choices");
  const panel = jevToolResultSchema.parse(call.result).panel;
  assert.ok(panel);
  return panel;
};
const pickOf = (panel: JevPanel, optionId = "explore") =>
  encodeJevAction({
    panelId: panel.id,
    threadId: panel.threadId,
    candidateSetVersion: panel.candidateSetVersion,
    optionId,
  });
/** The conversation's choices, as the machine keeps them (a person's own chat is a channel of one). */
const headOf = (f: Chatting, threadId: string) =>
  f.db.get<{ currentPanelId: string | null; selectedId?: string | null }>(
    "shared",
    "jev_threads",
    threadId,
  );

test("an agent is offered the choice cards, and told when to use them, only when they are on", async (t) => {
  let offered: string[] = [];
  const note = (turn: FakeTurn) => {
    offered = turn.tools;
    turn.say("Hello.");
  };
  const on = await chatting(t, note);
  await on.say("max", on.mine.id, "hello");
  assert.ok(offered.includes("present_choices"));
  assert.match(on.opencode.prompts[0]?.context ?? "", /present_choices/);

  const off = await chatting(t, note, {});
  await off.say("max", off.mine.id, "hello");
  assert.ok(!offered.includes("present_choices"));
  assert.doesNotMatch(off.opencode.prompts[0]?.context ?? "", /present_choices/);
});

test("a panel reaches the chat whole, however long it is", async (t) => {
  const many = Array.from({ length: 8 }, (_, index) => ({
    id: `step-${index}`,
    label: `Next step ${index}`,
    details: ["a".repeat(200), "b".repeat(200)],
    sources: [],
  }));
  const f = await chatting(t, showing(choices(many)));
  const chat = await f.say("max", f.mine.id, "Help me plan");
  const shown = chat.tools.find((tool) => tool.name === "present_choices");
  assert.ok(shown);
  // A result cut short is not JSON the card could read.
  assert.ok(shown.content.length > 2_000);
  const result = jevToolResultSchema.parse(shown.result);
  assert.equal(result.panel?.options.length, 8);
  assert.equal(result.panel?.mode, "sample");
  assert.equal(chat.status, "done");
});

test("the cards are judged against the person's own words, not the agent's summary of them", async (t) => {
  const seen: JevDecisionInput[] = [];
  const adapter: JevAdapter = {
    decide: async (input) => {
      seen.push(input);
      return { control: "clarification", scores: { explore: 1 } };
    },
  };
  const f = await chatting(
    t,
    showing({ ...choices([explore]), message: "The agent's own summary" }),
    {
      jevMode: "sample",
      jevAdapter: adapter,
    },
  );
  await f.say("max", f.mine.id, "Something hands-on, please");
  assert.equal(seen[0]?.userMessage, "Something hands-on, please");
  assert.equal(seen[0]?.message, "The agent's own summary");
});

test("picking a card needs no mention, tells the agent what was picked in words, and sending it again is the same pick", async (t) => {
  const f = await chatting(t, async (turn) => {
    if (turn.index === 1) await showing()(turn);
    else turn.say("Great, exploring.");
  });
  const first = await f.say("max", f.mine.id, "Help me plan");
  const panel = panelOf(first.tools);
  const second = await f.say("max", f.mine.id, pickOf(panel));
  assert.equal(second.status, "done");
  assert.equal(second.text, "Great, exploring.");
  const told = f.opencode.prompts[1];
  assert.equal(
    told?.text,
    "I choose “Explore exhibits” from clarification choices. Continue with that preference.",
  );
  assert.doesNotMatch(told?.context ?? "", /Hive choice/);
  assert.equal((await headOf(f, panel.threadId))?.selectedId, "explore");
  // Sent again, as Retry does after a failed reply, it is the same pick.
  const again = await f.say("max", f.mine.id, pickOf(panel));
  assert.equal(again.status, "done");
  assert.equal(f.opencode.prompts.length, 3);
  // Another option on a panel that has its answer is not a pick.
  const changed = await f.say("max", f.mine.id, pickOf(panel, "other"));
  assert.equal(changed.status, "failed");
  assert.equal(f.opencode.prompts.length, 3);
});

test("a pick that does not check out is an error, and OpenCode is not asked anything", async (t) => {
  const f = await chatting(t, ({ say }) => say("hi"));
  const unreadable = await f.say("max", f.mine.id, "[Hive choice] bad-json");
  assert.equal(unreadable.status, "failed");
  assert.match(JSON.stringify(unreadable.reply), /The choice could not be read/);
  const foreign = await f.say(
    "max",
    f.mine.id,
    encodeJevAction({
      panelId: "missing",
      threadId: "foreign",
      candidateSetVersion: 1,
      optionId: "a",
    }),
  );
  assert.equal(foreign.status, "failed");
  assert.match(JSON.stringify(foreign.reply), /belongs to another conversation/);
  assert.equal(f.opencode.prompts.length, 0);
});

test("with the cards off, a pick is refused rather than quietly ignored", async (t) => {
  const f = await chatting(t, ({ say }) => say("hi"), {});
  const chat = await f.say(
    "max",
    f.mine.id,
    encodeJevAction({ panelId: "p", threadId: "t", candidateSetVersion: 1, optionId: "a" }),
  );
  assert.equal(chat.status, "failed");
  assert.match(JSON.stringify(chat.reply), /unavailable/);
  assert.equal(f.opencode.prompts.length, 0);
});

/** Show a panel in the person's own chat, as an agent does when asked what to do next. */
async function withPanel(
  t: TestContext,
  then: (turn: FakeTurn) => void | Promise<void>,
): Promise<{ f: Chatting; panel: JevPanel }> {
  const f = await chatting(t, async (turn) => {
    if (turn.index === 1) await showing()(turn);
    else await then(turn);
  });
  const panel = panelOf((await f.say("max", f.mine.id, "What next?")).tools);
  return { f, panel };
}
/** The panel no longer takes a pick, in the store and for a client that tries it anyway. */
async function assertRetired(f: Chatting, panel: JevPanel) {
  assert.equal((await headOf(f, panel.threadId))?.currentPanelId, null);
  const tried = await f.say("max", f.mine.id, pickOf(panel));
  assert.equal(tried.status, "failed");
}

test("a later message to the agent retires the earlier choices", async (t) => {
  const { f, panel } = await withPanel(t, ({ say }) => say("Sunny."));
  assert.equal((await f.say("max", f.mine.id, "Tell me about the weather")).status, "done");
  await assertRetired(f, panel);
});

test("a turn that fails still retires the earlier choices", async (t) => {
  const { f, panel } = await withPanel(t, () => {
    throw new Error("The model is down");
  });
  assert.equal((await f.say("max", f.mine.id, "Tell me about the weather")).status, "failed");
  await assertRetired(f, panel);
});

test("stopping a turn still retires the earlier choices", async (t) => {
  let stop: () => Promise<unknown> = async () => undefined;
  const { f, panel } = await withPanel(t, async () => {
    await stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  stop = async () => {
    const run = f.core.runs.active()[0];
    assert.ok(run);
    return f.call("max", "POST", `/v1/runs/${run.id}/stop`);
  };
  assert.equal((await f.say("max", f.mine.id, "hello")).status, "stopped");
  await assertRetired(f, panel);
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
  let first: JevPanel | undefined;
  const a = await chatting(t, async (turn) => {
    if (turn.index === 1) await showing()(turn);
    else await turn.call("present_choices", refine(first as JevPanel));
  });
  first = panelOf((await a.say("max", a.mine.id, "What next?")).tools);
  const refined = await a.say("max", a.mine.id, "Something hands-on");
  assert.ok(panelOf(refined.tools));

  // ...a later one cannot.
  let second: JevPanel | undefined;
  let late: unknown;
  const b = await chatting(t, async (turn) => {
    if (turn.index === 1) await showing()(turn);
    else if (turn.index === 2) turn.say("Sunny.");
    else late = await turn.call("present_choices", refine(second as JevPanel));
  });
  second = panelOf((await b.say("max", b.mine.id, "What next?")).tools);
  await b.say("max", b.mine.id, "Tell me about the weather");
  await b.say("max", b.mine.id, "Back to the trip");
  const result = jevToolResultSchema.parse(late);
  assert.equal(result.panel, null);
  assert.match(result.error ?? "", /superseded/);
});

test("in a channel's thread the cards belong to the team, so a teammate can pick one", async (t) => {
  const f = await wired(
    t,
    async (turn) => {
      if (turn.index === 1) await showing()(turn);
      else turn.say("Great, exploring.");
    },
    { jevMode: "sample" },
  );
  const room = await f.channel("max", "Design");
  const asked = await f.post("max", room.id, "@hive What next?");
  const panel = panelOf(f.toolsShown(await f.finished(asked.id)));
  // They are kept for the team, not for whoever happened to ask.
  assert.ok(await f.db.get("shared", "jev_threads", panel.threadId));
  assert.equal(await f.db.get(max, "jev_threads", panel.threadId), null);

  const picked = await f.post("mia", room.id, `@hive ${pickOf(panel)}`, { threadRoot: asked.id });
  assert.ok(picked.id);
  await f.until("the pick to be answered", () => f.opencode.prompts.length === 2);
  assert.equal(
    f.opencode.prompts[1]?.text,
    "I choose “Explore exhibits” from clarification choices. Continue with that preference.",
  );
  const head = await f.db.get<{ selectedId: string }>("shared", "jev_threads", panel.threadId);
  assert.equal(head?.selectedId, "explore");
});
