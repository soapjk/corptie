import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { WorktreeStartupPreparer } from "../src/application/worktreeStartupPreparer.mjs";
import { WorkSessionStartupCoordinator } from "../src/application/workSessionStartupCoordinator.mjs";
import { WorkSessionStartApplicationService } from "../src/application/workSessionStartApplicationService.mjs";
import { createSessionCollaborationComposition } from "../src/application/sessionCollaborationComposition.mjs";
import { TaskCoordinationService } from "../src/application/taskCoordinationService.mjs";
import { SessionMailboxService } from "../src/application/sessionMailboxService.mjs";
import { GitWorkspaceManager } from "../src/runtime/gitWorkspaceManager.mjs";
import { createGitWorkspaceSnapshot } from "../src/utils/gitWorktreeInventory.mjs";

const execFile = promisify(execFileCallback);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function git(path, ...args) {
  return (await execFile("git", ["-C", path, ...args], { encoding: "utf8" })).stdout.trim();
}

// Real Git, Store, startup authority, collaboration, dispatch and mailbox.
// Only the external Provider transport is replaced with its neutral contract.
async function fixture(t, providerId = "codex-app-server") {
  const directory = await mkdtemp(join(tmpdir(), "corptie-child-recovery-"));
  const main = join(directory, "main");
  await execFile("git", ["init", "-b", "main", main]);
  await git(main, "config", "user.name", "Corptie Tests");
  await git(main, "config", "user.email", "tests@corptie.local");
  await git(main, "commit", "--allow-empty", "-m", "initial");
  const store = new CorptieStore({ dbPath: join(directory, "state.sqlite"), configPath: join(directory, "config.json"), manageProcessEnvironment: false });
  await store.initialize({ resolveDataPath: false });
  let dispatch, application;
  t.after(async () => {
    await tick(); await Promise.all(dispatch?.running.values() ?? []); await tick();
    await store.close(); await rm(directory, { recursive: true, force: true });
  });
  const snapshot = await createGitWorkspaceSnapshot(main);
  store.upsertGitWorkspaceSnapshot(snapshot);
  const repositoryId = snapshot.repository.id;
  const core = new CollaborationCore(store), workService = new WorkApplicationService({ store });
  const role = store.createAgent({ name: "Worker", role: "independentContributor" });
  const work = workService.createWork({ name: "Recovery", contributorAgentIds: [role.agentId],
    workspaceId: store.getGitRepository(repositoryId).workspaceId });
  const parent = store.createTask({ workId: work.id, title: "Parent", mainAgentId: role.agentId });
  let sessions = 0;
  const open = (name, taskId, cwd = main) => {
    const id = `provider:${name}`;
    store.createSession({ id, title: name, agentId: role.agentId, provider: providerId, workId: work.id,
      taskId, sessionKind: taskId ? "worker" : "workChat", cwd, deferTaskProjection: true });
    store.createLogicalSessionRoute({ logicalSessionId: `logical:${name}`, legacySessionId: id,
      providerThreadId: name, providerSessionId: id, providerId, boundCwd: cwd, sessionName: name });
    core.bindSession({ agentId: role.agentId, sessionId: id });
    return store.getSession(id);
  };
  open("source", null);
  const manager = new GitWorkspaceManager({ store, transitions: {}, taskWorktreesRoot: join(directory, "trees") });
  const preparer = new WorktreeStartupPreparer({ store,
    ensureWorkspace: ({ task }) => manager.ensureTaskWorktreeForProject({ taskId: task.id, repositoryId, workingDirectory: main }) });
  const startup = new WorkSessionStartupCoordinator({ store,
    authorizeStart: command => application.authorize(command),
    prepareWorktree: input => preparer.prepare(input),
    inspectWorktree: input => preparer.inspect(input),
    onChanged: (type, payload) => dispatch?.onRuntimeEvent(type, payload),
    providerWorkSessionPort: {
      createSession: async ({ taskId, workspace }) => open(`worker${++sessions}`, taskId, workspace.canonicalWorktreePath),
      bindWorkspace: async binding => ({ providerBindingId: binding.providerBindingId,
        bindingGeneration: binding.bindingGeneration, providerResourceId: `resource:${binding.providerBindingId}`,
        canonicalWorkingDirectory: binding.workingDirectory, trustedContextHash: binding.trustedContextHash,
        acceptedAt: new Date().toISOString() }),
      inspectBinding: async () => { throw Object.assign(new Error("not bound"), { code: "START_PROVIDER_BINDING_NOT_FOUND" }); },
      activateSession: async input => {
        assert.equal(input.dispatchInitialTurn, false, "Only the original mailbox may send the instruction");
        return { providerResourceId: `resource:${input.providerBindingId}`, canonicalWorkingDirectory: input.workingDirectory,
          toolContractHash: "c".repeat(64), instructionSourcesHash: "d".repeat(64) };
      },
      compensateSession: async () => {}
    }
  });
  application = new WorkSessionStartApplicationService({ store, coordinator: startup, providerRegistry: { supports: () => true } });
  const parentStart = await application.start({ taskId: parent.id, assigneeAgentId: role.agentId,
    expectedTaskVersion: parent.resource_version, providerId, sourceSessionId: "logical:source",
    idempotencyKey: "parent", dispatchInitialTurn: false });
  assert.equal(parentStart.status, "ready");
  const parentLogical = store.getLogicalSessionByLegacySessionId(parentStart.session.id);
  const metadata = { sessionId: parentStart.session.id, providerBindingId: parentLogical.activeBinding.bindingId };
  const parentTree = store.getGitWorktree(store.getTaskDeliveryBinding(parent.id).worktree_id);
  store.db.run("DELETE FROM task_delivery_worktrees WHERE task_id=?", [parent.id]);
  const collaboration = createSessionCollaborationComposition({ store, workService, collaborationCore: core,
    defaultProviderId: providerId, getWorkSessionStartApplicationService: () => application });
  const mailbox = new SessionMailboxService({ store, resolveActor: () => role.agentId,
    validateExternal: (row, auth) => dispatch.validateMailbox(row, auth) });
  const restoreDispatch = () => {
    dispatch = new TaskCoordinationService({ store, collaboration, mailbox });
    collaboration.taskCoordinationService = dispatch;
    return dispatch;
  };
  restoreDispatch();
  const item = { action: "create", idempotencyKey: "child", text: "Perform the original instruction once",
    creation: { title: "Child", agentId: role.agentId } };
  const accept = () => dispatch.acceptDispatch(metadata, role.agentId, { items: [item] });
  const retry = id => dispatch.retryDispatch(metadata, role.agentId, id);
  return { store, work, parent, parentTree, role, main, manager, preparer, startup, application, metadata,
    collaboration, mailbox, repositoryId, accept, retry, restoreDispatch, dispatch };
}

test("legacy parent adoption is shared by concurrent child creations without scanning or freezing Git", async t => {
  const f = await fixture(t);
  await writeFile(join(f.parentTree.path, "uncommitted.txt"), "leave parent untouched");
  const parentHead = await git(f.parentTree.path, "rev-parse", "HEAD");
  const revision = f.store.getTask(f.parent.id).hierarchy_revision;
  const children = ["First", "Second"].map(title => f.store.createTask({ workId: f.work.id, title,
    parentTaskId: f.parent.id, mainAgentId: f.role.agentId }));
  const beforeBindRevision = f.store.getTask(f.parent.id).hierarchy_revision;
  f.manager.createSnapshot = () => assert.fail("Child startup must not scan repository inventory");
  const results = await Promise.all(children.map(child => f.manager.ensureTaskWorktreeForProject({ taskId: child.id })));
  assert.equal(f.store.getTaskDeliveryBinding(f.parent.id).worktree_id, f.parentTree.worktreeId);
  assert.equal(f.store.selectOne("SELECT COUNT(*) n FROM task_delivery_worktrees WHERE task_id=?", [f.parent.id]).n, 1);
  assert.equal(f.store.getTask(f.parent.id).hierarchy_revision, beforeBindRevision + 1);
  assert.ok(beforeBindRevision >= revision);
  assert.notEqual(results[0].path, results[1].path);
  for (const result of results) assert.equal(result.headOid, parentHead);
  assert.equal(await git(f.parentTree.path, "status", "--porcelain"), "?? uncommitted.txt");
});

for (const invalid of ["missing_proof", "ambiguous_proof", "unavailable_inventory"]) {
  test(`legacy adoption rejects ${invalid} before saving a binding or allocating a directory`, async t => {
    const f = await fixture(t);
    const child = f.store.createTask({ workId: f.work.id, title: "Child", parentTaskId: f.parent.id });
    const selectAll = f.store.selectAll.bind(f.store);
    f.store.selectAll = (sql, values) => {
      const rows = selectAll(sql, values);
      if (!sql.includes("SELECT o.startup_operation_id,o.repository_id,o.worktree_id")) return rows;
      return invalid === "missing_proof" ? [] : invalid === "ambiguous_proof" ? [...rows, ...rows] : rows;
    };
    if (invalid === "unavailable_inventory") f.store.db.run("UPDATE git_worktrees SET availability='missing' WHERE worktree_id=?", [f.parentTree.worktreeId]);
    f.manager.runGit = () => assert.fail("Unavailable parent must not allocate a child directory");
    await assert.rejects(f.manager.ensureTaskWorktreeForProject({ taskId: child.id }), error => {
      assert.equal(error.code, "PARENT_WORKTREE_REQUIRED");
      assert.doesNotMatch(error.message, /Cannot read properties/);
      return true;
    });
    assert.equal(f.store.getTaskDeliveryBinding(f.parent.id), null);
  });
}

for (const providerId of ["codex-app-server", "claude-sdk", "openclacky"]) {
  test(`${providerId}: original failed dispatch retries actual startup once and sends exactly one instruction`, async t => {
    const f = await fixture(t, providerId);
    const prepare = f.startup.prepareWorktree;
    f.startup.prepareWorktree = async () => { throw new TypeError("Cannot read properties of null (reading 'worktree_id')"); };
    const admission = f.accept(), id = admission.dispatches[0].dispatchId;
    assert.match(admission.instruction, /尚不代表已开始执行/);
    await f.dispatch.runDispatch(id);
    assert.equal(f.dispatch.get(id).status, "failed");
    assert.equal(f.dispatch.get(id).target_task_id, null);
    const child = f.store.selectOne("SELECT * FROM tasks WHERE parent_task_id=?", [f.parent.id]);
    const old = f.application.taskStartup({ taskId: child.id, sourceSessionId: f.metadata.sessionId });
    assert.equal(old.canRetry, true);
    const progress = f.dispatch.progress.refresh(admission.batchId);
    assert.equal(progress.items[0].state, "blocked");
    assert.match(progress.items[0].reason, /^创建失败，尚未执行/);
    assert.doesNotMatch(progress.items[0].reason, /Cannot read properties/);
    assert.equal(f.store.selectOne("SELECT COUNT(*) n FROM session_mailbox_messages").n, 0);
    f.startup.prepareWorktree = prepare;
    for (let i = 0; i < 5; i++) f.retry(id);
    await f.dispatch.runDispatch(id);
    const row = f.dispatch.get(id);
    assert.equal(row.status, "queued", row.error_message);
    assert.equal(row.target_task_id, child.id);
    assert.equal(f.store.selectOne("SELECT COUNT(*) n FROM tasks WHERE parent_task_id=?", [f.parent.id]).n, 1);
    const attempts = f.store.selectAll("SELECT * FROM work_session_startup_operations WHERE task_id=? ORDER BY rowid", [child.id]);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].idempotency_key, `retry:${old.startupOperationId}`);
    assert.equal(attempts[1].state, "ready");
    assert.equal(attempts[1].provider_id, attempts[0].provider_id);
    assert.equal(f.store.getTaskDeliveryBinding(f.parent.id).worktree_id, f.parentTree.worktreeId);
    assert.equal(f.store.selectOne("SELECT COUNT(*) n FROM session_mailbox_messages").n, 1);
    assert.equal(f.store.selectOne("SELECT body FROM session_mailbox_messages").body, "Perform the original instruction once");
    assert.equal(f.accept().dispatches[0].dispatchId, id, "Internal retry cursor must not change request identity");
    f.retry(id); f.dispatch.recover(); await f.dispatch.runDispatch(id);
    assert.equal(f.store.selectOne("SELECT COUNT(*) n FROM session_mailbox_messages").n, 1);
  });
}

test("restart between retry admission and execution resumes the persisted attempt without another child", async t => {
  const f = await fixture(t), prepare = f.startup.prepareWorktree;
  f.startup.prepareWorktree = async () => { throw new Error("preparation unavailable"); };
  const id = f.accept().dispatches[0].dispatchId;
  await f.dispatch.runDispatch(id);
  f.dispatch.runDispatch = async () => {};
  f.retry(id);
  assert.ok(JSON.parse(f.dispatch.get(id).request_json).retryStartupOperationId);
  f.startup.prepareWorktree = prepare;
  const restored = f.restoreDispatch();
  restored.recover(); await restored.runDispatch(id);
  assert.equal(restored.get(id).status, "queued", restored.get(id).error_message);
  assert.equal(f.store.selectOne("SELECT COUNT(*) n FROM tasks WHERE parent_task_id=?", [f.parent.id]).n, 1);
  assert.equal(f.store.selectOne("SELECT COUNT(*) n FROM session_mailbox_messages").n, 1);
});

test("a restored parent resource permits an explicit retry of its actionable preparation failure", async t => {
  const f = await fixture(t);
  f.store.db.run("UPDATE git_worktrees SET availability='missing' WHERE worktree_id=?", [f.parentTree.worktreeId]);
  const id = f.accept().dispatches[0].dispatchId;
  await f.dispatch.runDispatch(id);
  assert.equal(f.dispatch.get(id).error_code, "PARENT_WORKTREE_REQUIRED");
  const child = f.store.selectOne("SELECT id FROM tasks WHERE parent_task_id=?", [f.parent.id]);
  assert.equal(f.application.taskStartup({ taskId: child.id, sourceSessionId: f.metadata.sessionId }).canRetry, true);
  f.store.db.run("UPDATE git_worktrees SET availability='available' WHERE worktree_id=?", [f.parentTree.worktreeId]);
  f.retry(id); await f.dispatch.runDispatch(id);
  assert.equal(f.dispatch.get(id).status, "queued", f.dispatch.get(id).error_message);
});

test("a failed successor is not silently retried by replay or recovery", async t => {
  const f = await fixture(t);
  f.startup.prepareWorktree = async () => { throw new Error("still unavailable"); };
  const id = f.accept().dispatches[0].dispatchId;
  await f.dispatch.runDispatch(id);
  f.retry(id); await f.dispatch.runDispatch(id);
  const child = f.store.selectOne("SELECT id FROM tasks WHERE parent_task_id=?", [f.parent.id]);
  const count = () => f.store.selectOne("SELECT COUNT(*) n FROM work_session_startup_operations WHERE task_id=?", [child.id]).n;
  assert.equal(count(), 2);
  assert.equal(f.dispatch.get(id).status, "failed");
  // Simulate a crash before the failed successor was projected to the dispatch.
  f.dispatch.update(id, { status: "preparing" });
  const restored = f.restoreDispatch();
  restored.recover(); await restored.runDispatch(id);
  assert.equal(restored.get(id).status, "failed");
  assert.equal(count(), 2);
  assert.equal(f.store.selectOne("SELECT COUNT(*) n FROM session_mailbox_messages").n, 0);
});

test("recovery joins a running successor instead of starting its preparation twice", async t => {
  const f = await fixture(t), prepare = f.startup.prepareWorktree;
  f.startup.prepareWorktree = async () => { throw new Error("temporary failure"); };
  const id = f.accept().dispatches[0].dispatchId;
  await f.dispatch.runDispatch(id);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  f.startup.prepareWorktree = async input => { calls++; entered(); await gate; return prepare(input); };
  f.retry(id);
  const running = f.dispatch.runDispatch(id);
  await started;
  const child = f.store.selectOne("SELECT id FROM tasks WHERE parent_task_id=?", [f.parent.id]);
  const retryId = JSON.parse(f.dispatch.get(id).request_json).retryStartupOperationId;
  const recovery = f.application.resumeTaskStartup({ taskId: child.id, sourceSessionId: f.metadata.sessionId, retryStartupOperationId: retryId });
  release();
  await Promise.all([running, recovery]);
  assert.equal(calls, 1);
  assert.equal(f.dispatch.get(id).status, "queued");
  assert.equal(f.store.selectOne("SELECT COUNT(*) n FROM session_mailbox_messages").n, 1);
});

test("empty child workspace output produces an actionable error rather than a null dereference", async t => {
  const f = await fixture(t);
  const child = f.store.createTask({ workId: f.work.id, title: "Child", parentTaskId: f.parent.id });
  for (const output of [null, {}, { worktreeId: "missing", path: "/tmp/missing", branchName: "branch" }]) {
    const preparer = new WorktreeStartupPreparer({ store: f.store, ensureWorkspace: async () => output });
    await assert.rejects(preparer.prepare({ task: child, taskId: child.id, repositoryId: f.repositoryId,
      startupOperationId: "startup:empty" }), { code: "START_WORKTREE_INVENTORY_MISMATCH" });
  }
});
