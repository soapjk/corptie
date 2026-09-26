import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";
import { mapCodexProviderNotification } from "../src/application/providerEventEnvelope.mjs";
import { ProviderEventIngestionService } from "../src/application/providerEventIngestionService.mjs";
import { ProviderEventProjector } from "../src/application/providerEventProjector.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("Codex A→B→A plan notifications remain three physical events but one timeline item", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-codex-plan-flow-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  try {
    await store.initialize();
    store.upsertSession({ id: "session:one", title: "Plan", agent: "Agent", provider: "codex-app-server", status: "running" });
    const binding = { sessionId: "session:one", bindingId: "binding:one", providerId: "codex-app-server",
      providerSessionId: "thread:one", logicalSessionId: "logical:one", routingVersion: 1, isCurrentRoute: true };
    const projector = new ProviderEventProjector({ store });
    const ingestion = new ProviderEventIngestionService({ store, resolveBinding: () => binding,
      project: ({ event }) => projector.project({ event, binding }) });
    const results = [];
    const client = new CodexAppServerClient({ onNotification: (message) => {
      const event = mapCodexProviderNotification({ message, binding, receivedAt: new Date().toISOString() });
      if (event) results.push(ingestion.ingest(event));
    } });
    const emit = (status) => client.handleLine(JSON.stringify({ method: "turn/plan/updated", params: {
      threadId: "thread:one", turnId: "turn:one", plan: [{ step: "Inspect", status }]
    } }));
    emit("pending"); emit("completed"); emit("pending");
    assert.deepEqual(results.map((result) => result.status), ["applied", "applied", "applied"]);
    assert.equal(new Set(results.map((result) => result.event.providerEventId)).size, 3);
    const plans = store.getItems("session:one").filter((item) => item.type === "executionPlan");
    assert.equal(plans.length, 1);
    assert.equal(plans[0].executionPlan.revision, 3);
    assert.equal(plans[0].executionPlan.steps[0].status, "pending");
    const deviceAPI = new ClientSessionAPI({ store,
      readWindow: async (sessionId) => ({
        revision: store.sessionTimelineRevision(sessionId),
        hasEarlier: false,
        items: store.getItems(sessionId)
      }) });
    const devicePage = await deviceAPI.messages({ deviceId: "device:test" },
      "session:one", new URLSearchParams());
    const devicePlan = devicePage.items.find((item) => item.type === "executionPlan");
    assert.equal(devicePlan.id, plans[0].id);
    assert.deepEqual(devicePlan.executionPlan, plans[0].executionPlan);
    assert.equal(devicePage.items.filter((item) => item.type === "executionPlan").length, 1);
    const tool = (method, aggregatedOutput = null) => client.handleLine(JSON.stringify({
      method,
      params: { threadId: "thread:one", turnId: "turn:one", item: {
        id: "tool:one", type: "commandExecution", command: "pwd",
        ...(aggregatedOutput ? { aggregatedOutput } : {})
      } }
    }));
    tool("item/started");
    assert.equal(store.getSessionItem("session:one", "tool:one").toolExecution.status, "running");
    tool("item/completed", "/tmp/project");
    const command = store.getSessionItem("session:one", "tool:one");
    assert.deepEqual(command.toolExecution, {
      schemaVersion: 1, toolId: "tool:one", name: "commandExecution", status: "completed",
      input: "pwd", result: "/tmp/project"
    });
    assert.equal(JSON.parse(client.liveItemsByThread.get("thread:one").get("tool:one").rawMetadataJSON)
      .toolExecution.status, "completed", "the Adapter cache must agree with the persisted projection");
    assert.equal(store.listSessionEvents("session:one").length, 5);
    client.handleLine(JSON.stringify({ method: "item/completed", params: {
      threadId: "thread:one", turnId: "turn:one", item: {
        id: "files:one", type: "fileChange", changes: [
          { path: "Sources/App.swift", kind: { type: "update" }, diff: "+ changed" }
        ]
      }
    } }));
    assert.deepEqual(store.getSessionItem("session:one", "files:one").changeSet.changes, [
      { path: "Sources/App.swift", kind: "modify", diffPreview: "+ changed", diffTruncated: false }
    ]);
    await store.close();
    const restored = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
    try {
      await restored.initialize();
      const afterRestart = restored.getSessionItem("session:one", plans[0].id);
      assert.equal(afterRestart.executionPlan.revision, 3);
      assert.equal(afterRestart.executionPlan.steps[0].status, "pending");
    } finally {
      await restored.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
