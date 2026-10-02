import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextReadService } from "../src/application/contextReadService.mjs";
import { createHostToolCatalog } from "../src/application/hostToolCatalogComposition.mjs";
import { buildToolExposurePlan } from "../src/application/toolExposurePlan.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-context-read-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json") });
  await store.initialize();
  const agent = store.createAgent({ id: "agent:reader", name: "Reader", role: "independentContributor" });
  store.createWork({ id: "work:a", name: "Source", contributorAgentIds: [agent.agentId] });
  store.createWork({ id: "work:b", name: "llmay", description: "Public relay design",
    contributorAgentIds: [agent.agentId] });
  store.createTask({ id: "task:b", workId: "work:b", title: "Relay forwarding",
    description: "TLS long connection", acceptanceCriteria: "Pinned certificate" });
  store.createSession({ id: "session:assistant", title: "Assistant", sessionKind: "assistantChat",
    agentId: agent.agentId });
  store.createSession({ id: "session:work", title: "Source chat", sessionKind: "workChat",
    workId: "work:a", agentId: agent.agentId });
  store.createTask({ id: "task:a", workId: "work:a", title: "Read reference" });
  store.createSession({ id: "session:worker", title: "Worker", sessionKind: "worker",
    workId: "work:a", taskId: "task:a", agentId: agent.agentId });
  store.createSession({ id: "session:target", title: "Relay discussion", sessionKind: "worker",
    workId: "work:b", taskId: "task:b", agentId: agent.agentId, archived: true });
  store.upsertTimelineItemProjection("session:target", {
    id: "msg:1", turnId: "turn:1", turnStatus: "completed", type: "userMessage",
    title: "User", text: "Use TLS relay", status: "completed", createdAt: "2026-10-01T00:00:00Z"
  });
  store.upsertTimelineItemProjection("session:target", {
    id: "msg:2", turnId: "turn:1", turnStatus: "completed", type: "agentMessage",
    title: "Agent", text: "Keep end-to-end identity", status: "completed", createdAt: "2026-10-01T00:00:01Z"
  });
  store.upsertTimelineItemProjection("session:target", {
    id: "tool:1", turnId: "turn:1", turnStatus: "completed", type: "commandExecution",
    title: "Tool", text: "SECRET_INTERNAL", status: "completed", createdAt: "2026-10-01T00:00:02Z"
  });
  store.createArtifactMetadata({ artifactId: "artifact:relay", workId: "work:b",
    title: "Relay plan", summary: "Gateway topology", visibility: "work_private", scope: "work",
    actorId: agent.agentId, createdAt: "2026-10-01T00:00:00Z" });
  store.createArtifactVersion({ artifactId: "artifact:relay", version: 1,
    contentHash: "a".repeat(64), byteLength: 8, mimeType: "text/markdown", storageKey: null,
    approvalStatus: "approved", actorId: agent.agentId, createdAt: "2026-10-01T00:00:00Z" });
  store.updateArtifact("artifact:relay", { currentVersion: 1, approvedVersion: 1 });
  const service = new ContextReadService({ store, now: () => "2026-10-02T00:00:00Z" });
  const catalog = createHostToolCatalog({ contextReadService: service,
    getProjectCodeApplicationService: () => ({}), validateProjectCodeHostRoute: () => ({}) });
  return { directory, store, service, catalog };
}

test("all authenticated Session kinds discover and read another Work without mutating bindings", async () => {
  const f = await fixture();
  try {
    for (const sessionId of ["session:assistant", "session:work", "session:worker"]) {
      const metadata = { sessionId, workId: "work:b", taskId: "task:b" };
      assert.ok(f.catalog.domains({ metadata }).has("context-read"));
      const before = f.store.getSession(sessionId);
      const result = await f.catalog.execute({ tool: "corptie_context_search", metadata,
        arguments: { target_work_id: "work:b", query: "Relay" } });
      assert.equal(result.work.resourceId, "work:b");
      assert.ok(result.items.some((item) => item.resourceId === "task:b"));
      assert.ok(result.items.some((item) => item.resourceId === "artifact:relay"));
      const after = f.store.getSession(sessionId);
      assert.equal(after.workId, before.workId);
      assert.equal(after.taskId, before.taskId);
    }
    const session = await f.catalog.execute({ tool: "corptie_context_read",
      metadata: { sessionId: "session:work" },
      arguments: { target_type: "session", target_id: "session:target", section: "messages" } });
    assert.deepEqual(session.items.map((item) => item.text),
      ["Keep end-to-end identity", "Use TLS relay"]);
    assert.equal(JSON.stringify(session).includes("SECRET_INTERNAL"), false);
    const matched = await f.catalog.execute({ tool: "corptie_context_read",
      metadata: { sessionId: "session:work" },
      arguments: { target_type: "session", target_id: "session:target", section: "messages",
        query: "end-to-end identity" } });
    assert.deepEqual(matched.items.map((item) => item.id), ["msg:2"]);
    assert.equal(f.store.getSession("session:target").archived, true);
    const artifact = await f.catalog.execute({ tool: "corptie_context_read",
      metadata: { sessionId: "session:worker" },
      arguments: { target_type: "artifact", target_id: "artifact:relay" } });
    assert.equal(artifact.item.contentHash, "a".repeat(64));
    const definition = await f.catalog.execute({ tool: "corptie_context_read",
      metadata: { sessionId: "session:assistant" },
      arguments: { target_type: "task", target_id: "task:b", section: "definition" } });
    assert.equal(definition.item.field, "description");
    assert.ok(definition.nextCursor);
    const criterion = await f.catalog.execute({ tool: "corptie_context_read",
      metadata: { sessionId: "session:assistant" },
      arguments: { target_type: "task", target_id: "task:b", section: "definition",
        cursor: definition.nextCursor } });
    assert.equal(criterion.item.field, "acceptanceCriteria");
    assert.equal(criterion.item.text, "Pinned certificate");
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("cursors bind target and revision; revoked artifacts disappear", async () => {
  const f = await fixture();
  try {
    const metadata = { sessionId: "session:work" };
    const page = await f.catalog.execute({ tool: "corptie_context_search", metadata,
      arguments: { target_work_id: "work:b", limit: 1 } });
    assert.ok(page.nextCursor);
    await assert.rejects(() => f.catalog.execute({ tool: "corptie_context_search", metadata,
      arguments: { target_work_id: "work:a", cursor: page.nextCursor } }),
    { code: "CONTEXT_CURSOR_INVALID" });
    f.store.updateArtifact("artifact:relay", { status: "revoked" });
    await assert.rejects(() => f.catalog.execute({ tool: "corptie_context_search", metadata,
      arguments: { target_work_id: "work:b", cursor: page.nextCursor } }),
    { code: "CONTEXT_CURSOR_STALE" });
    await assert.rejects(() => f.catalog.execute({ tool: "corptie_context_read", metadata,
      arguments: { target_type: "artifact", target_id: "artifact:relay" } }),
    { code: "CONTEXT_RESOURCE_REVOKED" });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("persistent message pages can expand a truncated message without exposing tool records", async () => {
  const f = await fixture();
  try {
    const longText = "远程连接".repeat(1000);
    f.store.upsertTimelineItemProjection("session:target", {
      id: "msg:3", turnId: "turn:2", turnStatus: "completed", type: "agentMessage",
      title: "Agent", text: longText, status: "completed", createdAt: "2026-10-01T00:00:03Z"
    });
    const metadata = { sessionId: "session:assistant" };
    const first = await f.catalog.execute({ tool: "corptie_context_read", metadata,
      arguments: { target_type: "session", target_id: "session:target", section: "messages", limit: 1 } });
    assert.equal(first.items[0].id, "msg:3");
    assert.equal(first.items[0].textTruncated, true);
    assert.ok(first.nextCursor);
    const next = await f.catalog.execute({ tool: "corptie_context_read", metadata,
      arguments: { target_type: "session", target_id: "session:target", section: "messages",
        limit: 1, cursor: first.nextCursor } });
    assert.equal(next.items[0].id, "msg:2");
    const part = await f.catalog.execute({ tool: "corptie_context_read", metadata,
      arguments: { target_type: "session", target_id: "session:target", section: "message", item_id: "msg:3" } });
    assert.equal(part.item.text.length, 2000);
    assert.ok(part.nextCursor);
    const rest = await f.catalog.execute({ tool: "corptie_context_read", metadata,
      arguments: { target_type: "session", target_id: "session:target", section: "message",
        item_id: "msg:3", cursor: part.nextCursor } });
    assert.equal(part.item.text + rest.item.text, longText);
    await assert.rejects(() => f.catalog.execute({ tool: "corptie_context_read", metadata,
      arguments: { target_type: "session", target_id: "session:target", section: "message",
        item_id: "tool:1" } }), { code: "CONTEXT_RESOURCE_NOT_FOUND" });
    await assert.rejects(() => f.catalog.execute({ tool: "corptie_context_read", metadata,
      arguments: { target_type: "session", target_id: "session:target", section: "messages",
        item_id: "msg:3", source_work_id: "work:b" } }), { code: "TOOL_ARGUMENT_SCHEMA_INVALID" });
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("shared context-read domain is available through every Provider Tool Host delivery surface", async () => {
  const f = await fixture();
  try {
    for (const capabilities of [
      { appendInPlace: true, capabilityRevision: "native:1" },
      { generatedMcpRefresh: true, capabilityRevision: "mcp:1" },
      { restrictedGateway: true, capabilityRevision: "gateway:1" }
    ]) {
      const plan = buildToolExposurePlan({ catalog: f.catalog,
        context: { metadata: { sessionId: "session:work" } },
        desiredDomains: ["context-read"], capabilities, phase: "refresh" });
      assert.ok(plan.ownership.corptie_context_search);
      assert.ok(plan.ownership.corptie_context_read);
    }
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("large Work results stay page-bounded and continue without loading the whole Work", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 35; index += 1) {
      f.store.createTask({ id: `task:bulk-${index}`, workId: "work:b",
        title: `Forwarding ${index}`, description: "传输".repeat(500) });
    }
    const metadata = { sessionId: "session:assistant" };
    const first = await f.catalog.execute({ tool: "corptie_context_search", metadata,
      arguments: { target_work_id: "work:b", resource_types: ["task"], limit: 10 } });
    assert.equal(first.items.length, 10);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 24_000);
    assert.ok(first.nextCursor);
    const second = await f.catalog.execute({ tool: "corptie_context_search", metadata,
      arguments: { target_work_id: "work:b", resource_types: ["task"], limit: 10,
        cursor: first.nextCursor } });
    assert.equal(second.items.length, 10);
    assert.notEqual(second.items[0].resourceId, first.items[0].resourceId);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});
