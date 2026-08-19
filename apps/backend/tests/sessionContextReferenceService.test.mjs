import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionContextReferenceService } from "../src/application/sessionContextReferenceService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "corptie-context-references-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  store.createSession({ id: "assistant-session", title: "Assistant", sessionKind: "assistantChat", status: "complete" });
  store.createSession({ id: "referenced-session", title: "Research", sessionKind: "assistantChat", status: "complete", summary: "Stored preview" });
  const objective = store.createObjective({ id: "objective-a", name: "Ship context", description: "Build references", idealState: "Every Provider shares reliable context" });
  store.createWorkItem({ id: "work-item-a", objectiveId: objective.id, title: "Implement resolver", description: "Resolve structured context" });
  const agent = store.createAgent({ name: "Researcher", description: "Finds primary sources", role: "independentContributor", capabilities: ["research"] });
  const localPath = join(directory, "reference.md");
  await writeFile(localPath, "# Local reference\nUse the shared Provider contract.");
  const service = new SessionContextReferenceService({
    store,
    fetch: async () => new Response("<html><head><title>Reference Page</title></head><body>Web reference body</body></html>", {
      headers: { "content-type": "text/html" }
    }),
    readSessionDetail: async () => ({ items: [
      { type: "userMessage", text: "What changed?" },
      { type: "agentMessage", text: "The contract changed." }
    ] })
  });
  return { directory, store, service, localPath, agent };
}

test("Assistant Sessions persist and resolve Provider-neutral context references", async () => {
  const value = await fixture();
  try {
    const inputs = [
      { targetType: "localFile", locator: value.localPath },
      { targetType: "webURL", locator: "https://example.com/reference" },
      { targetType: "objective", targetId: "objective-a" },
      { targetType: "workItem", targetId: "work-item-a" },
      { targetType: "agent", targetId: value.agent.agentId },
      { targetType: "session", targetId: "referenced-session" }
    ];
    for (const input of inputs) await value.service.create("assistant-session", input);

    assert.deepEqual(value.service.list("assistant-session").map((reference) => reference.targetType).sort(), [
      "agent", "localFile", "objective", "session", "webURL", "workItem"
    ]);
    const resolved = await value.service.resolve("assistant-session", { characterBudget: 20_000 });
    assert.match(resolved.prompt, /Local reference/);
    assert.match(resolved.prompt, /Web reference body/);
    assert.match(resolved.prompt, /Objective: Ship context/);
    assert.match(resolved.prompt, /Ideal state: Every Provider shares reliable context/);
    assert.match(resolved.prompt, /WorkItem: Implement resolver/);
    assert.match(resolved.prompt, /Agent: Researcher/);
    assert.match(resolved.prompt, /The contract changed/);
    assert.equal(resolved.documents.length, 6);
    assert.equal(resolved.truncated, false);
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("context references reject non-Assistant owners, self references, and duplicates", async () => {
  const value = await fixture();
  try {
    value.store.createSession({ id: "worker", title: "Worker", sessionKind: "worker", status: "complete", workItemId: "work-item-a" });
    await assert.rejects(
      value.service.create("worker", { targetType: "objective", targetId: "objective-a" }),
      { code: "CONTEXT_REFERENCES_REQUIRE_ASSISTANT" }
    );
    await assert.rejects(
      value.service.create("assistant-session", { targetType: "session", targetId: "assistant-session" }),
      { code: "CONTEXT_REFERENCE_CYCLE" }
    );
    await value.service.create("assistant-session", { targetType: "objective", targetId: "objective-a" });
    await assert.rejects(
      value.service.create("assistant-session", { targetType: "objective", targetId: "objective-a" }),
      { code: "CONTEXT_REFERENCE_DUPLICATE" }
    );
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("context resolution obeys a total budget and disabled references are omitted", async () => {
  const value = await fixture();
  try {
    const first = await value.service.create("assistant-session", { targetType: "localFile", locator: value.localPath });
    const second = await value.service.create("assistant-session", { targetType: "objective", targetId: "objective-a" });
    value.service.update("assistant-session", second.referenceId, { enabled: false });
    const resolved = await value.service.resolve("assistant-session", { characterBudget: 180 });
    assert.equal(resolved.documents.some((document) => document.referenceId === second.referenceId), false);
    assert.equal(resolved.documents.some((document) => document.referenceId === first.referenceId), true);
    assert.equal(resolved.characters <= 180, true);
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
