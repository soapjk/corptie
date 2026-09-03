import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import test from "node:test";
import { ArtifactService } from "../src/application/artifactService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("same Agent parallel Workers authorize only exact Session/Task bindings and ignore recency", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-parallel-worker-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  try {
    await store.initialize();
    const agent = store.createAgent({ name: "Shared Worker", provider: "codex-app-server" });
    store.createWork({ id: "work:parallel", name: "Parallel", contributorAgentIds: [agent.agentId] });
    for (const suffix of ["a", "b"]) {
      store.createTask({
        id: `task:${suffix}`, workId: "work:parallel",
        title: `Work ${suffix}`, mainAgentId: agent.agentId
      });
      store.upsertSession({
        id: `session:${suffix}`, title: `Session ${suffix}`, provider: "codex-app-server",
        status: "running", sessionKind: "worker", agentId: agent.agentId,
        workId: "work:parallel", taskId: `task:${suffix}`
      });
      store.bindSessionToTask(`session:${suffix}`, `task:${suffix}`, "work:parallel");
    }
    const service = new ArtifactService({ store, contentRoot: join(directory, "artifacts") });
    await service.initialize();
    const context = (suffix) => ({
      actorId: agent.agentId, sessionId: `session:${suffix}`,
      workId: "work:parallel", taskId: `task:${suffix}`
    });
    const artifactA = await service.create(context("a"), {
      title: "A only", content: "a", idempotencyKey: "artifact-a"
    });
    const artifactB = await service.create(context("b"), {
      title: "B only", content: "b", idempotencyKey: "artifact-b"
    });
    let turn = 0;
    const pinned = (artifact) => ({
      version: 1,
      contentHash: artifact.versions[0].contentHash,
      referenceId: artifact.references[0].referenceId,
      turnExecutionId: `turn:parallel:${++turn}`
    });
    store.updateAgent(agent.agentId, { currentSessionId: "session:a" });
    assert.equal((await service.get(context("a"), artifactA.artifactId, pinned(artifactA))).content, "a");
    assert.equal((await service.get(context("b"), artifactB.artifactId, pinned(artifactB))).content, "b");
    await assert.rejects(() => service.get(context("a"), artifactB.artifactId, pinned(artifactB)), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
    await assert.rejects(() => service.get(context("b"), artifactA.artifactId, pinned(artifactA)), { code: "ARTIFACT_NOT_FOUND_OR_FORBIDDEN" });
    store.updateAgent(agent.agentId, { currentSessionId: "session:b" });
    assert.equal((await service.get(context("a"), artifactA.artifactId, pinned(artifactA))).content, "a");
    assert.equal((await service.get(context("b"), artifactB.artifactId, pinned(artifactB))).content, "b");
    store.db.run("UPDATE tasks SET current_session_id = NULL WHERE id = ?", ["task:a"]);
    await assert.rejects(() => service.get(context("a"), artifactA.artifactId, pinned(artifactA)), {
      code: "ARTIFACT_SESSION_BINDING_INVALID"
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
