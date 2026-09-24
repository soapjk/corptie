import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { buildDirectUserMessageEvidence } from "../src/application/directUserMessageEvidence.mjs";
import {
  authorizeDirectUserTaskCreation,
  directUserTaskCreationRejection,
  isDirectUserMessageSource,
  resolveDirectMessageSourceCategory,
  LOCAL_MESSAGE_SOURCES,
  REMOTE_MESSAGE_SOURCES,
  DIRECT_MESSAGE_SOURCES
} from "../src/application/directUserTaskCreationAuthorization.mjs";

test("direct user message sources categorize into local and remote tiers, excluding dsh", () => {
  assert.equal(resolveDirectMessageSourceCategory("desktop"), "local");
  assert.equal(resolveDirectMessageSourceCategory("macos"), "local");
  assert.equal(resolveDirectMessageSourceCategory("local"), "local");

  assert.equal(resolveDirectMessageSourceCategory("remote-client"), "remote");
  assert.equal(resolveDirectMessageSourceCategory("imgateway"), "remote");
  assert.equal(resolveDirectMessageSourceCategory("feishu"), "remote");
  assert.equal(resolveDirectMessageSourceCategory("remote"), "remote");

  assert.equal(resolveDirectMessageSourceCategory("dsh"), null);
  assert.equal(resolveDirectMessageSourceCategory("unknown"), null);
  assert.equal(resolveDirectMessageSourceCategory(""), null);
  assert.equal(resolveDirectMessageSourceCategory(null), null);

  assert.equal(isDirectUserMessageSource("desktop"), true);
  assert.equal(isDirectUserMessageSource("macos"), true);
  assert.equal(isDirectUserMessageSource("local"), true);
  assert.equal(isDirectUserMessageSource("remote-client"), true);
  assert.equal(isDirectUserMessageSource("imgateway"), true);
  assert.equal(isDirectUserMessageSource("feishu"), true);
  assert.equal(isDirectUserMessageSource("remote"), true);
  assert.equal(isDirectUserMessageSource("dsh"), false);
  assert.equal(DIRECT_MESSAGE_SOURCES.has("dsh"), false);
});

const VALID_DIRECT_SOURCES = [
  // Local clients
  "desktop",
  "macos",
  "local",
  // Remote clients
  "remote-client",
  "imgateway",
  "feishu",
  "remote"
];

for (const type of VALID_DIRECT_SOURCES) {
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

test("unauthorized sources including dsh are rejected from Task creation authorization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-user-evidence-invalid-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    store.createAgent({ id: "agent:one", name: "Agent", role: "independentContributor" });
    store.upsertSession({ id: "session:one", title: "Evidence", agentId: "agent:one", provider: "provider:test", status: "complete" });

    for (const invalidType of ["dsh", "external", "bot", "unknown", ""]) {
      const created = store.createUserMessageDelivery({
        deliveryId: `delivery:invalid:${invalidType || "empty"}`,
        messageId: `message:invalid:${invalidType || "empty"}`,
        sessionId: "session:one",
        binding: { bindingId: "binding:one", routingVersion: 1, providerId: "provider:test", providerSessionId: "thread:one" },
        agentId: "agent:one",
        source: { type: invalidType },
        text: "请创建一个新的 Task 来处理这个需求"
      });
      const reference = { sessionId: "session:one", logicalSessionId: "logical:one" };
      const context = { source: created.task.source };

      // buildDirectUserMessageEvidence must reject non-direct user message sources
      const evidence = buildDirectUserMessageEvidence(store, reference, context);
      assert.equal(evidence, null, `Evidence should be null for invalid source: ${invalidType}`);

      // directUserTaskCreationRejection returns DIRECT_USER_MESSAGE_REQUIRED
      const event = store.getSessionEvent(`user-message:${created.task.taskId}`);
      assert.ok(event);
      const rejection = directUserTaskCreationRejection(event);
      assert.deepEqual(rejection, {
        code: "DIRECT_USER_MESSAGE_REQUIRED",
        message: "Task creation evidence is not a direct user message."
      });

      // authorizeDirectUserTaskCreation throws DIRECT_USER_MESSAGE_REQUIRED (403)
      assert.throws(() => authorizeDirectUserTaskCreation({
        store,
        providerSessionId: reference.sessionId,
        expectedLogicalSessionId: reference.logicalSessionId,
        logicalSessionId: reference.logicalSessionId,
        userMessageEventId: event.eventId,
        userMessageSequence: event.sequence,
        turnId: `delivery:invalid:${invalidType || "empty"}`
      }), (err) => {
        assert.equal(err.code, "DIRECT_USER_MESSAGE_REQUIRED");
        assert.equal(err.statusCode, 403);
        return true;
      });
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

