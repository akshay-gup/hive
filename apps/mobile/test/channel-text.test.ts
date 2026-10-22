import assert from "node:assert/strict";
import { test } from "node:test";
import type { Channel } from "../../../packages/domain/src/agent.ts";
import { channelsOfGuest, guestChannelsLine, isEveryones, peopleIn } from "../src/channel-text.ts";

const now = "2026-10-21T00:00:00.000Z";
const channel = (id: string, extra: Partial<Channel> = {}): Channel => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  status: "active",
  createdBy: "a",
  createdAt: now,
  updatedAt: now,
  ...extra,
});

test("a channel from before people could join channels has everyone in it, and a new one has who is named", () => {
  assert.equal(isEveryones(channel("old")), true);
  assert.equal(isEveryones(channel("made", { everyone: false })), false);
  assert.equal(isEveryones(channel("secret", { visibility: "private" })), false);
  assert.equal(peopleIn(channel("old")), "Everyone");
  assert.equal(peopleIn(channel("made", { everyone: false, members: ["a@x.com"] })), "1 person");
  assert.equal(
    peopleIn(channel("made", { everyone: false, members: ["a@x.com", "b@x.com"] })),
    "2 people",
  );
  assert.equal(peopleIn(channel("secret", { visibility: "private", members: [] })), "0 people");
});

test("a guest's channels are the ones that name their address, in whatever case", () => {
  const channels = [
    channel("acme", { everyone: false, members: ["gus@example.com"] }),
    channel("design", { everyone: false, members: ["max@example.com"] }),
    channel("hr", { everyone: false, members: ["gus@example.com"], status: "archived" }),
    channel("blog", { members: ["gus@example.com"] }),
    channel("orchestrator", { members: ["gus@example.com"] }),
  ];
  assert.deepEqual(
    channelsOfGuest(channels, " Gus@Example.com ").map((c) => c.id),
    ["acme", "blog"],
  );
  assert.deepEqual(channelsOfGuest(channels, "nobody@example.com"), []);
});

test("what a guest can open is said under their name", () => {
  assert.equal(guestChannelsLine([]), "In no channel yet, so there is nothing for them to open");
  assert.equal(guestChannelsLine([{ name: "Acme" }]), "Can open # Acme");
  assert.equal(
    guestChannelsLine([{ name: "A" }, { name: "B" }, { name: "C" }]),
    "Can open # A, # B, # C",
  );
  assert.equal(
    guestChannelsLine([{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E" }]),
    "Can open # A, # B, # C and 2 more",
  );
});
