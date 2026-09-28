import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("Feishu repository follows Store connection replacement and outer rollback", async () => {
  const stores = [0, 1].map(() => new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-feishu-repository-config",
    manageProcessEnvironment: false
  }));
  const [store, replacement] = stores;
  let original;
  try {
    for (const item of stores) await item.initialize({ resolveDataPath: false });
    original = store.db;
    store.createFeishuBot({ id: "old", name: "Old", profile: "old", enabled: false });
    const repository = store.feishuRepository;
    store.db = replacement.db;
    assert.equal(store.feishuRepository, repository);
    assert.deepEqual(store.listFeishuBots(), []);
    const failure = new Error("outer rollback");
    assert.throws(() => store.runInTransaction(() => {
      store.createFeishuBot({ id: "rollback", name: "Rollback", profile: "rollback", enabled: false });
      throw failure;
    }), error => error === failure);
    assert.equal(store.getFeishuBot("rollback"), null);
    store.createFeishuBot({ id: "new", name: "New", profile: "new", enabled: false });
    assert.equal(replacement.getFeishuBot("new").name, "New");
    store.db = original;
    assert.equal(store.getFeishuBot("new"), null);
    assert.equal(store.getFeishuBot("old").name, "Old");
  } finally {
    if (original) store.db = original;
    for (const item of stores) await item.close();
  }
});
