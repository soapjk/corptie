import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("registry metadata and runtime audit share rollback and notification ownership", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-skill-repository-config",
    manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const input = { id: "skill:test", name: "Test", source: "/fixture" };
    const event = { eventId: "event:test", stage: "registration", status: "success", skillId: input.id };
    const failure = new Error("audit rollback");
    assert.throws(() => store.runInTransaction(() => {
      store.createRegistrySkill(input);
      store.recordSkillRuntimeEvent(event);
      assert.equal(notifications, 0);
      throw failure;
    }), error => error === failure);
    assert.equal(store.getRegistrySkill(input.id), null);
    assert.equal(store.getSkillRuntimeEvent(event.eventId), null);
    assert.equal(notifications, 0);
    store.runInTransaction(() => {
      store.createRegistrySkill(input);
      store.recordSkillRuntimeEvent(event);
    });
    assert.equal(notifications, 1);
    assert.equal(store.listSkillRuntimeEvents({ skillId: input.id }).length, 1);
    assert.throws(() => store.recordSkillRuntimeEvent({ ...event, status: "unknown" }), TypeError);
    const skill = store.getRegistrySkill(input.id);
    const impact = store.registrySkillDeletionImpact(input.id);
    const operation = store.createSkillDeletionOperation({ skill, impact });
    assert.equal(operation.skillId, input.id);
    assert.equal(operation.status, "pending");
    assert.equal(store.deleteRegistrySkill(input.id), true);
    assert.equal(store.getRegistrySkill(input.id), null);
    assert.equal(store.getSkillDeletionOperation(operation.operationId).skillName, "Test");
  } finally {
    await store.close();
  }
});
