import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionContextReferenceService } from "../src/application/sessionContextReferenceService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture(onChanged) {
  const directory = await mkdtemp(join(tmpdir(), "corptie-context-references-"));
  const store = new CorptieStore({ dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  store.createSession({ id: "assistant-session", title: "Assistant", sessionKind: "assistantChat", status: "complete" });
  store.createSession({ id: "referenced-session", title: "Research", sessionKind: "assistantChat", status: "complete", summary: "Stored preview" });
  const agent = store.createAgent({ name: "Researcher", description: "Finds primary sources", role: "independentContributor", capabilities: ["research"] });
  const work = store.createWork({
    id: "work-a", name: "Ship context", description: "Build references",
    contributorAgentIds: [agent.agentId]
  });
  store.createTask({ id: "task-a", workId: work.id, title: "Implement resolver", description: "Resolve structured context" });
  const localPath = join(directory, "reference.md");
  await writeFile(localPath, "# Local reference\nUse the shared Provider contract.");
  const service = new SessionContextReferenceService({
    store,
    onChanged,
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

test("binary references recover without reading content, preserve escaped paths and can be replaced", async () => {
  const value = await fixture();
  try {
    const path = join(value.directory, '中文 "报告"\n.docx');
    await writeFile(path, Buffer.from([80, 75, 0, 255]));
    const created = await value.service.create("assistant-session", { targetType: "localFile", locator: path });
    value.store.updateSessionContextReference(created.referenceId, {
      status: "unavailable", contentHash: "legacy-hash", snapshotText: "legacy body",
      metadata: { lastError: "Binary files are not supported as context yet." }
    });
    const refreshed = await value.service.refresh("assistant-session", created.referenceId);
    assert.equal(refreshed.status, "available");
    assert.equal(refreshed.metadata.contentRead, false);
    assert.equal(refreshed.metadata.lastError, undefined);
    assert.equal(refreshed.contentHash, null);
    const resolved = await value.service.resolve("assistant-session");
    assert.equal(resolved.atomic, true);
    assert.ok(resolved.prompt.includes(JSON.stringify(path)));
    assert.match(resolved.prompt, /grants no additional permissions/);
    assert.doesNotMatch(resolved.prompt, /legacy body/);
    const replaced = await value.service.update("assistant-session", created.referenceId, { locator: value.localPath });
    assert.equal(replaced.referenceId, created.referenceId);
    assert.equal(replaced.locator, value.localPath);
    assert.equal(replaced.targetKey, value.localPath);
    await assert.rejects(value.service.update("assistant-session", created.referenceId, { locator: "relative.docx" }),
      { code: "INVALID_FILE_REFERENCE" });
    await rm(value.localPath);
    const missing = await value.service.resolve("assistant-session");
    assert.equal(missing.documents[0].status, "missing");
    assert.ok(missing.prompt.includes(JSON.stringify(value.localPath)));
    assert.equal(value.service.list("assistant-session")[0].status, "missing");
    value.service.stat = async () => { throw Object.assign(new Error("Permission denied"), { code: "EACCES" }); };
    assert.equal((await value.service.refresh("assistant-session", created.referenceId)).status, "unavailable");
    assert.match((await value.service.resolve("assistant-session")).prompt, /Permission denied/);
    await value.service.update("assistant-session", created.referenceId, { enabled: false });
    value.service.stat = () => { throw new Error("Disabled files must not be checked"); };
    assert.equal((await value.service.resolve("assistant-session")).prompt, "");
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Assistant Sessions persist and resolve Provider-neutral context references", async () => {
  const value = await fixture();
  try {
    const inputs = [
      { targetType: "localFile", locator: value.localPath },
      { targetType: "webURL", locator: "https://example.com/reference" },
      { targetType: "work", targetId: "work-a" },
      { targetType: "task", targetId: "task-a" },
      { targetType: "agent", targetId: value.agent.agentId },
      { targetType: "session", targetId: "referenced-session" }
    ];
    for (const input of inputs) await value.service.create("assistant-session", input);

    assert.deepEqual(value.service.list("assistant-session").map((reference) => reference.targetType).sort(), [
      "agent", "localFile", "session", "task", "webURL", "work"
    ]);
    const resolved = await value.service.resolve("assistant-session", { characterBudget: 20_000 });
    assert.ok(resolved.prompt.includes(JSON.stringify(value.localPath)));
    assert.doesNotMatch(resolved.prompt, /Use the shared Provider contract/);
    assert.match(resolved.prompt, /Web reference body/);
    assert.match(resolved.prompt, /Work: Ship context/);
    assert.match(resolved.prompt, /Build references/);
    assert.match(resolved.prompt, /Task: Implement resolver/);
    assert.match(resolved.prompt, /Agent: Researcher/);
    assert.match(resolved.prompt, /The contract changed/);
    assert.equal(resolved.documents.length, 6);
    assert.equal(resolved.truncated, false);
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("successful reference writes invalidate only their owner; rejected writes and reads do not", async () => {
  const changes = [], value = await fixture(change => changes.push(change));
  try {
    const created = await value.service.create("assistant-session", { targetType: "webURL", locator: "https://example.com/reference" });
    value.service.list("assistant-session");
    await assert.rejects(value.service.create("assistant-session", { targetType: "webURL", locator: "https://example.com/reference" }), { code: "CONTEXT_REFERENCE_DUPLICATE" });
    assert.equal(changes.length, 1);
    value.service.update("assistant-session", created.referenceId, { enabled: false });
    await value.service.refresh("assistant-session", created.referenceId);
    value.service.delete("assistant-session", created.referenceId);
    assert.deepEqual(changes, Array.from({ length: 4 }, () => ({ resourceType: "reference", sessionId: "assistant-session" })));
  } finally { await value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("Task Worker Sessions can manage and resolve references; self references and duplicates still fail", async () => {
  const value = await fixture();
  try {
    value.store.createSession({
      id: "worker", title: "Worker", sessionKind: "worker", status: "complete",
      workId: "work-a", taskId: "task-a"
    });
    const created = await value.service.create("worker", { targetType: "work", targetId: "work-a" });
    assert.equal(value.service.list("worker").length, 1);
    assert.match((await value.service.resolve("worker")).prompt, /Work: Ship context/);
    await value.service.update("worker", created.referenceId, { enabled: false });
    assert.equal((await value.service.resolve("worker")).prompt, "");
    value.service.delete("worker", created.referenceId);
    assert.deepEqual(value.service.list("worker"), []);
    await assert.rejects(
      value.service.create("assistant-session", { targetType: "session", targetId: "assistant-session" }),
      { code: "CONTEXT_REFERENCE_CYCLE" }
    );
    await value.service.create("assistant-session", { targetType: "work", targetId: "work-a" });
    await assert.rejects(
      value.service.create("assistant-session", { targetType: "work", targetId: "work-a" }),
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
    const second = await value.service.create("assistant-session", { targetType: "work", targetId: "work-a" });
    await value.service.update("assistant-session", second.referenceId, { enabled: false });
    const resolved = await value.service.resolve("assistant-session", { characterBudget: 2048 });
    assert.equal(resolved.documents.some((document) => document.referenceId === second.referenceId), false);
    assert.equal(resolved.documents.some((document) => document.referenceId === first.referenceId), true);
    assert.equal(resolved.characters <= 2048, true);
    await assert.rejects(value.service.resolve("assistant-session", { characterBudget: 180 }),
      { code: "CONTEXT_REFERENCE_BUDGET_EXCEEDED" });
  } finally {
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("web snapshots stop native streaming reads at bounds and preserve split Unicode", async t => {
  const value = await fixture();
  t.after(async () => { await value.store.close(); await rm(value.directory, { recursive: true, force: true }); });
  let cancelled = false;
  value.service.maxSourceCharacters = 3;
  value.service.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([0xF0, 0x9F])); controller.enqueue(new Uint8Array([0x98, 0x80, 0x41])); },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/plain" } });
  const split = await value.service.fetchWebSnapshot("https://fixture.invalid/split");
  assert.equal(split.snapshotText, "😀A"); assert.equal(split.metadata.sourceCharacters, 3); assert.equal(cancelled, true);
  value.service.maxSourceCharacters = 3;
  value.service.fetch = async () => new Response("😀😀😀", { headers: { "content-type": "text/plain" } });
  const clipped = await value.service.fetchWebSnapshot("https://fixture.invalid/clip");
  assert.equal(clipped.snapshotText, "😀"); assert.equal(clipped.snapshotText.length, 2);
});

test("web snapshot timeout covers fetch and body without inserting a reference", async t => {
  const value = await fixture();
  t.after(async () => { await value.store.close(); await rm(value.directory, { recursive: true, force: true }); });
  value.service.webFetchTimeoutMilliseconds = 10;
  for (const body of [false, true]) {
    let signal, cancelled = false;
    value.service.fetch = async (_url, options) => {
      signal = options.signal;
      if (!body) return new Promise(() => {}); // Injected fetch ignores abort; deadline must still settle.
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/plain" } });
    };
    await assert.rejects(value.service.create("assistant-session", { targetType: "webURL", locator: "https://fixture.invalid/timeout" }), { code: "WEB_FETCH_TIMEOUT" });
    assert.equal(signal.aborted, true); assert.equal(value.service.list("assistant-session").length, 0);
    if (body) assert.equal(cancelled, true);
  }
});

test("web snapshot HTTP failure releases the body and constructor rejects unbounded options", async t => {
  const value = await fixture();
  t.after(async () => { await value.store.close(); await rm(value.directory, { recursive: true, force: true }); });
  let cancelled = false;
  value.service.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
  await assert.rejects(value.service.fetchWebSnapshot("https://fixture.invalid/failure"), { code: "WEB_FETCH_FAILED" });
  assert.equal(cancelled, true);
  for (const options of [{ maxSourceCharacters: Infinity }, { maxSourceCharacters: 0 }, { webFetchTimeoutMilliseconds: 0 }, { webFetchTimeoutMilliseconds: 60_001 }]) {
    assert.throws(() => new SessionContextReferenceService({ store: value.store, ...options }), TypeError);
  }
});
