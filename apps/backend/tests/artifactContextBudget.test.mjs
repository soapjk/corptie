import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import test from "node:test";
import { ArtifactService } from "../src/application/artifactService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture() {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-artifact-budget-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  const agent = store.createAgent({ name: "Budget Worker", provider: "codex-app-server" });
  store.createWork({ id: "work:budget", name: "Budget", contributorAgentIds: [agent.agentId] });
  store.createTask({ id: "task:budget", workId: "work:budget", title: "Budget", mainAgentId: agent.agentId });
  store.upsertSession({
    id: "session:budget", title: "Budget", provider: "codex-app-server", status: "running",
    sessionKind: "worker", agentId: agent.agentId, workId: "work:budget", taskId: "task:budget"
  });
  store.bindSessionToTask("session:budget", "task:budget", "work:budget");
  const service = new ArtifactService({ store, contentRoot: join(directory, "artifacts") });
  await service.initialize();
  const context = {
    actorId: agent.agentId, sessionId: "session:budget", workId: "work:budget",
    taskId: "task:budget", providerBindingId: "binding:budget", turnId: "turn:one"
  };
  return { directory, store, service, context };
}

test("Artifact index honors 80 item, 16KiB/4096-token, and 1024-byte summary budgets", async () => {
  const value = await fixture();
  try {
    for (let index = 0; index < 90; index += 1) {
      await value.service.create(value.context, {
        title: `Artifact ${index}`, summary: "测".repeat(1000), content: `body ${index}`,
        idempotencyKey: `budget:${index}`
      });
    }
    const session = value.store.getSession("session:budget");
    const index = value.service.indexForSession(session);
    const bytes = Buffer.byteLength(JSON.stringify({ artifacts: index.items }));
    assert.ok(index.items.length <= 80);
    assert.ok(bytes <= 16 * 1024);
    assert.ok(Math.ceil(bytes / 4) <= 4096);
    assert.ok(index.items.every((item) => Buffer.byteLength(item.summary) <= 1024));
    assert.equal(index.omittedCount, 90 - index.items.length);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("pinned Worker reads verify hash and enforce per-Turn unique page budget with dedupe", async () => {
  const value = await fixture();
  try {
    const body = "x".repeat(200_000);
    const artifact = await value.service.create(value.context, {
      title: "Paged", content: body, idempotencyKey: "paged"
    });
    const hash = artifact.versions[0].contentHash;
    const options = {
      version: 1, contentHash: hash, referenceId: artifact.references[0].referenceId,
      turnExecutionId: "turn:one", offset: 0, limit: 8192, format: "text"
    };
    assert.equal((await value.service.get(value.context, artifact.artifactId, options)).content.length, 8192);
    assert.equal((await value.service.get(value.context, artifact.artifactId, options)).content.length, 8192);
    await assert.rejects(() => value.service.get(value.context, artifact.artifactId, {
      ...options, contentHash: "0".repeat(64)
    }), { code: "ARTIFACT_VERSION_HASH_MISMATCH" });
    for (let page = 1; page < 16; page += 1) {
      await value.service.get(value.context, artifact.artifactId, { ...options, offset: page * 8192 });
    }
    await assert.rejects(() => value.service.get(value.context, artifact.artifactId, {
      ...options, offset: 16 * 8192
    }), { code: "ARTIFACT_TURN_READ_BUDGET_EXCEEDED" });
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
