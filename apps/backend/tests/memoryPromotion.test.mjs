import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-promotion-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  return { store, directory };
}

test("memories 携带 auto_applied/applied_at/revoked_at 三字段", async () => {
  const { store, directory } = await createStore();
  try {
    const m = store.createMemory({
      ownerType: "agent",
      ownerId: "a1",
      kind: "skill",
      content: "x",
      autoApplied: true,
      appliedAt: "2026-01-01T00:00:00Z"
    });
    assert.equal(m.auto_applied, 1);
    assert.equal(m.applied_at, "2026-01-01T00:00:00Z");
    assert.equal(m.revoked_at, null);

    const updated = store.updateMemory(m.id, { revokedAt: "2026-02-01T00:00:00Z" });
    assert.equal(updated.revoked_at, "2026-02-01T00:00:00Z");
    assert.equal(updated.auto_applied, 1); // 未传则不覆盖
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("promoteMemoryToSkill 落 skills 表并保留溯源", async () => {
  const { store, directory } = await createStore();
  try {
    const m = store.createMemory({
      ownerType: "agent",
      ownerId: "a1",
      kind: "skill",
      content: "统一用 node:sqlite 的 DatabaseSync",
      usageCount: 6,
      confidence: 0.8
    });
    const skill = store.promoteMemoryToSkill(m.id, {
      name: "sqlite-sync-wrapper",
      scenario: "读写 Corptie SQLite",
      trigger: "需要持久化时",
      steps: ["创建 store", "用 run/prepare"],
      riskLevel: "low"
    });
    assert.equal(skill.name, "sqlite-sync-wrapper");
    assert.equal(skill.source_memory_id, m.id);
    assert.equal(skill.status, "draft");

    // 原记忆标记 promoted_to_skill，保留溯源
    const after = store.getMemory(m.id);
    assert.equal(after.promotion_status, "promoted_to_skill");
    assert.equal(after.promoted_skill_id, skill.id);

    // discoverable 仅返回 approved/published
    assert.equal(store.listDiscoverableSkills().length, 0);
    store.updateSkillStatus(skill.id, "published");
    assert.equal(store.listDiscoverableSkills().length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("listPromotionCandidates 只返回满足置信度/用量阈值的能力类记忆", async () => {
  const { store, directory } = await createStore();
  try {
    store.createObjective({ id: "o", name: "Objective" });
    store.createWorkItem({ id: "w", objectiveId: "o", title: "WorkItem" });
    store.createSession({
      id: "s", title: "Worker", provider: "codex-app-server", status: "running",
      objectiveId: "o", workItemId: "w", agentId: "a1"
    });
    // 合格：agent + skill + 高置信 + 高用量
    store.createMemory({ ownerType: "agent", ownerId: "a1", kind: "skill", content: "x", confidence: 0.9, usageCount: 6 });
    // 用量不足
    store.createMemory({ ownerType: "agent", ownerId: "a1", kind: "procedure", content: "y", confidence: 0.9, usageCount: 2 });
    // 非能力类
    store.createMemory({ ownerType: "agent", ownerId: "a1", kind: "fact", content: "z", confidence: 0.9, usageCount: 6 });
    // 非 agent owner
    store.createMemory({
      ownerType: "work_item", ownerId: "w", workItemId: "w", sourceSessionId: "s",
      kind: "skill", content: "w", confidence: 0.9, usageCount: 6
    });
    // 已晋升
    store.createMemory({ ownerType: "agent", ownerId: "a1", kind: "dev_experience", content: "d", confidence: 0.9, usageCount: 6, promotionStatus: "promoted_to_skill" });

    const candidates = store.listPromotionCandidates();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].kind, "skill");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("applyConfidenceDecay 按 kind 衰减并归档低置信记忆", async () => {
  const { store, directory } = await createStore();
  try {
    const episodic = store.createMemory({ ownerType: "agent", ownerId: "a1", kind: "episodic", content: "e", baseConfidence: 0.9 });
    // 回拨 updated_at 到很久以前，让 recency 趋近 0 → 归档
    const old = "2020-01-01T00:00:00Z";
    store.updateMemory(episodic.id, {});
    store.db.run(`UPDATE memories SET updated_at = ? WHERE id = ?`, [old, episodic.id]);

    const results = store.applyConfidenceDecay("agent", "a1", new Date("2026-01-01T00:00:00Z"));
    const after = results.find((m) => m.id === episodic.id);
    assert.ok(after.confidence < 0.2);
    assert.equal(after.promotion_status, "archived");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
