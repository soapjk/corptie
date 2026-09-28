import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("Agent creation receipts and skill assignment audit retain atomic rollback and idempotent replay", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-agent-config", manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    store.createRegistrySkill({ id: "skill:first", name: "First", source: "/fixture/first" });
    store.createRegistrySkill({ id: "skill:second", name: "Second", source: "/fixture/second" });
    const agentInput = { id: "agent:retry", name: "Original" };
    const request = { idempotencyKey: "create-agent", requestHash: "hash", requestId: "request:one" };
    const revision = store.stateRevision();
    const failure = new Error("injected receipt failure");
    const run = store.db.run;
    store.db.run = function (sql, ...args) {
      if (sql.includes("INSERT INTO agent_creation_requests")) throw failure;
      return run.call(this, sql, ...args);
    };
    try {
      assert.throws(() => store.createAgentWithRegistrySkillsIdempotently(agentInput, ["skill:first"], request), error => error === failure);
    } finally {
      store.db.run = run;
    }
    assert.equal(store.getAgent(agentInput.id), null);
    assert.deepEqual(store.listRegistrySkillIdsForAgent(agentInput.id), []);
    assert.deepEqual(store.listSkillRuntimeEvents({ agentId: agentInput.id }), []);
    assert.equal(store.selectOne("SELECT * FROM agent_creation_requests WHERE idempotency_key=?", [request.idempotencyKey]), null);
    assert.equal(store.stateRevision(), revision);
    const created = store.createAgentWithRegistrySkillsIdempotently(agentInput, ["skill:first"], request);
    assert.equal(created.replayed, false);
    const committedRevision = store.stateRevision();
    const replay = store.createAgentWithRegistrySkillsIdempotently(agentInput, ["skill:first"], request);
    assert.equal(replay.replayed, true);
    assert.equal(replay.agent.agentId, created.agent.agentId);
    assert.equal(store.stateRevision(), committedRevision);
    assert.throws(() => store.createAgentWithRegistrySkillsIdempotently(agentInput, [], { ...request, requestHash: "different" }), { code: "IDEMPOTENCY_CONFLICT" });
    const events = store.listSkillRuntimeEvents({ agentId: agentInput.id });
    const recordEvent = store.recordSkillRuntimeEvent;
    store.recordSkillRuntimeEvent = () => { throw failure; };
    try {
      assert.throws(() => store.updateAgentWithRegistrySkills(agentInput.id, { name: "Changed" }, ["skill:second"]), error => error === failure);
    } finally {
      store.recordSkillRuntimeEvent = recordEvent;
    }
    assert.deepEqual(store.getAgent(agentInput.id), created.agent);
    assert.deepEqual(store.listRegistrySkillIdsForAgent(agentInput.id), ["skill:first"]);
    assert.deepEqual(store.listSkillRuntimeEvents({ agentId: agentInput.id }), events);
    assert.equal(store.stateRevision(), committedRevision);
    assert.equal(store.updateAgentWithRegistrySkills(agentInput.id, { name: "Changed" }, ["skill:second"]).name, "Changed");
    assert.deepEqual(store.listRegistrySkillIdsForAgent(agentInput.id), ["skill:second"]);
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await store.close();
  }
});
