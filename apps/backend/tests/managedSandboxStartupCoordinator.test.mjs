import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ManagedSandboxStartupCoordinator } from "../src/application/managedSandboxStartupCoordinator.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("managed Sandbox starts a non-Git Task in an isolated copy and persists its ExecutionSpace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-managed-sandbox-"));
  const source = join(directory, "source");
  const dataRoot = join(directory, "data");
  const store = new CorptieStore({
    dbPath: join(dataRoot, "db.sqlite"), configPath: join(dataRoot, "config.json")
  });
  try {
    await store.initialize();
    await import("node:fs/promises").then(({ mkdir }) => mkdir(source, { recursive: true }));
    await writeFile(join(source, "brief.md"), "original");
    const workService = new WorkApplicationService({ store });
    const agent = store.createAgent({ id: "agent:worker", name: "Worker", role: "independentContributor" });
    store.createWorkspace({ workspaceId: "workspace:plain", kind: "linkedLocal", ownership: "userManaged", rootPath: source });
    const work = workService.createWork({
      id: "work:plain", name: "Plain", workspaceId: "workspace:plain",
      contributorAgentIds: [agent.agentId]
    });
    const task = workService.createTask({
      id: "task:plain", workId: work.id, title: "Write docs", mainAgentId: agent.agentId
    });
    let createdCwd = null;
    const providerWorkSessionPort = {
      async createSession(input) {
        createdCwd = input.workspace.canonicalWorktreePath;
        store.createSession({
          id: "codex:sandbox", title: "Write docs", provider: "codex-app-server",
          agentId: agent.agentId, sessionKind: "worker", workId: work.id,
          taskId: task.id, cwd: createdCwd, external: {
            provider: "codex-app-server", threadId: "sandbox-thread", cwd: createdCwd
          }, deferTaskProjection: true
        });
        store.createLogicalSessionRoute({
          logicalSessionId: "logical:sandbox", legacySessionId: "codex:sandbox",
          providerThreadId: "sandbox-thread", providerSessionId: "sandbox-thread",
          providerId: "codex-app-server", boundCwd: createdCwd, sessionName: "Write docs"
        });
        return store.getSession("codex:sandbox");
      },
      async activateSession() {
        return {
          providerResourceId: "sandbox-thread",
          toolContractHash: "a".repeat(64),
          instructionSourcesHash: "b".repeat(64)
        };
      },
      async compensateSession() {}
    };
    const coordinator = new ManagedSandboxStartupCoordinator({
      store, providerWorkSessionPort, root: join(dataRoot, "execution-spaces")
    });
    const command = {
      taskId: task.id, assigneeAgentId: agent.agentId, expectedTaskVersion: task.resource_version,
      providerId: "codex-app-server", idempotencyKey: "plain-start",
      sourceSessionId: "logical:source", dispatchInitialTurn: false
    };
    const authorization = {
      providerId: "codex-app-server", workId: work.id, workspaceId: "workspace:plain",
      workspaceRootPath: source, workspaceUpdatedAt: store.getWorkspace("workspace:plain").updatedAt,
      executionStrategy: "managedSandbox"
    };

    const started = await coordinator.start(command, authorization);

    assert.equal(started.status, "ready");
    assert.equal(started.receipt.executionStrategy, "managedSandbox");
    assert.notEqual(createdCwd, source);
    assert.equal(await readFile(join(createdCwd, "brief.md"), "utf8"), "original");
    await writeFile(join(createdCwd, "brief.md"), "sandbox change");
    assert.equal(await readFile(join(source, "brief.md"), "utf8"), "original");
    const execution = store.selectOne("SELECT * FROM execution_spaces WHERE task_id=?", [task.id]);
    assert.equal(execution.status, "ready");
    assert.equal(execution.strategy, "managedSandbox");
    assert.equal(store.getTask(task.id).current_session_id, "codex:sandbox");
    assert.equal((await coordinator.start(command, authorization)).idempotentReplay, true);
    await access(createdCwd);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
