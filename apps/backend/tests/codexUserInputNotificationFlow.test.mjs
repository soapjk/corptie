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

test("Codex native questions reach one shared timeline item and accept one secret-safe device reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-codex-input-flow-"));
  const dbPath = join(directory, "db.sqlite");
  const configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath });
  try {
    await store.initialize();
    store.upsertSession({ id: "session:one", title: "Input", agent: "Agent",
      provider: "codex-app-server", status: "running" });
    const binding = { sessionId: "session:one", bindingId: "binding:one", providerId: "codex-app-server",
      providerSessionId: "thread:one", logicalSessionId: "logical:one", routingVersion: 1,
      isCurrentRoute: true };
    const projector = new ProviderEventProjector({ store });
    const ingestion = new ProviderEventIngestionService({ store, resolveBinding: () => binding,
      project: ({ event }) => projector.project({ event, binding }) });
    const accepted = [];
    const client = new CodexAppServerClient({ onNotification: (message) => {
      const envelope = mapCodexProviderNotification({ message, binding,
        liveItems: client.liveItemsForThread("thread:one"), receivedAt: new Date().toISOString() });
      if (envelope) accepted.push(ingestion.ingest(envelope));
    } });
    client.respondToServerRequest = async () => ({ ok: true });
    client.handleLine(JSON.stringify({ method: "turn/started", params: {
      threadId: "thread:one", turn: { id: "turn:one", status: "inProgress" }
    } }));
    client.handleServerRequest({ id: "request:one", method: "item/tool/requestUserInput", params: {
      threadId: "thread:one", turnId: "turn:one", itemId: "native:item:one",
      isBlocking: true, questions: [
        { id: "route", header: "Route", question: "Which route?", isOther: false,
          isSecret: false, options: [{ label: "A", description: "Fast" }] },
        { id: "token", header: "Token", question: "Enter token", isOther: false,
          isSecret: true, options: null }
      ]
    } });
    const item = store.getItems("session:one").find((candidate) => candidate.type === "userInput");
    assert.ok(item);
    assert.equal(item.status, "pending");
    assert.equal(store.getSession("session:one").status, "blocked");
    const api = new ClientSessionAPI({ store,
      readWindow: async (sessionId) => ({ revision: store.sessionTimelineRevision(sessionId),
        hasEarlier: false, items: store.getItems(sessionId) }),
      respondToUserInput: async (_sessionId, input) => client.respondToUserInput("thread:one", input) });
    const identity = { deviceId: "device:one", permissions: ["messages.read", "messages.write"] };
    const page = await api.messages(identity, "session:one", new URLSearchParams());
    const publicItem = page.items.find((candidate) => candidate.id === item.id);
    assert.equal(publicItem.userInput.questions.length, 2);
    assert.equal(publicItem.userInput.questions[1].isSecret, true);
    assert.equal(Object.hasOwn(publicItem, "rawMetadataJSON"), false);
    const response = await api.userInput(identity, "session:one", {
      itemId: item.id, answers: { route: ["A"], token: ["secret-value"] }
    });
    assert.equal(response.status, "submitted");
    assert.equal(store.getSessionItem("session:one", item.id).status, "submitted");
    client.handleLine(JSON.stringify({ method: "serverRequest/resolved", params: {
      threadId: "thread:one", requestId: "request:one"
    } }));
    assert.equal(store.getSession("session:one").status, "running");
    client.handleLine(JSON.stringify({ method: "turn/completed", params: {
      threadId: "thread:one", turn: { id: "turn:one", status: "completed" }
    } }));
    assert.equal(store.getSessionItem("session:one", item.id).turnStatus, "completed");
    assert.equal(store.getItems("session:one").filter((candidate) => candidate.id === item.id).length, 1);
    assert.equal(accepted.every((result) => result.status === "applied"), true);
    assert.equal(JSON.stringify(store.listSessionEvents("session:one")).includes("secret-value"), false);
    assert.equal(JSON.stringify(store.getSessionItem("session:one", item.id)).includes("secret-value"), false);
    await store.close();
    const restored = new CorptieStore({ dbPath, configPath });
    try {
      await restored.initialize();
      assert.equal(restored.getSessionItem("session:one", item.id).status, "submitted");
      assert.equal(restored.getSessionItem("session:one", item.id).turnStatus, "completed");
    } finally { await restored.close(); }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
