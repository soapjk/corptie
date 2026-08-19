import assert from "node:assert/strict";
import test from "node:test";
import { projectStoredSessionTimeline } from "../src/application/storedSessionTimeline.mjs";

test("stored timeline recovers user messages and completed Provider turns", () => {
  const items = projectStoredSessionTimeline([
    {
      eventId: "event-3",
      sequence: 3,
      type: "CodexThreadCompleted",
      createdAt: "2026-08-18T00:00:03Z",
      payload: {
        turn: {
          id: "turn-1",
          items: [{ id: "agent-1", type: "agentMessage", text: "Done" }]
        },
        session: { summary: "Done" }
      }
    },
    {
      eventId: "event-1",
      sequence: 1,
      type: "SessionUserMessageCreated",
      createdAt: "2026-08-18T00:00:01Z",
      payload: { message: { id: "user-1", text: "Please fix this" } }
    },
    {
      eventId: "event-2",
      sequence: 2,
      type: "CodexThreadProgressChanged",
      payload: { session: { summary: "Noisy intermediate status" } }
    }
  ]);

  assert.deepEqual(items.map((item) => [item.id, item.type, item.text]), [
    ["user-1", "userMessage", "Please fix this"],
    ["agent-1", "agentMessage", "Done"]
  ]);
});

test("surface messages win over legacy fallback events without duplication", () => {
  const items = projectStoredSessionTimeline([
    {
      eventId: "legacy-user",
      sequence: 1,
      type: "SessionUserMessageCreated",
      payload: { message: { id: "legacy", text: "Hello" } }
    },
    {
      eventId: "surface-user",
      sequence: 2,
      type: "user/message",
      createdAt: "2026-08-18T00:00:02Z",
      payload: { text: "Hello" }
    },
    {
      eventId: "surface-agent",
      sequence: 3,
      type: "assistant/message",
      createdAt: "2026-08-18T00:00:03Z",
      payload: { text: "Hi" }
    }
  ]);

  assert.deepEqual(items.map((item) => item.id), ["surface-user", "surface-agent"]);
});
