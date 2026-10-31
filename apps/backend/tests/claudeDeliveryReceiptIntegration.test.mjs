import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClaudeAgentManager } from "../src/adapters/claudeAgentManager.mjs";
import { createClaudeAgentSdkProvider } from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { SessionApplicationService } from "../src/agent-provider/sessionApplicationService.mjs";
import { createSessionMessageOperation } from "../src/application/sessionMessageOperation.mjs";
import { ProviderEventProjector } from "../src/application/providerEventProjector.mjs";
import { mapClaudeProviderEvent, mapClaudeTurnSettled } from "../src/application/providerEventEnvelope.mjs";

for (const ordering of ["events-first", "receipt-first", "terminal-before-receipt"]) {
  test(`actual Claude send receipt keeps Delivery correlation: ${ordering}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "corptie-claude-receipt-"));
    const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
    await store.initialize();
    try {
      store.createAgent({ id: "agent", name: "Agent" });
      store.upsertSession({ id: "session", title: "Receipt", agentId: "agent", agent: "Agent",
        provider: "claude-sdk", status: "complete" });
      const binding = { sessionId: "session", logicalSessionId: "logical", bindingId: "binding",
        providerId: "claude-sdk", providerSessionId: "native", routingVersion: 2, isCurrentRoute: true };
      const reference = { ...binding, metadata: { session: store.getSession("session") } };
      const admitted = store.createUserMessageDelivery({ deliveryId: "delivery", messageId: "message", sessionId: "session",
        binding, agentId: "agent", text: "sent once" });
      const projector = new ProviderEventProjector({ store });
      const events = [];
      const project = event => projector.project({ binding, event });
      const receive = event => {
        if (ordering === "receipt-first") events.push(event);
        else project(event);
      };
      const manager = new ClaudeAgentManager({
        onProviderEvent: event => receive(mapClaudeProviderEvent({ event, binding, receivedAt: new Date().toISOString() })),
        onTurnSettled: event => receive(mapClaudeTurnSettled({ event, binding, receivedAt: new Date().toISOString() }))
      });
      manager.start({ id: "native" });
      // Stub only the SDK transport; the Manager, adapter, application, operation,
      // event projector and SQLite repository all execute their production paths.
      manager.ensureQueryStarted = async () => {};
      let queued = 0;
      manager.enqueueInput = session => {
        queued++;
        if (ordering === "terminal-before-receipt") {
          manager.handleSdkMessage(session, { type: "result", subtype: "success", is_error: false, result: "Done" });
          // A live session snapshot is not the acknowledgement's Turn identity.
          session.currentTurnId = null;
        }
      };
      const provider = createClaudeAgentSdkProvider(manager);
      const registry = new AgentProviderRegistry([provider]);
      const service = new SessionApplicationService({ registry, resolveSessionReference: () => reference });
      const operation = createSessionMessageOperation({ store, requireSessionReference: () => reference,
        sessionApplicationService: service, agentProviderRegistry: registry,
        sessionBindingReadinessProbe: { verify: async () => ({ ready: true }), invalidateBinding: () => {} },
        now: () => new Date().toISOString(), emitEvent: () => {}, providerTurnResponseWatchdog: { watch: () => {} } });
      const result = await operation.sendUnifiedSessionMessage("session", "sent once", { type: "desktop", deliveryId: "delivery" },
        { fromAgentWorkQueue: true });
      assert.equal(result.result.turnId, "delivery");
      assert.equal(result.result.bindingId, "binding");
      assert.equal(result.result.routingVersion, 2);
      assert.equal(queued, 1);
      assert.equal(store.getMessageDelivery("delivery").providerTurnId, "delivery");
      for (const event of events.splice(0)) project(event);
      if (ordering !== "terminal-before-receipt") {
        manager.handleSdkMessage(manager.get("native"), { type: "result", subtype: "success", is_error: false, result: "Done" });
        await new Promise(resolve => setImmediate(resolve));
        if (ordering === "receipt-first") {
          for (const event of events.splice(0)) project(event);
        }
      }
      const delivery = store.getMessageDelivery("delivery");
      assert.equal(delivery.status, "completed");
      assert.equal(delivery.providerTurnId, "delivery");
      assert.equal(store.getSessionItem("session", "message").status, "completed");
      assert.equal(store.getSessionItem("session", "message").turnId, "delivery");
      assert.equal(store.listUnsettledSessionTurns("session").length, 0);
      store.updateAgentTask(admitted.task.taskId, { status: "completed" });
      assert.equal(store.hasUnsettledSessionRuntimeWork("session"), false);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
