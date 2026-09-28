import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("collaboration and hub facade forwards caller arguments without changing them", () => {
  const store = new CorptieStore({ dbPath: ":memory:", manageProcessEnvironment: false });
  const received = [];
  store.collaborationDirectoryRepository.createCollaborationSession = (...args) => received.push(args);
  store.collaborationDirectoryRepository.updateCollaborationSession = (...args) => received.push(args);
  store.hubRepository.registerActiveTool = (...args) => received.push(args);
  store.createCollaborationSession();
  store.updateCollaborationSession("collab:test");
  store.registerActiveTool("session:test", "test");
  assert.deepEqual(received, [[], ["collab:test"], ["session:test", "test"]]);
});

test("directory, collaboration and hub records share the Store rollback boundary", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-directory-repository-config",
    manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const write = () => {
      store.upsertCollaborator({ entryType: "agent", entryId: "agent:test" });
      store.createCollaborationSession({
        id: "collab:test", mode: "ask", requesterSessionId: "session:test",
        candidateEntryId: "agent:test", candidateEntryType: "agent"
      });
      store.upsertReputation("agent:test", 0.8, 3);
      store.cacheHubIntent({ agentId: "agent:test", intentHash: "hash", result: { matches: [] } });
      store.registerActiveTool("session:test", "test", { description: "test" });
    };
    const failure = new Error("rollback");
    assert.throws(() => store.runInTransaction(() => {
      write();
      assert.equal(notifications, 0);
      throw failure;
    }), error => error === failure);
    assert.equal(store.getCollaborator("agent", "agent:test"), null);
    assert.equal(store.getCollaborationSession("collab:test"), null);
    assert.equal(store.getReputation("agent:test"), null);
    assert.equal(store.getHubIntentCache("hash", { agentId: "agent:test" }), null);
    assert.deepEqual(store.listActiveTools("session:test"), []);
    assert.equal(notifications, 0);
    store.runInTransaction(write);
    assert.equal(notifications, 1);
    assert.equal(store.countActiveCollaborations("agent:test"), 1);
    store.updateCollaborationSession("collab:test", { status: "closed", result: { answer: "done" } });
    assert.equal(store.countActiveCollaborations("agent:test"), 0);
    assert.equal(store.getReputation("agent:test").sample_count, 3);
    assert.equal(store.getHubIntentCache("hash", { agentId: "agent:other" }), null);
    assert.equal(store.listActiveTools("session:test")[0].tool_name, "test");
  } finally {
    await store.close();
  }
});
