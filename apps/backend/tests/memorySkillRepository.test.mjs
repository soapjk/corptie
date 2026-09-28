import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("memory, embedding, promotion and audit roll back on the Store connection", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-memory-repository-config",
    manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    store.createAgent({ id: "agent:memory", name: "Memory" });
    const input = {
      id: "memory:test", ownerType: "agent", ownerId: "agent:memory",
      kind: "procedure", content: "Verified procedure", trustLevel: "trusted"
    };
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const write = () => {
      store.createMemory(input);
      store.setMemoryEmbedding(input.id, [0.1, 0.2]);
      store.promoteMemoryToSkill(input.id, { id: "skill:promoted", name: "Promoted" });
    };
    const failure = new Error("rollback");
    assert.throws(() => store.runInTransaction(() => {
      write();
      assert.equal(notifications, 0);
      throw failure;
    }), error => error === failure);
    assert.equal(store.getMemory(input.id), null);
    assert.equal(store.getMemoryEmbedding(input.id), null);
    assert.equal(store.getSkill("skill:promoted"), null);
    assert.deepEqual(store.listMemoryAudit({ memoryId: input.id }), []);
    assert.equal(notifications, 0);
    store.runInTransaction(write);
    assert.equal(notifications, 1);
    assert.equal(store.getMemory(input.id).promotion_status, "promoted_to_skill");
    assert.deepEqual(store.getMemoryEmbedding(input.id), [0.1, 0.2]);
    assert.equal(store.getSkill("skill:promoted").source_memory_id, input.id);
    assert.equal(store.listMemoryAudit({ memoryId: input.id })[0].action, "promote_to_skill");
  } finally {
    await store.close();
  }
});
