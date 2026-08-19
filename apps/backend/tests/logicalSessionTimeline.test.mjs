import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHistoricalSessionContext,
  composeLogicalSessionTimeline
} from "../src/application/logicalSessionTimeline.mjs";

test("logical Session timeline keeps historical Provider messages before the active transcript", async () => {
  const bindings = [
    { bindingId: "binding:active", providerId: "codex-app-server", state: "active", routingVersion: 2 },
    { bindingId: "binding:old", providerId: "openclacky", state: "superseded", routingVersion: 1 }
  ];
  const items = await composeLogicalSessionTimeline({
    bindings,
    activeDetail: {
      items: [
        { id: "message:1", turnId: "turn:1", type: "userMessage", text: "new Provider message" }
      ]
    },
    readHistoricalBinding: async (binding) => ({
      items: [
        { id: "message:1", turnId: "turn:1", type: "userMessage", text: "old Provider message" },
        { id: "message:2", turnId: "turn:1", type: "agentMessage", text: "old Provider answer" }
      ],
      binding
    })
  });

  assert.deepEqual(items.map((item) => item.text), [
    "old Provider message",
    "old Provider answer",
    "new Provider message"
  ]);
  assert.equal(items[0].id, "binding:old:message:1");
  assert.equal(items[0].turnId, "binding:old:turn:1");
  assert.equal(items[2].id, "message:1");
  assert.equal(items[2].providerBinding.state, "active");
});

test("a Session without historical bindings keeps active item identities unchanged", async () => {
  const activeItems = [{ id: "message:active", turnId: "turn:active", text: "hello" }];
  const items = await composeLogicalSessionTimeline({
    bindings: [{ bindingId: "binding:active", state: "active", routingVersion: 1 }],
    activeDetail: { items: activeItems }
  });
  assert.deepEqual(items, activeItems);
});

test("historical context carries only bounded surface conversation into the new Provider", async () => {
  const context = await buildHistoricalSessionContext({
    bindings: [
      { bindingId: "binding:old", providerId: "openclacky", state: "superseded", routingVersion: 1 },
      { bindingId: "binding:active", providerId: "codex-app-server", state: "active", routingVersion: 2 }
    ],
    maxMessages: 2,
    readHistoricalBinding: async () => ({
      items: [
        { id: "old-user", type: "userMessage", text: "first question" },
        { id: "tool", type: "commandExecution", text: "large execution output" },
        { id: "old-agent", type: "agentMessage", text: "first answer" },
        { id: "latest-user", type: "userMessage", text: "latest question" }
      ]
    })
  });

  assert.equal(context.messageCount, 2);
  assert.match(context.prompt, /Assistant: first answer/);
  assert.match(context.prompt, /User: latest question/);
  assert.doesNotMatch(context.prompt, /large execution output|first question/);
});
