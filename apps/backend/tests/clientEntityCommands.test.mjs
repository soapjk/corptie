import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";

const tasks = { deviceId: "device:test" };
const works = tasks;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "corptie-device-entity-"));
  const store = new CorptieStore({ dbPath: join(dir, "db.sqlite"), configPath: join(dir, "config.json") });
  await store.initialize();
  const agent = store.createAgent({ id: "agent:test", name: "Test" });
  store.createAgent({ id: "agent:outside", name: "Outside" });
  store.createWork({ id: "work:test", name: "Work", contributorAgentIds: [agent.agentId] });
  const task = store.createTask({ workId: "work:test", title: "Task", mainAgentId: "agent:test" });
  store.createSession({ id: "session:task", title: "Worker", workId: "work:test", taskId: task.id, agentId: "agent:test", status: "complete" });
  const calls = [];
  const entityCommands = {
    createWork: async input => { calls.push(["createWork", input]); return store.createWork(input); },
    updateTask: async (id, patch) => { calls.push(["updateTask", id, patch]); return store.updateTask(id, patch); },
    setTaskArchived: async (id, archived) => { calls.push(["setTaskArchived", id, archived]); return store.setTaskArchived(id, archived); },
    restartTask: async (id, context) => { calls.push(["restartTask", id, context]); return { status: "restarted", secret: "PRIVATE" }; },
    inspectTaskDeletion: async (id, actor) => {
      calls.push(["inspectTaskDeletion", id, actor]);
      return { taskId: id, status: "risky", retryable: true, associatedSessionCount: 1,
        artifacts: [{ artifactId: "artifact:a", title: "Plan", visibility: "PRIVATE" }],
        inspection: { secret: "PRIVATE" },
        worktree: { worktreeId: "wt", path: "/Volumes/PRIVATE/worktree", branchName: "task/abc", isMain: false, dirty: true, mergedIntoMain: false, aheadOfMain: 2 },
        risks: [{ code: "DIRTY_WORKTREE", message: "uncommitted changes", files: ["a.swift", "/Volumes/PRIVATE/b.swift"], commitCount: 2 }],
        blockers: [] };
    },
    deleteTask: async (id, input, actor) => { calls.push(["deleteTask", id, input, actor]); return { accepted: true, operation: { operationId: "op:1", state: "queued", path: "PRIVATE" } }; },
    updateWork: async (id, patch) => { calls.push(["updateWork", id, patch]); return store.updateWork(id, patch); },
    deleteWork: async id => { calls.push(["deleteWork", id]); return store.deleteWork(id); }
};
  let restart = { available: true, reason: null };
  const make = (options = {}) => new ClientSessionAPI({ store, actions: () => ({ restart }), entityCommands, ...options });
  return { store, task, make, calls, setRestart: value => { restart = value; },
    close: async () => { await store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("Work creation shares services, validates contributors and returns replay-safe receipts", async () => {
  const f = await fixture();
  try {
    const api = f.make();
    assert.ok(api.workCreationOptions().agents.some(agent => agent.id === "agent:test"));
    const input = { requestId: "create-work-001", name: "NewWork", description: "Scope", contributorAgentIds: ["agent:test"] };
    const first = await api.createWork(works, input);
    assert.equal(first.status, "completed");
    assert.equal(first.kind, "work_create");
    assert.equal(first.entityResult.name, "NewWork");
    const replay = await api.createWork(works, input);
    assert.deepEqual(replay.entityResult, first.entityResult);
    assert.equal(f.calls.filter(row => row[0] === "createWork").length, 1);
    await assert.rejects(async () => api.createWork(works, { ...input, name: "Different" }), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(async () => api.createWork(works, { ...input, requestId: "create-work-002", contributorAgentIds: [] }), { code: "INVALID_WORK_COMMAND" });
    await assert.rejects(async () => api.createWork(works, { ...input, requestId: "create-work-003", contributorAgentIds: ["agent:missing"] }), { code: "AGENT_NOT_FOUND" });
    await assert.rejects(async () => api.createWork(works, { ...input, requestId: "create-work-004" }, () => { throw Object.assign(new Error(), { code: "INVALID_CREDENTIAL" }); }), { code: "INVALID_CREDENTIAL" });
    assert.equal(f.calls.filter(row => row[0] === "createWork").length, 1);
    assert.throws(() => f.make({ entityCommands: {} }).workCreationOptions(), { code: "CAPABILITY_UNSUPPORTED" });
  } finally { await f.close(); }
});

test("management projections are available to every paired device and mirror the desktop menu gates", async () => {
  const f = await fixture();
  try {
    const api = f.make();
    await assert.rejects(async () => f.make({ entityCommands: null }).taskManagement(tasks, f.task.id), { code: "CAPABILITY_UNSUPPORTED", status: 409 });
    await assert.rejects(async () => api.taskManagement(tasks, "task:missing"), { code: "TASK_NOT_FOUND", status: 404 });
    await assert.rejects(async () => api.workManagement(works, "work:missing"), { code: "WORK_NOT_FOUND", status: 404 });

    const management = api.taskManagement(tasks, f.task.id);
    assert.equal(management.schemaVersion, 1);
    assert.deepEqual(management.task, { id: f.task.id, workId: "work:test", title: "Task", description: "", acceptanceCriteria: "",
      verificationCriteria: "", priority: "medium", lifecycleState: "todo", archived: false,
      autoTitleEnabled: true, mainAgentId: "agent:test", deletionStatus: null });
    assert.deepEqual(management.agents, [{ id: "agent:test", name: "Test" }]);
    assert.deepEqual(management.priorities, ["low", "medium", "high", "urgent"]);
    assert.deepEqual(management.actions, {
      rename: { available: true, reason: null }, edit: { available: true, reason: null }, restart: { available: true, reason: null },
      archive: { available: true, reason: null }, unarchive: { available: false, reason: "TASK_NOT_ARCHIVED" }, delete: { available: true, reason: null } });

    f.setRestart({ available: false, reason: "PROVIDER_INITIALIZING" });
    assert.deepEqual(api.taskManagement(tasks, f.task.id).actions.restart, { available: false, reason: "PROVIDER_INITIALIZING" });
    f.store.setTaskArchived(f.task.id, true);
    const archived = api.taskManagement(tasks, f.task.id).actions;
    assert.deepEqual(archived.archive, { available: false, reason: "TASK_ARCHIVED" });
    assert.deepEqual(archived.unarchive, { available: true, reason: null });
    f.store.setTaskArchived(f.task.id, false);
    f.store.db.run("UPDATE tasks SET deletion_status='deleting' WHERE id=?", [f.task.id]);
    const deleting = api.taskManagement(tasks, f.task.id);
    assert.equal(deleting.task.deletionStatus, "deleting");
    assert.ok(Object.values(deleting.actions).every(a => a.available === false && a.reason === "TASK_DELETING"));
    assert.deepEqual(api.workManagement(works, "work:test").actions, { edit: { available: true, reason: null }, delete: { available: false, reason: "WORK_TASK_DELETING" } });
    f.store.db.run("UPDATE tasks SET deletion_status=NULL WHERE id=?", [f.task.id]);
    assert.deepEqual(api.workManagement(works, "work:test").work, { id: "work:test", name: "Work", description: "", status: "active" });
  } finally { await f.close(); }
});

test("deletion plan is inspected as the paired-device actor and never exposes host paths", async () => {
  const f = await fixture();
  try {
    const api = f.make();
    const plan = await api.taskDeletionPlan(tasks, f.task.id);
    assert.deepEqual(f.calls, [["inspectTaskDeletion", f.task.id, { type: "user", id: "user:paired-device:device:test" }]]);
    assert.deepEqual(plan, { schemaVersion: 1, taskId: f.task.id, status: "risky", associatedSessionCount: 1,
      artifacts: [{ id: "artifact:a", title: "Plan" }],
      worktree: { branchName: "task/abc", dirty: true, mergedIntoMain: false, aheadOfMain: 2 },
      risks: [{ code: "DIRTY_WORKTREE", message: "uncommitted changes", files: ["a.swift", "/Volumes/PRIVATE/b.swift"], commitCount: 2 }], blockers: [] });
    assert.equal(JSON.stringify(plan).includes("/Volumes/PRIVATE/worktree"), false);
    assert.equal(JSON.stringify(plan).includes("secret"), false);
    const forbidden = f.make({ entityCommands: { inspectTaskDeletion: async () => { throw Object.assign(new Error("no"), { code: "TASK_DELETE_FORBIDDEN", status: 403 }); } } });
    await assert.rejects(async () => forbidden.taskDeletionPlan(tasks, f.task.id), { code: "TASK_DELETE_FORBIDDEN", status: 403 });
    const broken = f.make({ entityCommands: { inspectTaskDeletion: async () => { throw new Error("git exploded at /Volumes/PRIVATE"); } } });
    await assert.rejects(async () => broken.taskDeletionPlan(tasks, f.task.id), { code: "TASK_DELETION_INSPECTION_FAILED", status: 503 });
  } finally { await f.close(); }
});

test("task commands validate closed DTOs before any receipt is journaled", async () => {
  const f = await fixture();
  try {
    const api = f.make();
    const bad = [
      ["update", { requestId: "short", title: "X" }], ["update", { requestId: "req_00000001" }],
      ["update", { requestId: "req_00000001", title: "bad name!" }], ["update", { requestId: "req_00000001", title: "" }],
      ["update", { requestId: "req_00000001", priority: "critical" }], ["update", { requestId: "req_00000001", executionStatus: "running" }],
      ["update", { requestId: "req_00000001", lifecycleState: "done" }], ["update", { requestId: "req_00000001", description: "x".repeat(16_001) }],
      ["update", { requestId: "req_00000001", autoTitleEnabled: "false" }],
      ["archive", { requestId: "req_00000001", archived: "yes" }], ["archive", { requestId: "req_00000001" }],
      ["restart", { requestId: "req_00000001", force: true }],
      ["delete", { requestId: "req_00000001", mode: "hard" }], ["delete", { requestId: "req_00000001", artifactDisposition: "purge" }],
      ["delete", { requestId: "req_00000001", deleteWorktree: "no" }], ["delete", { requestId: "req_00000001", worktreePath: "/x" }]
    ];
    for (const [command, input] of bad) {
      await assert.rejects(async () => api.taskCommand(tasks, f.task.id, command, input), { code: "INVALID_TASK_COMMAND", status: 400 }, JSON.stringify([command, input]));
    }
    await assert.rejects(async () => api.taskCommand(tasks, f.task.id, "update", { requestId: "req_00000001", mainAgentId: "agent:outside" }), { code: "AGENT_OUTSIDE_WORK", status: 403 });
    await assert.rejects(async () => api.taskCommand(tasks, f.task.id, "complete", { requestId: "req_00000001" }), { code: "ROUTE_NOT_AVAILABLE", status: 404 });
    await assert.rejects(async () => api.workCommand(works, "work:test", "update", { requestId: "req_00000001" }), { code: "INVALID_WORK_COMMAND", status: 400 });
    await assert.rejects(async () => api.workCommand(works, "work:test", "update", { requestId: "req_00000001", avatarPath: "/x" }), { code: "INVALID_WORK_COMMAND", status: 400 });
    await assert.rejects(async () => api.workCommand(works, "work:test", "delete", { requestId: "req_00000001", force: true }), { code: "INVALID_WORK_COMMAND", status: 400 });
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM client_command_receipts").count, 0);
  } finally { await f.close(); }
});

test("commands dispatch through shared services once, replay receipts and classify outcomes", async () => {
  const f = await fixture();
  try {
    const api = f.make();
    const update = await api.taskCommand(tasks, f.task.id, "update", { requestId: "req_update_1", title: "Renamed", priority: "high", autoTitleEnabled: false });
    assert.equal(update.status, "completed");
    assert.equal(update.kind, "task_update");
    assert.deepEqual(update.entityResult, { taskId: f.task.id, title: "Renamed" });
    assert.equal(update.taskResult, undefined);
    assert.equal(f.store.getTask(f.task.id).priority, "high");
    assert.equal(f.store.getTask(f.task.id).auto_title_enabled, 0);
    assert.deepEqual(f.calls.pop(), ["updateTask", f.task.id, { title: "Renamed", autoTitleEnabled: false, priority: "high" }]);
    // Same request replays the receipt; a changed payload is a conflict; neither re-dispatches.
    assert.deepEqual(await f.make().taskCommand(tasks, f.task.id, "update", { requestId: "req_update_1", title: "Renamed", priority: "high", autoTitleEnabled: false }), update);
    await assert.rejects(async () => api.taskCommand(tasks, f.task.id, "update", { requestId: "req_update_1", title: "Other" }), { code: "IDEMPOTENCY_CONFLICT", status: 409 });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(api.receipt(tasks, "req_update_1"), update);

    const archive = await api.taskCommand(tasks, f.task.id, "archive", { requestId: "req_archive_1", archived: true });
    assert.deepEqual(archive.entityResult, { taskId: f.task.id, archived: true });
    assert.equal(Boolean(f.store.getTask(f.task.id).archived), true);
    assert.deepEqual((await api.taskCommand(tasks, f.task.id, "archive", { requestId: "req_archive_2", archived: false })).entityResult, { taskId: f.task.id, archived: false });
    // The store refuses to archive a running Task with a 409 code: a definite rejection, not an unknown outcome.
    f.store.db.run("UPDATE tasks SET execution_status='running' WHERE id=?", [f.task.id]);
    const busy = await api.taskCommand(tasks, f.task.id, "archive", { requestId: "req_archive_3", archived: true });
    assert.equal(busy.status, "rejected");
    assert.equal(busy.errorCode, "TASK_ARCHIVE_BUSY");
    assert.equal(Boolean(f.store.getTask(f.task.id).archived), false);
    f.store.db.run("UPDATE tasks SET execution_status='idle' WHERE id=?", [f.task.id]);

    const restart = await api.taskCommand(tasks, f.task.id, "restart", { requestId: "req_restart_1" });
    assert.deepEqual(restart.entityResult, { taskId: f.task.id, status: "restarted" });
    const [, , context] = f.calls.pop();
    assert.equal(context.source, "client-device");
    assert.match(context.idempotencyKey, /^task-restart:device:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(restart).includes("PRIVATE"), false);

    const remove = await api.taskCommand(tasks, f.task.id, "delete", { requestId: "req_delete_1", mode: "force", acknowledgeDataLoss: true, confirmedBranchName: "task/abc", artifactDisposition: "retain" });
    assert.deepEqual(remove.entityResult, { taskId: f.task.id, operationId: "op:1", state: "queued" });
    const [, , input, actor] = f.calls.pop();
    assert.deepEqual(actor, { type: "user", id: "user:paired-device:device:test" });
    assert.deepEqual({ ...input, idempotencyKey: undefined }, { mode: "force", deleteWorktree: true, artifactDisposition: "retain", acknowledgeDataLoss: true, confirmedBranchName: "task/abc", idempotencyKey: undefined });
    assert.match(input.idempotencyKey, new RegExp(`^task-delete:${f.task.id}:device:[a-f0-9]{64}$`));

    // Validation errors thrown by the shared services (no HTTP status) are still definite rejections.
    const invalid = await api.taskCommand(tasks, f.task.id, "update", { requestId: "req_update_2", mainAgentId: "agent:test", acceptanceCriteria: "x" });
    assert.equal(invalid.status, "completed");
    const lost = f.make({ entityCommands: { updateTask: async () => { throw new Error("socket hang up"); } } });
    const uncertain = await lost.taskCommand(tasks, f.task.id, "update", { requestId: "req_update_3", title: "Lost" });
    assert.equal(uncertain.status, "unknown");
    assert.equal(uncertain.errorCode, "TASK_UPDATE_OUTCOME_UNCERTAIN");
    assert.deepEqual(await lost.taskCommand(tasks, f.task.id, "update", { requestId: "req_update_3", title: "Lost" }), uncertain, "never auto-replayed");

    // Work commands: rename then delete; a deleting Task blocks Work deletion with a definite code.
    const work = await api.workCommand(works, "work:test", "update", { requestId: "req_work_1", name: "Renamed" });
    assert.deepEqual(work.entityResult, { workId: "work:test", name: "Renamed" });
    assert.equal(work.kind, "work_update");
    f.store.db.run("UPDATE tasks SET deletion_status='deleting' WHERE id=?", [f.task.id]);
    const blocked = await api.workCommand(works, "work:test", "delete", { requestId: "req_work_2" });
    assert.equal(blocked.status, "rejected");
    assert.equal(blocked.errorCode, "WORK_TASK_DELETING");
    const deletingRestart = await api.taskCommand(tasks, f.task.id, "restart", { requestId: "req_restart_2" });
    assert.deepEqual([deletingRestart.status, deletingRestart.errorCode], ["rejected", "TASK_DELETING"]);
    assert.equal(f.calls.some(([name]) => name === "restartTask"), false);
    f.store.db.run("UPDATE tasks SET deletion_status=NULL WHERE id=?", [f.task.id]);
    f.store.deleteTask(f.task.id);
    const deleted = await api.workCommand(works, "work:test", "delete", { requestId: "req_work_3" });
    assert.deepEqual(deleted.entityResult, { workId: "work:test" });
    assert.equal(f.store.getWork("work:test"), null);
  } finally { await f.close(); }
});

test("revalidation catches a changed device identity before dispatch and concurrent requests dispatch once", async () => {
  const f = await fixture();
  try {
    const api = f.make();
    await assert.rejects(async () => api.taskCommand(tasks, f.task.id, "archive", { requestId: "req_revoked_1", archived: true },
      () => ({ deviceId: "device:other" })), { code: "INVALID_CREDENTIAL", status: 401 });
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.selectOne("SELECT COUNT(*) AS count FROM client_command_receipts").count, 0);
    const results = await Promise.all([
      api.taskCommand(tasks, f.task.id, "update", { requestId: "req_race_1", title: "Raced" }, () => tasks),
      api.taskCommand(tasks, f.task.id, "update", { requestId: "req_race_1", title: "Raced" }, () => tasks)
    ]);
    assert.ok(results.every(result => ["completed", "dispatching"].includes(result.status)));
    assert.equal(f.calls.filter(([name]) => name === "updateTask").length, 1);
    assert.deepEqual(api.receipt(tasks, "req_race_1").entityResult, { taskId: f.task.id, title: "Raced" });
  } finally { await f.close(); }
});
