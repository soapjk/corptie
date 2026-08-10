import assert from "node:assert/strict";
import test from "node:test";

import { mergeSupplementalTimelineItems } from "../src/utils/sessionItemTimeline.mjs";

test("places a supplemental card after its source turn", () => {
  const detailItems = [
    { id: "user-a", turnId: "turn-a", type: "userMessage", createdAt: "2026-08-10T08:00:00Z" },
    { id: "reasoning-a", turnId: "turn-a", type: "reasoning" },
    { id: "answer-a", turnId: "turn-a", type: "agentMessage", createdAt: "2026-08-10T08:00:00Z" },
    { id: "user-b", turnId: "turn-b", type: "userMessage", createdAt: "2026-08-10T09:00:00Z" }
  ];
  const card = {
    id: "confirmation-a",
    turnId: "turn-a",
    type: "collaborationConfirmation",
    createdAt: "2026-08-10T08:30:00Z"
  };

  const result = mergeSupplementalTimelineItems(detailItems, [card]);

  assert.deepEqual(result.map((item) => item.id), [
    "user-a", "reasoning-a", "answer-a", "confirmation-a", "user-b"
  ]);
});

test("uses timestamps to place cards without a matching source turn before the next complete turn", () => {
  const detailItems = [
    { id: "user-a", turnId: "turn-a", createdAt: "2026-08-10T08:00:00Z" },
    { id: "answer-a", turnId: "turn-a", createdAt: "2026-08-10T08:00:00Z" },
    { id: "user-b", turnId: "turn-b", createdAt: "2026-08-10T09:00:00Z" },
    { id: "reasoning-b", turnId: "turn-b" },
    { id: "answer-b", turnId: "turn-b", createdAt: "2026-08-10T09:00:00Z" }
  ];
  const card = {
    id: "confirmation-a",
    turnId: "collaboration-confirmation:a",
    createdAt: "2026-08-10T08:30:00Z"
  };

  const result = mergeSupplementalTimelineItems(detailItems, [card]);

  assert.deepEqual(result.map((item) => item.id), [
    "user-a", "answer-a", "confirmation-a", "user-b", "reasoning-b", "answer-b"
  ]);
});

test("preserves provider order and orders cards stably at the same insertion point", () => {
  const detailItems = [
    { id: "old-turn", turnId: "old", createdAt: "2026-08-10T08:00:00Z" },
    { id: "new-turn", turnId: "new", createdAt: "2026-08-10T10:00:00Z" }
  ];
  const cards = [
    { id: "later-card", createdAt: "2026-08-10T09:30:00Z" },
    { id: "first-equal-card", createdAt: "2026-08-10T09:00:00Z" },
    { id: "second-equal-card", createdAt: "2026-08-10T09:00:00Z" }
  ];

  const result = mergeSupplementalTimelineItems(detailItems, cards);

  assert.deepEqual(result.map((item) => item.id), [
    "old-turn", "first-equal-card", "second-equal-card", "later-card", "new-turn"
  ]);
});
