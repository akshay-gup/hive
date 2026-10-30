import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { jevToolResultSchema } from "../packages/domain/src/jev.ts";
import { people, wired } from "./helpers/chat-wired.ts";
import type { FakeTurn } from "./helpers/fake-opencode.ts";

/** In live mode a panel is only as good as what the agent read in the run that made it. */

const max = people.max.id;

const exhibit = "https://example.org/exhibit";
const explore = { id: "explore", label: "Explore exhibits", details: [], sources: [] };

/** A browser worker that opens any page and reads back the page it is given. */
const reading =
  (read: { url: string; title: string; text: string }) =>
  (path: string, body: Record<string, unknown>) => ({
    data: path.endsWith("/read")
      ? { ...read, truncated: false }
      : {
          id: body.id,
          url: body.url,
          title: "Opened",
          status: "active",
          updatedAt: new Date().toISOString(),
        },
  });

const compare = (option: Record<string, unknown> = {}, url = exhibit) => ({
  message: "Compare",
  context: "Observed page",
  title: "Exhibits",
  control: "comparison",
  options: [{ id: "a", label: "A", details: [], sources: [{ title: "Source", url }], ...option }],
});
const clarify = (extra: Record<string, unknown> = {}) => ({
  message: "What next?",
  context: "User asked",
  title: "Next",
  control: "clarification",
  options: [explore],
  ...extra,
});

type Browse = NonNullable<NonNullable<Parameters<typeof wired>[2]>["browse"]>;

/** The person's own chat, in live mode; give the agent something to do with `whenPrompted()`. */
async function live(
  t: TestContext,
  browse: Browse,
  decision: { control: "comparison" | "clarification"; scores: Record<string, number> } = {
    control: "comparison",
    scores: { a: 1 },
  },
) {
  let behaviour: (turn: FakeTurn) => void | Promise<void> = () => undefined;
  const f = await wired(t, (turn) => behaviour(turn), {
    jevMode: "live",
    jevAdapter: { decide: async () => decision },
    browse,
  });
  await f.server.workspace.ensureSample(max, f.server.actions);
  const mine = await f.own();
  return {
    ...f,
    whenPrompted: (handler: typeof behaviour) => {
      behaviour = handler;
    },
    run: (words: string) => f.say("max", mine.id, words.replace(/^@hive\s+/, "")),
  };
}

/** What the agent's present_choices call came back with. */
const choicesOf = (chat: { tools: { name: string; result: unknown }[] }) => {
  const shown = chat.tools.findLast((tool) => tool.name === "present_choices");
  assert.ok(shown, "the agent asked for choices");
  return jevToolResultSchema.parse(shown.result);
};

test("a redirected browse does not prove the requested source URL", async (t) => {
  const f = await live(
    t,
    reading({ url: "https://example.org/redirected", title: "Redirected", text: "Other page" }),
  );
  f.whenPrompted(async ({ call }) => {
    await call("browse_web", { url: "https://example.org/original" });
    await call("present_choices", compare({}, "https://example.org/original"));
  });
  const result = choicesOf(await f.run("@hive Compare exhibits"));
  assert.equal(result.panel, null);
  assert.match(result.error ?? "", /Read the source page/);
});

test("an empty browser read does not authorize a comparison", async (t) => {
  const f = await live(t, reading({ url: exhibit, title: "Empty", text: "  " }));
  f.whenPrompted(async ({ call }) => {
    await call("browse_web", { url: exhibit });
    await call("present_choices", compare());
  });
  const result = choicesOf(await f.run("@hive Compare exhibits"));
  assert.equal(result.panel, null);
  assert.match(result.error ?? "", /Read the source page/);
});

test("a comparison detail the read page does not contain is rejected", async (t) => {
  const f = await live(
    t,
    reading({ url: exhibit, title: "Exhibit", text: "A kelp forest with sardines." }),
  );
  f.whenPrompted(async ({ call }) => {
    await call("browse_web", { url: exhibit });
    await call("present_choices", compare({ details: ["A bat-ray touch pool"] }));
  });
  const result = choicesOf(await f.run("@hive Compare exhibits"));
  assert.equal(result.panel, null);
  assert.match(result.error ?? "", /source text/);
});

for (const [name, option, error] of [
  [
    "an invented option label",
    { label: "Imaginary reef", details: ["Touch sea stars"], sources: [{ title: "Rocky Shore" }] },
    /label.*source text/,
  ],
  [
    "an invented source title",
    { label: "Rocky Shore", details: ["Touch sea stars"], sources: [{ title: "Imaginary reef" }] },
    /source title.*source text/,
  ],
  [
    "no supporting details",
    { label: "Rocky Shore", details: [], sources: [{ title: "Rocky Shore" }] },
    /at least one.*detail/i,
  ],
] as const) {
  test(`a comparison with ${name} is rejected`, async (t) => {
    const url = "https://example.org/rocky-shore";
    const f = await live(
      t,
      reading({ url, title: "Rocky Shore", text: "Rocky Shore lets visitors Touch sea stars." }),
    );
    f.whenPrompted(async ({ call }) => {
      await call("browse_web", { url });
      await call(
        "present_choices",
        compare({ ...option, sources: option.sources.map((source) => ({ ...source, url })) }, url),
      );
    });
    const result = choicesOf(await f.run("@hive Compare exhibits"));
    assert.equal(result.panel, null);
    assert.match(result.error ?? "", error);
  });
}

test("a comparison of pages the agent read in this run is shown", async (t) => {
  const f = await live(
    t,
    reading({ url: exhibit, title: "Exhibit", text: "Observed exhibit facts" }),
  );
  f.whenPrompted(async ({ call }) => {
    await call("browse_web", { url: exhibit });
    await call(
      "present_choices",
      compare({
        label: "Observed exhibit",
        details: ["Observed exhibit facts"],
        sources: [{ title: "Exhibit", url: exhibit }],
      }),
    );
  });
  const chat = await f.run("@hive Compare exhibits");
  const result = choicesOf(chat);
  assert.equal(result.panel?.mode, "live");
  assert.deepEqual(
    result.panel?.options.map((option) => option.id),
    ["a"],
  );
});

test("mail read in an earlier run does not authorize a new clarification", async (t) => {
  const f = await live(t, () => ({ data: {} }), {
    control: "clarification",
    scores: { explore: 1 },
  });
  f.whenPrompted(async ({ call, index }) => {
    if (index === 1) await call("read_mail_thread", { threadId: "trip-thread" });
    else await call("present_choices", clarify({ mailThreadId: "trip-thread" }));
  });
  await f.run("@hive Read the trip mail");
  const result = choicesOf(await f.run("@hive Now clarify"));
  assert.equal(result.panel, null);
  assert.match(result.error ?? "", /Read the referenced email/);
});

test("mail read in this run authorizes a clarification that cites it", async (t) => {
  const f = await live(t, () => ({ data: {} }), {
    control: "clarification",
    scores: { explore: 1 },
  });
  f.whenPrompted(async ({ call }) => {
    await call("read_mail_thread", { threadId: "trip-thread" });
    await call("present_choices", clarify({ mailThreadId: "trip-thread" }));
  });
  assert.ok(choicesOf(await f.run("@hive Help with the trip")).panel);
});

test("a generic clarification needs no mail, but an unread mail thread does not stand in for it", async (t) => {
  const f = await live(t, () => ({ data: {} }), {
    control: "clarification",
    scores: { explore: 1 },
  });
  f.whenPrompted(async ({ call, index }) => {
    await call("present_choices", clarify(index === 1 ? {} : { mailThreadId: "trip-thread" }));
  });
  assert.ok(choicesOf(await f.run("@hive What next?")).panel);
  const claimed = choicesOf(await f.run("@hive School email next?"));
  assert.equal(claimed.panel, null);
  assert.match(claimed.error ?? "", /Read the referenced email/);
});

test("a refinement reuses the sources already verified, with no new browse and no options", async (t) => {
  const f = await live(
    t,
    reading({ url: exhibit, title: "Exhibit", text: "Observed exhibit facts" }),
  );
  f.whenPrompted(async ({ call, index }) => {
    if (index === 1) {
      await call("browse_web", { url: exhibit });
      await call(
        "present_choices",
        compare({
          label: "Observed exhibit",
          details: ["Observed exhibit facts"],
          sources: [{ title: "Exhibit", url: exhibit }],
        }),
      );
    }
  });
  const panel = choicesOf(await f.run("@hive Compare exhibits")).panel;
  assert.ok(panel);
  f.whenPrompted(async ({ call }) => {
    await call("present_choices", {
      message: "Something hands-on",
      context: "Earlier verified exhibit",
      title: "Hands-on exhibits",
      control: "comparison",
      options: [],
      refinementPanelId: panel.id,
    });
  });
  const refined = choicesOf(await f.run("@hive Something hands-on")).panel;
  assert.deepEqual(
    refined?.options.map((option) => option.id),
    ["a"],
  );
});
