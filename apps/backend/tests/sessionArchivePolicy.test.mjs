import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateSyncService } from "../src/application/stateSyncService.mjs";
import {
  assertManualSessionArchiveAllowed,
  resolveSessionArchiveState
} from "../src/domain/sessionArchivePolicy.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { TaskCompletionService } from "../src/application/taskCompletionService.mjs";

test("the shared archive policy varies by Session kind", () => {
  assert.deepEqual(
    resolveSessionArchiveState({ sessionKind: "assistantChat", archived: true }),
    { archived: true, reason: "manual" }
  );
  assert.deepEqual(
    resolveSessionArchiveState(
      { sessionKind: "worker", archived: false },
      { taskStatus: "done" }
    ),
    { archived: true, reason: "taskCompleted" }
  );
  assert.deepEqual(
    resolveSessionArchiveState({ sessionKind: "workChat", archived: false }),
    { archived: false, reason: null }
  );
});

test("only Assistant Sessions allow manual archive operations", () => {
  assert.doesNotThrow(() => assertManualSessionArchiveAllowed({
    id: "assistant:one",
    sessionKind: "assistantChat"
  }));
  for (const sessionKind of ["worker", "workChat", "legacy"]) {
    assert.throws(
      () => assertManualSessionArchiveAllowed({ id: `${sessionKind}:one`, sessionKind }),
      (error) => error.code === "SESSION_MANUAL_ARCHIVE_UNSUPPORTED" && error.statusCode === 409
    );
  }
});

test("Worker archive membership follows Task completion and publishes live State changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-session-archive-policy-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    const agent = store.createAgent({ name: "Archive", role: "independentContributor" });
    store.createWork({ id: "work:one", name: "Work", contributorAgentIds: [agent.agentId] });
    store.createTask({
      id: "task:one",
      workId: "work:one",
      title: "Work item",
      lifecycleState: "in_progress"
    });
    store.upsertSession({
      id: "session:worker",
      title: "Worker",
      agent: "Agent",
      provider: "codex-app-server",
      status: "complete",
      sessionKind: "worker",
      workId: "work:one",
      taskId: "task:one"
    });
    store.upsertSession({
      id: "session:assistant",
      title: "Assistant",
      agent: "Assistant",
      provider: "codex-app-server",
      status: "complete",
      sessionKind: "assistantChat"
    });
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:worker",
      legacySessionId: "session:worker",
      providerThreadId: "thread:worker",
      providerSessionId: "thread:worker",
      providerId: "codex-app-server",
      boundCwd: directory,
      sessionName: "Worker"
    });
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:assistant",
      legacySessionId: "session:assistant",
      providerThreadId: "thread:assistant",
      providerSessionId: "thread:assistant",
      providerId: "codex-app-server",
      boundCwd: directory,
      sessionName: "Assistant"
    });
    const snapshot = () => ({
      sessions: store.listSessions({ archived: false }),
      tasks: store.listTasks()
    });
    const sync = new StateSyncService({ store, snapshot });

    assert.throws(
      () => store.archiveSession("session:worker", true),
      (error) => error.code === "SESSION_MANUAL_ARCHIVE_UNSUPPORTED"
    );
    assert.equal(store.archiveSession("session:assistant", true).archiveReason, "manual");
    assert.deepEqual(store.listSessions({ archived: false }).map((session) => session.id), ["session:worker"]);
    assert.deepEqual(
      store.listEmptyActiveProviderBindings("codex-app-server").map((binding) => binding.sessionId),
      ["session:worker"]
    );
    assert.deepEqual(
      store.listSessions({ archived: true }).map((session) => session.id),
      ["session:assistant"]
    );

    let revision = sync.snapshot().revision;
    const beforeArchive = store.getTask("task:one");
    store.setTaskArchived("task:one", true);
    assert.equal(store.getTask("task:one").lifecycle_state, beforeArchive.lifecycle_state);
    assert.equal(store.getSession("session:worker").archiveReason, "taskArchived");
    assert.deepEqual(store.listSessions({ archived: false }), []);
    assert.deepEqual(sync.changesAfter(revision).deletes.sessions, ["session:worker"]);
    assert.equal(store.listSessionPage({ archived: true, sessionKind: "worker", limit: 50 }).items.length, 1);
    revision = sync.snapshot().revision;
    store.setTaskArchived("task:one", false);
    assert.equal(store.getTask("task:one").lifecycle_state, beforeArchive.lifecycle_state);
    assert.equal(store.getSession("session:worker").archived, false);
    assert.ok(sync.changesAfter(revision).upserts.sessions.some((session) => session.id === "session:worker"));
    store.updateTask("task:one", { executionStatus: "running" });
    assert.throws(() => store.setTaskArchived("task:one", true), { code: "TASK_ARCHIVE_BUSY" });
    store.updateTask("task:one", { executionStatus: "idle" });
    const originalPendingWake = store.hasPendingScheduledWakeForTask;
    store.hasPendingScheduledWakeForTask = () => true;
    assert.throws(() => store.setTaskArchived("task:one", true), { code: "TASK_ARCHIVE_PENDING_WAKE" });
    store.hasPendingScheduledWakeForTask = originalPendingWake;
    assert.equal(store.getTask("task:one").archived, 0);
    revision = sync.snapshot().revision;
    const completionService = new TaskCompletionService({ store });
    const receipt = completionService.issueMacOSIntent("task:one", {
      requestId: "archive-completion-intent", interactionId: "archive-completion-click",
      uiSurface: "task_completion_confirmation", displayedTaskId: "task:one",
      displayedTaskTitle: "Work item", displayedAcceptanceStatus: "not_assessed"
    }, { type: "user", id: "user:local-macos" });
    completionService.completeFromMacOS("task:one", {
      intentToken: receipt.intentToken, requestId: "archive-completion-intent",
      idempotencyKey: "archive-completion"
    });
    const completedChanges = sync.changesAfter(revision);
    assert.deepEqual(completedChanges.deletes.sessions, ["session:worker"]);
    assert.equal(completedChanges.upserts.tasks[0].lifecycle_state, "done");
    assert.deepEqual(store.listSessions({ archived: false }), []);
    assert.deepEqual(
      store.listEmptyActiveProviderBindings("codex-app-server").map((binding) => binding.sessionId),
      [],
      "a completed Worker Session must not enter active runtime prewarming"
    );
    assert.deepEqual(
      store.listSessions({ archived: true })
        .filter((session) => session.sessionKind === "worker")
        .map(({ id, archived, archiveReason }) => ({ id, archived, archiveReason })),
      [{ id: "session:worker", archived: true, archiveReason: "taskCompleted" }]
    );
    const firstArchivePage = store.listSessionPage({ archived: true, limit: 1 });
    assert.equal(firstArchivePage.items.length, 1);
    assert.equal(firstArchivePage.hasMore, true);
    assert.ok(firstArchivePage.nextCursor);
    const secondArchivePage = store.listSessionPage({
      archived: true,
      limit: 1,
      cursor: firstArchivePage.nextCursor
    });
    assert.equal(secondArchivePage.items.length, 1);
    assert.notEqual(secondArchivePage.items[0].id, firstArchivePage.items[0].id);
    assert.equal(secondArchivePage.hasMore, false);
    const workerArchivePage = store.listSessionPage({
      archived: true,
      sessionKind: "worker",
      limit: 50
    });
    assert.deepEqual(workerArchivePage.items.map((session) => session.id), ["session:worker"]);
    assert.equal(workerArchivePage.hasMore, false);
    const directArchiveLookup = store.listSessionPage({
      archived: true,
      sessionId: "session:assistant",
      limit: 1
    });
    assert.deepEqual(directArchiveLookup.items.map((session) => session.id), ["session:assistant"]);
    assert.equal(directArchiveLookup.hasMore, false);
    assert.deepEqual(
      [...store.listSessionTimelineRevisions(["session:worker"]).keys()],
      ["session:worker"],
      "resident metadata queries must stay bounded to the requested Session window"
    );
    assert.deepEqual([...store.listSessionMessageCursors(["session:worker"]).keys()], ["session:worker"]);
    assert.deepEqual([...store.listLatestSessionMessageTimes(["session:worker"]).keys()], []);

    revision = completedChanges.revision;
    store.updateTask("task:one", { lifecycleState: "in_progress" });
    const reopenedChanges = sync.changesAfter(revision);
    assert.deepEqual(reopenedChanges.upserts.sessions.map((session) => session.id), ["session:worker"]);
    assert.equal(reopenedChanges.upserts.sessions[0].archived, false);
    assert.deepEqual(
      store.listSessions({ archived: true }).map((session) => session.id),
      ["session:assistant"]
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
