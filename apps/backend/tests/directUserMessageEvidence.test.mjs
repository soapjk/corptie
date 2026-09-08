import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { buildDirectUserMessageEvidence } from "../src/application/directUserMessageEvidence.mjs";
import { authorizeDirectUserTaskCreation } from "../src/application/directUserTaskCreationAuthorization.mjs";

for (const type of ["desktop", "macos", "imgateway", "feishu", "dsh"]) {
  test(`persisted direct user evidence reaches Task authorization: ${type}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "corptie-user-evidence-"));
    const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
    await store.initialize();
    try {
      store.createAgent({ id: "agent:one", name: "Agent", role: "independentContributor" });
      store.upsertSession({ id: "session:one", title: "Evidence", agentId: "agent:one", provider: "provider:test", status: "complete" });
      const created = store.createUserMessageDelivery({
        deliveryId: "delivery:one", messageId: "message:one", sessionId: "session:one",
        binding: { bindingId: "binding:one", routingVersion: 1, providerId: "provider:test", providerSessionId: "thread:one" },
        agentId: "agent:one", source: { type },
        text: "<p>你来创建另外两个task，分别探索第2和第3排序</p>"
      });
      const reference = { sessionId: "session:one", logicalSessionId: "logical:one" };
      const context = { source: created.task.source };
      const evidence = buildDirectUserMessageEvidence(store, reference, context);
      assert.ok(evidence);
      const attributes = Object.fromEntries([...evidence.prompt.matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
      const authorization = {
        store, providerSessionId: reference.sessionId, expectedLogicalSessionId: reference.logicalSessionId,
        logicalSessionId: attributes.logical_session_id, userMessageEventId: attributes.event_id,
        userMessageSequence: attributes.sequence, turnId: attributes.turn_id
      };
      assert.equal(authorizeDirectUserTaskCreation(authorization).eventId, "user-message:message:one");
      assert.equal(buildDirectUserMessageEvidence(store, { ...reference, sessionId: "session:other" }, context), null);
      assert.equal(buildDirectUserMessageEvidence(store, reference, { source: { ...context.source, deliveryId: "delivery:other" } }), null);
      for (const source of [{ type: "collaboration" }, { type: "automation" }, { type, taskId: "task:peer" }, { type, scheduledTaskId: "scheduled:one" }]) {
        assert.equal(buildDirectUserMessageEvidence(store, reference, { source: { ...context.source, ...source } }), null);
      }
      const event = store.getSessionEvent(attributes.event_id);
      for (const changes of [{ producer: "assistant" }, { surface: false }, { source: { type: "collaboration" } }, { payload: { ...event.payload, deliveryId: "missing" } }]) {
        const modifiedStore = { getSessionEvent: () => ({ ...event, ...changes }), getMessageDelivery: id => store.getMessageDelivery(id) };
        assert.equal(buildDirectUserMessageEvidence(modifiedStore, reference, context), null);
      }
      assert.throws(() => authorizeDirectUserTaskCreation({ ...authorization,
        store: { getSessionEventByIdentity: () => ({ ...event, payload: { ...event.payload, message: { text: "继续修复，不要创建新Task" } } }), getMessageDelivery: id => store.getMessageDelivery(id) }
      }), { code: "USER_MESSAGE_TASK_CREATION_INTENT_MISSING" });
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
