import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { CollaborationRouter, AssistantNotRoutableError } from "../src/application/collaborationRouter.mjs";

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-collab-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  return { store, directory };
}

test("registerAgent + 目录登记", async () => {
  const { store, directory } = await createStore();
  try {
    const router = new CollaborationRouter({ store });
    router.registerAgent({ agentId: "a1", capabilityTags: ["backend", "rust"], description: "后端" });
    assert.equal(store.listCollaborators("agent").length, 1);
    assert.equal(store.getCollaborator("agent", "a1").availability, "idle");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("路由打分：能力契合 + 声誉 + 可用性", async () => {
  const { store, directory } = await createStore();
  try {
    const router = new CollaborationRouter({ store });
    // 高契合 + 高声誉 + 空闲 → 应胜出
    router.registerAgent({ agentId: "a1", capabilityTags: ["backend", "rust"], availability: "idle" });
    store.upsertReputation("a1", 0.9, 10);
    router.registerAgent({ agentId: "a1", capabilityTags: ["backend", "rust"], availability: "idle" }); // 刷新 trust_score
    // 低契合
    router.registerAgent({ agentId: "a2", capabilityTags: ["frontend"], availability: "idle" });
    // 高契合但 busy
    router.registerAgent({ agentId: "a3", capabilityTags: ["backend", "rust"], availability: "busy" });

    const best = router.routeBest({ requiredCapabilities: ["backend", "rust"] });
    assert.equal(best.candidate.entry_id, "a1");

    const ranked = router.route({ requiredCapabilities: ["backend", "rust"] });
    assert.equal(ranked[0].candidate.entry_id, "a1");
    const busy = ranked.find((x) => x.candidate.entry_id === "a3");
    assert.ok(ranked[0].score > busy.score);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("offline 不参与路由 + collaboration_sessions 生命周期", async () => {
  const { store, directory } = await createStore();
  try {
    const router = new CollaborationRouter({ store });
    router.registerAgent({ agentId: "a1", capabilityTags: ["backend"], availability: "offline" });
    router.registerAgent({ agentId: "a2", capabilityTags: ["backend"], availability: "idle" });

    const ranked = router.route({ requiredCapabilities: ["backend"] });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].candidate.entry_id, "a2");

    const session = store.createCollaborationSession({
      mode: "delegation",
      requesterWorkId: "o1",
      requesterTaskId: "wi1",
      request: { description: "写个后端接口" }
    });
    assert.equal(session.status, "proposed");
    const updated = store.updateCollaborationSession(session.id, {
      status: "accepted",
      candidateEntryType: "agent",
      candidateEntryId: "a2"
    });
    assert.equal(updated.status, "accepted");
    assert.equal(updated.candidate_entry_id, "a2");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("助手 Agent 不入协作目录：registerAgent 拒绝 + route 过滤", async () => {
  const { store, directory } = await createStore();
  try {
    const router = new CollaborationRouter({ store });

    // 1) registerAgent 显式拒绝 assistant
    assert.throws(
      () => router.registerAgent({ agentId: "butler", role: "assistant", capabilityTags: ["meta"] }),
      AssistantNotRoutableError
    );

    // 2) 即便有历史数据把 assistant 写进目录，route 也要过滤掉（双保险）
    store.upsertCollaborator({
      entryType: "agent",
      entryId: "assistant-1",
      role: "assistant",
      capabilityTags: ["backend"],
      availability: "idle"
    });
    router.registerAgent({ agentId: "a1", capabilityTags: ["backend"], availability: "idle" });

    const ranked = router.route({ requiredCapabilities: ["backend"] });
    const ids = ranked.map((x) => x.candidate.entry_id);
    assert.ok(!ids.includes("assistant-1"));
    assert.ok(ids.includes("a1"));
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("14.7 主动触发检测：前三类默认开、第四类默认关", async () => {
  const { store, directory } = await createStore();
  try {
    const router = new CollaborationRouter({ store });

    // 1) Agent 自申报：所需能力不在 capability_pool
    const self = router.detectCollaborationTriggers({
      capabilityPool: ["git", "build"],
      requiredCapabilities: ["rust", "git"]
    });
    assert.equal(self.shouldCollaborate, true);
    assert.ok(self.triggers.some((t) => t.type === "agent_self_report"));

    // 2) 记忆指针：collaborator_ref 记忆
    const pointer = router.detectCollaborationTriggers({
      capabilityPool: ["git"],
      requiredCapabilities: [],
      memoryHits: [{ structured_json: { type: "collaborator_ref", collaborator_ref: "agentX" } }]
    });
    assert.ok(pointer.triggers.some((t) => t.type === "memory_pointer"));

    // 3) guard 阻断
    const guard = router.detectCollaborationTriggers({ capabilityPool: [], requiredCapabilities: [], guardBlocked: true });
    assert.ok(guard.triggers.some((t) => t.type === "guard_block"));

    // 4) 失败重试累积：默认关闭 → 即使超过阈值也不触发
    const failureOff = router.detectCollaborationTriggers({
      capabilityPool: [],
      requiredCapabilities: [],
      consecutiveFailures: 5,
      failureThreshold: 3
    });
    assert.equal(failureOff.shouldCollaborate, false);

    // 显式开启后触发
    const failureOn = router.detectCollaborationTriggers({
      capabilityPool: [],
      requiredCapabilities: [],
      consecutiveFailures: 5,
      failureThreshold: 3,
      enableFailureAccumulation: true
    });
    assert.ok(failureOn.triggers.some((t) => t.type === "failure_accumulation"));

    // 无任何触发
    const none = router.detectCollaborationTriggers({ capabilityPool: ["git"], requiredCapabilities: ["git"], memoryHits: [] });
    assert.equal(none.shouldCollaborate, false);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
