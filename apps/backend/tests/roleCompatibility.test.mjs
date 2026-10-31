import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { AgentRepository } from "../src/store/repositories/agentRepository.mjs";
import { RoleRepository, roleToLegacyAgentWire } from "../src/store/repositories/roleRepository.mjs";
import { agentIdSchema, roleIdSchema } from "../src/domain/taskToolSchema.mjs";

test("Role and legacy Agent APIs share identity, transactions, skills and idempotent receipts", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-role-config", manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    assert.equal(AgentRepository, RoleRepository);
    store.createRegistrySkill({ id: "skill:role", name: "Role skill", source: "/fixture/role" });
    const input = { id: "agent:role", name: "Research", systemPrompt: "Research carefully" };
    const request = { idempotencyKey: "role-create", requestHash: "existing-receipt-format", requestId: "request:role" };
    const created = store.createRoleWithRegistrySkillsIdempotently(input, ["skill:role"], request);
    assert.equal(created.role.roleId, input.id);
    assert.equal(created.role.roleKind, "user");
    assert.equal("agentId" in created.role, false);
    assert.deepEqual(store.getAgent(input.id), roleToLegacyAgentWire(created.role));
    const revision = store.stateRevision();
    const replay = store.createAgentWithRegistrySkillsIdempotently(input, ["skill:role"], request);
    assert.equal(replay.replayed, true);
    assert.equal(replay.agent.agentId, input.id);
    assert.equal(store.stateRevision(), revision);
    assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM agents WHERE agent_id=?", [input.id]).count, 1);
    assert.deepEqual(store.listRegistrySkillIdsForAgent(input.id), ["skill:role"]);
    const before = store.getRole(input.id);
    assert.throws(() => store.updateRoleWithRegistrySkills(input.id, { name: "Wrong" }, ["skill:missing"]), { code: "SKILL_NOT_FOUND" });
    assert.deepEqual(store.getRole(input.id), before);
    assert.equal(store.updateRole(input.id, { name: "Updated" }).name, "Updated");
    assert.equal(store.getAgent(input.id).name, "Updated");
    assert.throws(() => store.deleteRole("assistant"), { code: "SYSTEM_AGENT_PROTECTED" });
    assert.equal(store.deleteRole(input.id), true);
    assert.equal(store.getAgent(input.id), null);
  } finally { await store.close(); }
});

test("Role directory is a resource projection, not another executor or authorization principal", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-role-directory", manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    const core = new CollaborationCore(store);
    const role = core.registerRole({ roleId: "agent:directory-role", name: "Writer" });
    assert.equal(role.roleId, "agent:directory-role");
    assert.equal(core.getAgent(role.roleId).agentId, role.roleId);
    assert.equal(core.listRoles().filter(item => item.roleId === role.roleId).length, 1);
    assert.equal(roleIdSchema, agentIdSchema);
    assert.match(roleIdSchema.description, /not an executor or authorization principal/);
  } finally { await store.close(); }
});
