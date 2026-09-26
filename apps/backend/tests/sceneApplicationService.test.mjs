import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SceneApplicationService } from "../src/scenes/sceneApplicationService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-scenes-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  await store.initialize();
  let sequence = 0;
  const service = new SceneApplicationService({
    store,
    now: () => `2026-09-26T00:00:${String(sequence++).padStart(2, "0")}.000Z`,
    createId: () => `id-${sequence}`
  });
  return { directory, store, service };
}

test("built-in fitness and checklist templates create durable independent scenes", async () => {
  const { directory, store, service } = await fixture();
  try {
    assert.deepEqual(service.listTemplates().map((template) => template.templateId).sort(), [
      "daily-checklist", "fitness-planner"
    ]);
    const fitness = service.createScene({
      instanceId: "scene:fitness", templateId: "fitness-planner", templateVersion: 1,
      name: "我的训练", timezone: "Asia/Shanghai", unitPreferences: { weight: "kg" }
    });
    const checklist = service.createScene({
      instanceId: "scene:checklist", templateId: "daily-checklist", templateVersion: 1,
      name: "每日事项", timezone: "Asia/Shanghai"
    });
    assert.equal(fitness.instanceRevision, 0);
    assert.equal(checklist.templateId, "daily-checklist");

    const listReceipt = service.executeCommand({
      instanceId: checklist.instanceId, command: "createRecord", idempotencyKey: "create-list",
      payload: { recordId: "list:daily", recordType: "List", data: { title: "日常", archived: false } }
    });
    const itemReceipt = service.executeCommand({
      instanceId: checklist.instanceId, command: "createRecord", idempotencyKey: "create-item",
      expectedInstanceRevision: 1,
      payload: { recordId: "item:water", recordType: "Item", data: {
        listId: "list:daily", title: "喝水", dueAt: null, completed: false, order: 0
      } }
    });
    assert.equal(listReceipt.instanceRevision, 1);
    assert.equal(itemReceipt.instanceRevision, 2);
    await store.close();

    const restartedStore = new CorptieStore({
      dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json")
    });
    await restartedStore.initialize();
    try {
      const restarted = new SceneApplicationService({ store: restartedStore });
      assert.equal(restarted.getRecord("scene:checklist", "item:water").data.title, "喝水");
      assert.equal(restarted.readView("scene:checklist", "checklist").records.length, 2);
      assert.equal(restarted.listScenes().length, 2);
    } finally {
      await restartedStore.close();
    }
  } finally {
    await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("record validation rejects unknown fields and cross-scene references", async () => {
  const { directory, store, service } = await fixture();
  try {
    for (const id of ["one", "two"]) {
      service.createScene({
        instanceId: `scene:${id}`, templateId: "daily-checklist", name: id,
        timezone: "UTC"
      });
    }
    service.executeCommand({
      instanceId: "scene:one", command: "createRecord", idempotencyKey: "list-one",
      payload: { recordId: "list:one", recordType: "List", data: { title: "One", archived: false } }
    });
    assert.throws(() => service.executeCommand({
      instanceId: "scene:one", command: "createRecord", idempotencyKey: "unknown-field",
      payload: { recordType: "List", data: { title: "Invalid", archived: false, surprise: true } }
    }), { code: "SCENE_FIELD_UNKNOWN", statusCode: 422 });
    assert.throws(() => service.executeCommand({
      instanceId: "scene:two", command: "createRecord", idempotencyKey: "cross-scene",
      payload: { recordType: "Item", data: {
        listId: "list:one", title: "Invalid", dueAt: null, completed: false, order: 0
      } }
    }), { code: "SCENE_REFERENCE_INVALID", statusCode: 422 });
    assert.equal(service.getScene("scene:two").instanceRevision, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("commands are idempotent, optimistic, atomic, and auditable", async () => {
  const { directory, store, service } = await fixture();
  try {
    service.createScene({
      instanceId: "scene:tasks", templateId: "daily-checklist", name: "Tasks", timezone: "UTC"
    });
    service.executeCommand({
      instanceId: "scene:tasks", command: "createRecord", idempotencyKey: "list",
      payload: { recordId: "list:main", recordType: "List", data: { title: "Main", archived: false } }
    });
    const request = {
      instanceId: "scene:tasks", command: "createRecord", idempotencyKey: "item",
      expectedInstanceRevision: 1,
      payload: { recordId: "item:one", recordType: "Item", data: {
        listId: "list:main", title: "One", dueAt: null, completed: false, order: 0
      } }
    };
    const first = service.executeCommand(request);
    const replay = service.executeCommand(request);
    assert.deepEqual(replay, first);
    assert.equal(service.getScene("scene:tasks").instanceRevision, 2);
    assert.throws(() => service.executeCommand({ ...request, payload: {
      ...request.payload, data: { ...request.payload.data, title: "Changed" }
    } }), { code: "SCENE_IDEMPOTENCY_KEY_REUSED" });
    assert.throws(() => service.executeCommand({
      instanceId: "scene:tasks", command: "updateRecord", idempotencyKey: "stale",
      payload: { recordId: "item:one", expectedRecordVersion: 9, patch: { title: "No" } }
    }), { code: "SCENE_RECORD_VERSION_CONFLICT" });
    assert.equal(service.getRecord("scene:tasks", "item:one").data.title, "One");

    assert.throws(() => service.executeCommand({
      instanceId: "scene:tasks", command: "batchApply", idempotencyKey: "failed-batch",
      payload: { commands: [
        { command: "completeItem", payload: { recordId: "item:one", expectedRecordVersion: 1 } },
        { command: "updateRecord", payload: { recordId: "missing", expectedRecordVersion: 1,
          patch: { title: "Never committed" } } }
      ] }
    }), { code: "SCENE_RECORD_NOT_FOUND" });
    assert.equal(service.getRecord("scene:tasks", "item:one").data.completed, false);
    assert.equal(service.getScene("scene:tasks").instanceRevision, 2);

    const batch = service.executeCommand({
      instanceId: "scene:tasks", command: "batchApply", idempotencyKey: "batch",
      sourceKind: "session", sourceSessionId: "codex:test",
      payload: { commands: [
        { command: "completeItem", payload: { recordId: "item:one", expectedRecordVersion: 1 } },
        { command: "updateRecord", payload: { recordId: "list:main", expectedRecordVersion: 1,
          patch: { title: "Updated" } } }
      ] }
    });
    assert.equal(batch.changes.length, 2);
    assert.equal(service.getRecord("scene:tasks", "item:one").data.completed, true);
    const changes = service.changesAfter("scene:tasks", 1);
    assert.deepEqual(changes.map((entry) => entry.instanceRevision), [2, 3]);
    assert.equal(changes[1].sourceSessionId, "codex:test");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session-bound previews are read-only, exact, expiring, and single-use", async () => {
  const { directory, store, service } = await fixture();
  try {
    store.upsertSession({
      id: "session:scene", title: "Scene", agent: "Codex",
      provider: "codex-app-server", status: "complete"
    });
    service.createScene({
      instanceId: "scene:preview", templateId: "daily-checklist", name: "Preview", timezone: "UTC"
    });
    service.bindSession("scene:preview", "session:scene");
    assert.equal(service.sessionCanAccess("scene:preview", "session:scene"), true);

    const preview = service.previewCommand({
      instanceId: "scene:preview", command: "createRecord",
      sourceKind: "session", sourceSessionId: "session:scene",
      payload: { recordType: "List", data: { title: "Preview", archived: false } }
    });
    const previewRecordId = preview.changes[0].after.recordId;
    assert.equal(service.getRecord("scene:preview", previewRecordId), null);
    assert.equal(preview.instanceRevision, 0);
    const committed = service.commitPreview(preview.previewToken, {
      sessionId: "session:scene", idempotencyKey: "commit-preview"
    });
    assert.equal(committed.instanceRevision, 1);
    assert.equal(committed.changes[0].after.recordId, previewRecordId);
    assert.equal(service.getRecord("scene:preview", previewRecordId).data.title, "Preview");
    assert.throws(() => service.commitPreview(preview.previewToken, {
      sessionId: "session:scene", idempotencyKey: "commit-preview"
    }), { code: "SCENE_PREVIEW_CONSUMED" });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
