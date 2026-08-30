import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import test from "node:test";
import { ArtifactService } from "../src/application/artifactService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("same Agent parallel Workers authorize only exact Session/WorkItem bindings and ignore recency", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-parallel-worker-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  try {
    await store.initialize();
    const agent = store.createAgent({ name: "Shared Worker", provider: "codex-app-server" });
    store.createObjective({ id: "objective:parallel", name: "Parallel", contributorAgentIds: [agent.agentId] });
    for (const suffix of ["a", "b"]) {
      store.createWorkItem({
        id: `work_item:${suffix}`, objectiveId: "objective:parallel",
        title: `Work ${suffix}`, mainAgentId: agent.agentId
      });
      store.upsertSession({
        id: `session:${suffix}`, title: `Session ${suffix}`, provider: "codex-app-server",
        status: "running", sessionKind: "worker", agentId: agent.agentId,
        objectiveId: "objective:parallel", workItemId: `work_item:${suffix}`
      });
      store.bindSessionToWorkItem(`session:${suffix}`, `work_item:${suffix}`, "objective:parallel");
    }
    const service = new ArtifactService({ store, contentRoot: join(directory, "artifacts") });
    await service.initialize();
    const context = (suffix) => ({
      actorId: agent.agentId, sessionId: `session:${suffix}`,
      objectiveId: "objective:parallel", workItemId: `work_item:${suffix}`
    });
    const artifactA = await service.create(context("a"), {
      title: "A only", content: "a", idempotencyKey: "artifact-a"
    });
    const artifactB = await service.create(context("b"), {
      title: "B only", content: "b", idempotencyKey: "artifact-b"
    });
    store.updateAgent(agent.agentId, { currentSessionId: "session:a" });
    assert.equal((await service.get(context("a"), artifactA.artifactId)).content, "a");
    assert.equal((await service.get(context("b"), artifactB.artifactId)).content, "b");
    await assert.rejects(() => service.get(context("a"), artifactB.artifactId), { code: "ARTIFACT_READ_FORBIDDEN" });
    await assert.rejects(() => service.get(context("b"), artifactA.artifactId), { code: "ARTIFACT_READ_FORBIDDEN" });
    store.updateAgent(agent.agentId, { currentSessionId: "session:b" });
    assert.equal((await service.get(context("a"), artifactA.artifactId)).content, "a");
    assert.equal((await service.get(context("b"), artifactB.artifactId)).content, "b");
    store.db.run("UPDATE work_items SET current_session_id = NULL WHERE id = ?", ["work_item:a"]);
    await assert.rejects(() => service.get(context("a"), artifactA.artifactId), {
      code: "ARTIFACT_WORK_ITEM_FORBIDDEN"
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
