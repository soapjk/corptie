import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSessionHistoryLimit,
  pageSessionItems,
  windowSessionItems,
  windowSessionItemsAroundAnchor
} from "../src/application/sessionHistoryWindow.mjs";

const items = (count) => Array.from({ length: count }, (_, index) => ({ id: `item-${index}` }));

test("session snapshot keeps only the newest bounded history window", () => {
  const result = windowSessionItems(items(450));
  assert.equal(result.items.length, 200);
  assert.equal(result.items[0].id, "item-250");
  assert.equal(result.items.at(-1).id, "item-449");
  assert.equal(result.hasMoreHistory, true);
  assert.equal(result.historyItemsCount, 250);
});

test("small session snapshot remains complete", () => {
  const source = items(20);
  assert.deepEqual(windowSessionItems(source), {
    items: source,
    hasMoreHistory: false,
    historyItemsCount: 0
  });
});

test("cursor pages are contiguous, ordered, and non-overlapping", () => {
  const source = items(450);
  const first = pageSessionItems(source, { beforeId: "item-250", limit: 200 });
  const second = pageSessionItems(source, { beforeId: first.items[0].id, limit: 200 });

  assert.equal(first.items[0].id, "item-50");
  assert.equal(first.items.at(-1).id, "item-249");
  assert.equal(first.historyItemsCount, 50);
  assert.equal(second.items[0].id, "item-0");
  assert.equal(second.items.at(-1).id, "item-49");
  assert.equal(second.hasMoreHistory, false);
  assert.equal(new Set([...second.items, ...first.items].map((item) => item.id)).size, 250);
});

test("unknown or exhausted cursors cannot replay history", () => {
  const source = items(20);
  assert.deepEqual(pageSessionItems(source, { beforeId: "missing" }), {
    items: [], hasMoreHistory: false, historyItemsCount: 0
  });
  assert.deepEqual(pageSessionItems(source, { beforeId: "item-0" }), {
    items: [], hasMoreHistory: false, historyItemsCount: 0
  });
});

test("history limits are finite positive integers capped at 200", () => {
  assert.equal(normalizeSessionHistoryLimit("25.9"), 25);
  assert.equal(normalizeSessionHistoryLimit("999"), 200);
  assert.equal(normalizeSessionHistoryLimit("bad"), 200);
  assert.equal(normalizeSessionHistoryLimit("0"), 200);
});

test("anchor window returns one bounded item neighborhood", () => {
  const source = items(1_000);
  const result = windowSessionItemsAroundAnchor(source, {
    anchorKind: "item",
    anchorId: "item-500",
    before: 20,
    after: 30
  });

  assert.equal(result.anchor.status, "found");
  assert.equal(result.items.length, 51);
  assert.equal(result.items[0].id, "item-480");
  assert.equal(result.items.at(-1).id, "item-530");
  assert.equal(result.hasEarlier, true);
  assert.equal(result.hasLater, true);
});

test("turn anchor includes the complete contiguous turn", () => {
  const source = [
    { id: "before", turnId: "turn-a" },
    { id: "turn-1", turnId: "turn-b" },
    { id: "turn-2", turnId: "turn-b" },
    { id: "after", turnId: "turn-c" }
  ];
  const result = windowSessionItemsAroundAnchor(source, {
    anchorKind: "turn",
    anchorId: "turn-b",
    before: 1,
    after: 1
  });

  assert.deepEqual(result.items.map((item) => item.id), ["before", "turn-1", "turn-2", "after"]);
  assert.equal(result.anchor.resolvedId, "turn-b");
});

test("missing anchor returns an explicit stable result", () => {
  const result = windowSessionItemsAroundAnchor(items(20), {
    anchorKind: "item",
    anchorId: "deleted"
  });

  assert.deepEqual(result, {
    items: [],
    anchor: { kind: "item", requestedId: "deleted", resolvedId: null, status: "missing" },
    hasEarlier: false,
    hasLater: false
  });
});
