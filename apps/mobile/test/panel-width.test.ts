import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANNEL_MIN,
  clampPanelWidth,
  expandedPanelWidth,
  isExpandedPanel,
  PANEL_DEFAULT,
  PANEL_MIN,
  readPanelWidth,
  writePanelWidth,
} from "../src/panel-width.ts";

test("the panel never gets narrower than its minimum or takes the room the channel needs", () => {
  const container = 1000;
  assert.equal(clampPanelWidth(100, container), PANEL_MIN);
  assert.equal(clampPanelWidth(500, container), 500);
  assert.equal(clampPanelWidth(5000, container), container - CHANNEL_MIN);
});

test("a window too narrow to spare any room still gets a panel of the minimum", () => {
  assert.equal(clampPanelWidth(600, 500), PANEL_MIN);
  assert.equal(clampPanelWidth(600, 0), PANEL_MIN);
});

test("a width that is not a number falls back to the usual one", () => {
  assert.equal(clampPanelWidth(Number.NaN, 1200), PANEL_DEFAULT);
  assert.equal(clampPanelWidth(Number.POSITIVE_INFINITY, 1200), PANEL_DEFAULT);
});

test("the wide setting is about three fifths of the space, and what is wide is wider than usual", () => {
  assert.equal(expandedPanelWidth(1000), 580); // the channel keeps its 420
  assert.equal(expandedPanelWidth(1200), 720);
  assert.equal(expandedPanelWidth(1600), 960);
  // On a window that cannot spare it, wide is as wide as the channel allows.
  assert.equal(expandedPanelWidth(800), 380);
  for (const container of [840, 1000, 1280, 1920]) {
    assert.ok(expandedPanelWidth(container) > PANEL_DEFAULT, `wider than usual at ${container}`);
  }
});

test("a panel is wide when it is at the wide setting, give or take a pixel", () => {
  assert.equal(isExpandedPanel(600, 1000), true);
  assert.equal(isExpandedPanel(597, 1000), true);
  assert.equal(isExpandedPanel(PANEL_DEFAULT, 1000), false);
});

test("the width a person chose is kept, and a blocked or empty store is not an error", () => {
  const kept = new Map<string, string>();
  const store = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  };
  assert.equal(readPanelWidth(store), undefined);
  writePanelWidth(512.4, store);
  assert.equal(readPanelWidth(store), 512);
  kept.set("hive.threadPanelWidth", "not a number");
  assert.equal(readPanelWidth(store), undefined);
  kept.set("hive.threadPanelWidth", "-20");
  assert.equal(readPanelWidth(store), undefined);

  const blocked = {
    getItem: () => {
      throw new Error("Storage is blocked");
    },
    setItem: () => {
      throw new Error("Storage is blocked");
    },
  };
  assert.equal(readPanelWidth(blocked), undefined);
  assert.doesNotThrow(() => writePanelWidth(500, blocked));
  assert.equal(readPanelWidth(undefined), undefined);
});
