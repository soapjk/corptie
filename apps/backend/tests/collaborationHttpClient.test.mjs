import assert from "node:assert/strict";
import test from "node:test";
import { CollaborationHttpClient } from "../src/mcp/collaborationHttpClient.mjs";

test("catalog change subscription filters Agent events and observes Skill events", async () => {
  const encoder = new TextEncoder();
  const frames = [
    ["AgentChanged", { payload: { entity: { agentId: "agent:other" } } }],
    ["AgentChanged", { payload: { entity: { agentId: "agent:mine" } } }],
    ["SkillChanged", { payload: { entity: { skillId: "skill:1" } } }]
  ].map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const client = new CollaborationHttpClient({
    agentId: "agent:mine",
    baseUrl: "http://127.0.0.1:1",
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frames));
        controller.close();
      }
    }), { status: 200, headers: { "content-type": "text/event-stream" } })
  });
  let changes = 0;
  let unsubscribe;
  const observed = new Promise((resolve) => {
    unsubscribe = client.subscribeCatalogChanges(() => {
      changes += 1;
      if (changes === 2) {
        unsubscribe();
        resolve();
      }
    });
  });
  await observed;
  assert.equal(changes, 2);
});
