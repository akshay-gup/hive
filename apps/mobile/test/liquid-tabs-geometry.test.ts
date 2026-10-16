import assert from "node:assert/strict";
import { test } from "node:test";
import {
  layoutTiles,
  openTargets,
  seamSeparation,
  settled,
  stepSpring,
  tintTargets,
} from "../src/liquid-tabs-geometry.ts";

const ids = ["a", "b", "c", "d", "e"];
const even = [0, 72, 144, 216, 288, 360];
const layout = (opens: number[], tints = [0, 0, 0, 0, 0], bounds = even) =>
  layoutTiles({ bounds, height: 54, ids, opens, tints, gap: 12 });

test("the seams on either side of the selected tab are the ones that open", () => {
  assert.deepEqual(openTargets(5, 0), [0, 1, 0, 0, 0, 0]);
  assert.deepEqual(openTargets(5, 2), [0, 0, 1, 1, 0, 0]);
  assert.deepEqual(openTargets(5, 4), [0, 0, 0, 0, 1, 0]);
  assert.deepEqual(openTargets(5, -1), [0, 0, 0, 0, 0, 0], "nothing selected");
});

test("joined, the tiles overlap by a diameter; apart, they are a gap apart", () => {
  assert.equal(seamSeparation(0, 27, 12), -54);
  assert.equal(seamSeparation(1, 27, 12), 12);
});

test("with every seam joined the tiles run on without a break from end to end", () => {
  const tiles = layout([0, 0, 0, 0, 0, 0]);
  assert.equal(tiles[0].x, 0);
  const last = tiles[4];
  assert.equal(last.x + last.width, 360);
  for (let i = 1; i < tiles.length; i++) {
    const before = tiles[i - 1];
    assert.ok(tiles[i].x < before.x + before.width, `tile ${i} overlaps the one before`);
  }
  assert.ok(tiles.every((tile) => tile.tint === 0));
});

test("the selected tile sits a gap away from both neighbours and is tinted", () => {
  const tiles = layout(openTargets(5, 2), tintTargets(5, 2));
  const [, b, c, d] = tiles;
  assert.equal(c.x - (b.x + b.width), 12);
  assert.equal(d.x - (c.x + c.width), 12);
  assert.equal(c.tint, 1);
  assert.equal(b.tint, 0, "its neighbours stay part of the slab");
  assert.equal(d.tint, 0);
  assert.equal(tiles[0].x, 0, "the ends of the bar do not move");
});

test("a tab at the end of the bar pulls away on one side only", () => {
  const first = layout(openTargets(5, 0), tintTargets(5, 0));
  assert.equal(first[0].x, 0);
  assert.equal(first[1].x - (first[0].x + first[0].width), 12);
  assert.equal(first[0].tint, 1);
  const last = layout(openTargets(5, 4), tintTargets(5, 4));
  assert.equal(last[4].x + last[4].width, 360);
  assert.equal(last[4].x - (last[3].x + last[3].width), 12);
  assert.equal(last[4].tint, 1);
});

test("tabs of different widths: each tile follows its own seams", () => {
  const uneven = [10, 60, 150, 190, 300, 330];
  const joined = layout([0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0], uneven);
  assert.equal(joined[0].x, 10, "the row's left end is where the first tab begins");
  assert.equal(joined[4].x + joined[4].width, 330);
  const apart = layout(openTargets(5, 2), tintTargets(5, 2), uneven);
  const [, b, c, d] = apart;
  assert.equal(c.x - (b.x + b.width), 12);
  assert.equal(d.x - (c.x + c.width), 12);
  assert.equal(c.x, 150 + 6, "the gap is split evenly either side of the seam");
  assert.equal(c.x + c.width, 190 - 6);
});

test("only the selected tab is tinted, however open the seams around it are", () => {
  assert.deepEqual(tintTargets(5, 2), [0, 0, 1, 0, 0]);
  assert.deepEqual(tintTargets(5, -1), [0, 0, 0, 0, 0]);
  const mid = layout([0, 0, 0.5, 1, 0.5, 0], [0, 0, 1, 0.4, 0]);
  assert.deepEqual(
    mid.map((tile) => tile.tint),
    [0, 0, 1, 0.4, 0],
    "a neighbour does not take the colour just because its seam is opening",
  );
  const over = layout([0, 0, 1, 1, 0, 0], [0, 0, 1.3, -0.2, 0]);
  assert.deepEqual([over[2].tint, over[3].tint], [1, 0], "kept between none and all of it");
});

test("the spring comes to rest on its target, with only a small overshoot", () => {
  let state = { position: 0, velocity: 0 };
  let peak = 0;
  for (let frame = 0; frame < 120; frame++) {
    state = stepSpring(state.position, state.velocity, 1, 1 / 60);
    peak = Math.max(peak, state.position);
  }
  assert.ok(settled(state.position, state.velocity, 1), `at ${state.position}`);
  assert.ok(peak > 1 && peak < 1.12, `overshoot to ${peak}`);
});

test("a long frame does not throw the spring off", () => {
  const long = stepSpring(0, 0, 1, 0.05);
  assert.ok(long.position > 0 && long.position < 1.2);
  assert.ok(Number.isFinite(long.velocity));
});
