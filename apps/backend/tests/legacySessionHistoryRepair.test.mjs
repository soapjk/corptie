import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mapCodexThreadToLegacyTimelineItems } from "../src/adapters/codexAppServer.mjs";
import {
  LegacySessionHistoryRepairService
} from "../src/application/legacySessionHistoryRepairService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture(provider = "codex-app-server") {
  const directory = await mkdtemp(join(tmpdir(), "corptie-legacy-history-repair-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  const sessionId = `${provider}:legacy`;
  store.upsertSession({
    id: sessionId,
    title: "Legacy history",
    agent: "Agent",
    provider,
    status: "complete",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:01:00.000Z",
    external: {
      provider,
      threadId: "provider-session:legacy",
      sessionId: "provider-session:legacy"
    }
  });
  return { directory, store, sessionId };
}

function reference(sessionId, providerId = "codex-app-server") {
  return {
    sessionId,
    logicalSessionId: "logical:legacy",
    bindingId: "binding:legacy",
    providerId,
    providerSessionId: "provider-session:legacy",
    routingVersion: 1,
    metadata: {}
  };
}

function historyItems() {
  return [
    {
      id: "item:user",
      turnId: "turn:legacy",
      turnStatus: "completed",
      type: "userMessage",
      title: "User",
      text: "hello",
      status: "completed",
      createdAt: "2026-08-20T00:00:01.000Z",
      rawMetadataJSON: JSON.stringify({ provider: "codex-app-server" })
    },
    {
      id: "item:assistant",
      turnId: "turn:legacy",
      turnStatus: "completed",
      type: "agentMessage",
      title: "Codex",
      text: "hi",
      status: "completed",
      presentationRole: "final_answer",
      createdAt: "2026-08-20T00:00:02.000Z",
      rawMetadataJSON: JSON.stringify({ provider: "codex-app-server" })
    }
  ];
}

test("legacy repair imports an empty pre-cutover Timeline once and records rollback keys", async () => {
  const f = await fixture();
  try {
    const service = new LegacySessionHistoryRepairService({
      store: f.store,
      resolveReference: () => reference(f.sessionId),
      importers: new Map([["codex-app-server", async () => ({ items: historyItems() })]]),
      now: () => "2026-08-28T00:00:00.000Z"
    });

    const first = await service.run();
    assert.equal(first.imported, 1);
    assert.equal(first.importedItems, 2);
    assert.deepEqual(f.store.getItems(f.sessionId).map((item) => item.id), [
      "item:user", "item:assistant"
    ]);
    const audit = f.store.getLegacyHistoryRepair(f.sessionId);
    assert.equal(audit.status, "imported");
    assert.equal(audit.imported_item_count, 2);
    assert.equal(audit.attempt_count, 1);
    assert.equal(f.store.selectAll(
      "SELECT item_id FROM legacy_history_repair_items WHERE session_id = ? ORDER BY item_id",
      [f.sessionId]
    ).length, 2);

    const rolledBack = f.store.rollbackLegacyHistoryRepair(f.sessionId, "verification rollback");
    assert.equal(rolledBack.status, "rolled_back");
    assert.equal(rolledBack.failure_code, "LEGACY_HISTORY_REPAIR_ROLLED_BACK");
    assert.deepEqual(f.store.getItems(f.sessionId), []);
    assert.equal(f.store.selectAll(
      "SELECT item_id FROM legacy_history_repair_items WHERE session_id = ?",
      [f.sessionId]
    ).length, 0);

    const second = await service.run();
    assert.equal(second.scanned, 1);
    assert.equal(second.skipped, 1);
    assert.equal(f.store.getLegacyHistoryRepair(f.sessionId).attempt_count, 1);
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("legacy repair never overwrites a Timeline that materializes while Provider history is loading", async () => {
  const f = await fixture();
  try {
    const service = new LegacySessionHistoryRepairService({
      store: f.store,
      resolveReference: () => reference(f.sessionId),
      importers: new Map([["codex-app-server", async () => {
        f.store.upsertTimelineItemProjection(f.sessionId, {
          id: "item:live",
          turnId: "turn:live",
          turnStatus: "completed",
          type: "agentMessage",
          title: "Codex",
          text: "new live answer",
          status: "completed"
        });
        return { items: historyItems() };
      }]])
    });

    const result = await service.run();
    assert.equal(result.imported, 0);
    assert.equal(result.details[0].status, "conflict");
    assert.deepEqual(f.store.getItems(f.sessionId).map((item) => item.id), ["item:live"]);
    assert.equal(f.store.getLegacyHistoryRepair(f.sessionId).failure_code, "TIMELINE_ALREADY_MATERIALIZED");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("unsupported Providers are explicit and unavailable histories retry on a later startup", async () => {
  const unsupported = await fixture("openclacky");
  try {
    const service = new LegacySessionHistoryRepairService({
      store: unsupported.store,
      resolveReference: () => reference(unsupported.sessionId, "openclacky")
    });
    await service.run();
    await service.run();
    const audit = unsupported.store.getLegacyHistoryRepair(unsupported.sessionId);
    assert.equal(audit.status, "unsupported");
    assert.equal(audit.attempt_count, 1);
    assert.equal(audit.failure_code, "LEGACY_HISTORY_IMPORT_UNSUPPORTED");
  } finally {
    await unsupported.store.close();
    await rm(unsupported.directory, { recursive: true, force: true });
  }

  const retry = await fixture();
  try {
    let attempts = 0;
    const service = new LegacySessionHistoryRepairService({
      store: retry.store,
      resolveReference: () => reference(retry.sessionId),
      importers: new Map([["codex-app-server", async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("no rollout found for thread id provider-session:legacy");
        return { items: historyItems() };
      }]])
    });
    const first = await service.run();
    assert.equal(first.unavailable, 1);
    assert.equal(retry.store.getLegacyHistoryRepair(retry.sessionId).status, "unavailable");
    const second = await service.run();
    assert.equal(second.imported, 1);
    assert.equal(retry.store.getLegacyHistoryRepair(retry.sessionId).attempt_count, 2);
  } finally {
    await retry.store.close();
    await rm(retry.directory, { recursive: true, force: true });
  }
});

test("Codex thread-not-loaded errors are audited as unavailable", async () => {
  const f = await fixture();
  try {
    const service = new LegacySessionHistoryRepairService({
      store: f.store,
      resolveReference: () => reference(f.sessionId),
      importers: new Map([["codex-app-server", async () => {
        throw Object.assign(new Error("thread not loaded: provider-session:legacy"), { code: -32600 });
      }]])
    });

    const result = await service.run();

    assert.equal(result.unavailable, 1);
    assert.equal(result.failed, 0);
    assert.equal(f.store.getLegacyHistoryRepair(f.sessionId).status, "unavailable");
  } finally {
    await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("Codex migration mapper preserves message identity, turn order and presentation role", () => {
  const items = mapCodexThreadToLegacyTimelineItems({
    id: "thread:legacy",
    turns: [{
      id: "turn:legacy",
      status: "completed",
      createdAt: "2026-08-20T00:00:00.000Z",
      items: [
        { id: "native:user", type: "userMessage", content: [{ type: "text", text: "hello" }] },
        { id: "native:assistant", type: "agentMessage", text: "hi", phase: "final_answer" }
      ]
    }]
  });
  assert.deepEqual(items.map((item) => ({
    id: item.id,
    turnId: item.turnId,
    type: item.type,
    presentationRole: item.presentationRole,
    text: item.text
  })), [
    { id: "native:user", turnId: "turn:legacy", type: "userMessage", presentationRole: null, text: "hello" },
    { id: "native:assistant", turnId: "turn:legacy", type: "agentMessage", presentationRole: "final_answer", text: "hi" }
  ]);
});
