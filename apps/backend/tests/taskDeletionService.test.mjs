import assert from "node:assert/strict";
import test from "node:test";
import { TaskDeletionService } from "../src/application/taskDeletionService.mjs";
import { worktreeDispatchBlocker } from "../src/application/worktreeExecutionBarrier.mjs";

test("deletion freezes only the target Session even without a repository route", () => {
  const store = { getTask: id => ({ deletion_status: id === "task:deleting" ? "deleting" : null }) };
  assert.equal(worktreeDispatchBlocker(store, { logicalSession: { taskId: "task:deleting" } }).reason, "TASK_DELETION_IN_PROGRESS");
  assert.equal(worktreeDispatchBlocker(store, { logicalSession: { taskId: "task:sibling" } }), null);
});

test("empty children are deletable and child presence is no longer a blanket rejection", async () => {
  const leaf = fixture({ task: { parent_task_id: "task:parent" } });
  assert.equal((await leaf.service.inspect("task:one")).status, "safe");
  assert.equal((await leaf.service.delete("task:one")).ok, true);
  const parent = fixture({ hasChildren: true });
  assert.equal((await parent.service.delete("task:one", { deleteWorktree: false })).ok, true);
});

test("force cannot bypass busy Sessions, including metadata-only deletion", async () => {
  const f = fixture({ sessions: [{ id: "session:busy", status: "running" }] });
  for (const deleteWorktree of [true, false]) await assert.rejects(f.service.delete("task:one", {
    mode: "force", deleteWorktree, acknowledgeDataLoss: true
  }), { code: "SESSION_BUSY" });
  assert.deepEqual(f.calls, []);
});

test("parent delivery classification retains risk information without blocking deletion", async () => {
  for (const delivered of [true, false]) {
    const f = fixture({ task: { parent_task_id: "task:parent" }, inspection: { status: "available", worktree: {
      worktreeId: "tree:child", branchName: "task/child", mergedIntoMain: false, aheadOfMain: 20,
      statusSummary: "", deliveryComparison: { delivered, commitCount: delivered ? 0 : 1 }
    } } });
    const plan = await f.service.inspect("task:one");
    assert.deepEqual(plan.risks.map(r => r.code), delivered ? [] : ["NOT_DELIVERED_TO_PARENT"]);
    assert.equal((await f.service.delete("task:one")).ok, true);
  }
});

test("a Worktree cleanup rejection preserves Sessions and Artifacts", async () => {
  const f = fixture({ sessions: [{ id: "session:one" }], associations: { artifacts: [{ artifactId: "a" }] },
    inspection: { status: "available", worktree: { worktreeId: "w", mergedIntoMain: true } },
    removeError: Object.assign(new Error("changed"), { code: "TASK_DELETE_SCOPE_INVALID" }) });
  await assert.rejects(f.service.delete("task:one"), { code: "TASK_DELETE_SCOPE_INVALID" });
  assert.equal(f.calls.some(([name]) => ["deleteSession", "artifacts", "finalize"].includes(name)), false);
});

function fixture(options = {}) {
  let item = { id: "task:one", deletion_worktree_removed_at: null, ...options.task };
  const calls = [];
  const store = {
    getTask: () => item,
    listSessionsByTask: () => options.sessions ?? [],
    selectOne: (sql) => sql.includes("FROM tasks WHERE parent_task_id") ? (options.hasChildren ? { found: 1 } : null)
      : sql.includes("work_session_startup_operations") && options.activeStart ? { operation_id: "start:one" } : null,
    listTaskDeletionBlockingAssociations: () => options.associations ?? { artifacts: [] },
    getActiveWorktreeIntegrationJobForConflictTask: () => options.integrationJob ?? null,
    markTaskDeletion: (...args) => calls.push(["mark", ...args]),
    markTaskWorktreeRemoved: (...args) => {
      calls.push(["removed", ...args]);
      item = { ...item, deletion_worktree_removed_at: "now" };
    },
    finalizeTaskDeletion: (...args) => {
      calls.push(["finalize", ...args]);
      if (options.finalizeError) throw options.finalizeError;
      item = null;
      return { archivedSessionIds: [] };
    }
  };
  const inspection = options.inspection ?? { status: "none", worktree: null, blocker: null };
  const service = new TaskDeletionService({
    store,
    authorize: async (input) => options.authorize ? options.authorize(input) : true,
    inspectWorktree: async () => inspection,
    removeWorktree: async (input) => {
      calls.push(["remove", input]);
      if (options.removeError) throw options.removeError;
      return { removed: true };
    },
    deleteSession: async (sessionId) => calls.push(["deleteSession", sessionId]),
    handleArtifacts: async (input) => {
      if ((input.artifacts ?? []).length > 0) calls.push(["artifacts", input.disposition]);
      return { disposition: input.disposition, artifactIds: (input.artifacts ?? []).map((item) => item.artifactId) };
    }
  });
  return { service, calls, getItem: () => item };
}

test("deletion preflight reports tracked, untracked, and unmerged risks separately", async () => {
  const { service } = fixture({
    inspection: {
      status: "available",
      blocker: "UNCOMMITTED_CHANGES",
      worktree: {
        worktreeId: "worktree:one", path: "/repo-one", branchName: "task/one",
        dirty: true, mergedIntoMain: false, aheadOfMain: 2,
        statusSummary: " M tracked.txt\n?? untracked.txt"
      }
    }
  });
  const plan = await service.inspect("task:one");
  assert.equal(plan.status, "risky");
  assert.deepEqual(plan.risks.map((risk) => risk.code), [
    "UNCOMMITTED_CHANGES", "UNTRACKED_FILES", "NOT_MERGED_INTO_MAIN"
  ]);
  assert.equal((await service.delete("task:one", { mode: "safe" })).ok, true);
});

test("deletion discards unique history without a second acknowledgement and cleans before metadata", async () => {
  const { service, calls } = fixture({
    inspection: {
      status: "available", blocker: "NOT_MERGED_INTO_MAIN",
      repositoryId: "repository:one",
      worktree: {
        worktreeId: "worktree:one", path: "/repo-one", branchName: "task/one",
        dirty: false, mergedIntoMain: false, aheadOfMain: 1, statusSummary: ""
      }
    }
  });
  const result = await service.delete("task:one", {
    mode: "force", acknowledgeDataLoss: true
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(([name]) => name), ["mark", "remove", "removed", "finalize"]);
});

test("metadata failure leaves an explicit retryable state after Worktree removal", async () => {
  const { service, calls, getItem } = fixture({
    inspection: {
      status: "available", blocker: null,
      worktree: {
        worktreeId: "worktree:one", path: "/repo-one", branchName: "task/one",
        dirty: false, mergedIntoMain: true, aheadOfMain: 0, statusSummary: ""
      }
    },
    finalizeError: Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" })
  });
  await assert.rejects(
    service.delete("task:one", { mode: "safe" }),
    (error) => error.code === "SQLITE_BUSY" && /请重新检查后继续清理/.test(error.message)
  );
  assert.ok(getItem().deletion_worktree_removed_at);
  assert.equal(calls.at(-1)[0], "mark");
  assert.equal(calls.at(-1)[2], "delete_failed");
  const retryPlan = await service.inspect("task:one");
  assert.equal(retryPlan.worktree, null);
  assert.equal(retryPlan.status, "safe");
});

test("main and shared Worktrees can never be force deleted", async () => {
  for (const blocker of ["MAIN_WORKTREE", "SHARED_WITH_ACTIVE_TASK"]) {
    const { service, calls } = fixture({
      inspection: {
        status: "available", blocker,
        worktree: {
          worktreeId: "worktree:one", path: "/repo", branchName: "main",
          isMain: blocker === "MAIN_WORKTREE", dirty: false, mergedIntoMain: true, aheadOfMain: 0, statusSummary: ""
        }
      }
    });
    await assert.rejects(
      service.delete("task:one", { mode: "force", acknowledgeDataLoss: true }),
      (error) => error.code === blocker
    );
    assert.equal(calls.some(([name]) => name === "remove"), false);
  }
});

test("an unfinished Worktree integration owns its conflict Task and Worktree", async () => {
  const { service, calls } = fixture({
    integrationJob: { id: "worktree_integration:one", status: "paused" },
    inspection: {
      status: "available",
      worktree: { worktreeId: "worktree:integration", branchName: "integration/one" }
    }
  });
  const plan = await service.inspect("task:one");
  assert.equal(plan.status, "blocked");
  assert.equal(plan.blockers[0].code, "ACTIVE_WORKTREE_INTEGRATION_JOB");
  await assert.rejects(
    service.delete("task:one", { mode: "force", deleteWorktree: false }),
    (error) => error.code === "ACTIVE_WORKTREE_INTEGRATION_JOB"
  );
  assert.deepEqual(calls, []);
});

test("Task without a Worktree deletes metadata without unnecessary Git cleanup", async () => {
  const { service, calls } = fixture();
  const result = await service.delete("task:one", { mode: "safe" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(([name]) => name), ["mark", "finalize"]);
});

test("deletion validates and cleans Worktree before deleting Session history and metadata", async () => {
  const { service, calls } = fixture({
    sessions: [{ id: "session:one" }, { id: "session:two" }],
    inspection: {
      status: "available", blocker: null,
      worktree: {
        worktreeId: "worktree:one", path: "/repo-one", branchName: "task/one",
        dirty: false, mergedIntoMain: true, aheadOfMain: 0, statusSummary: ""
      }
    }
  });

  const plan = await service.inspect("task:one");
  assert.equal(plan.associatedSessionCount, 2);
  const result = await service.delete("task:one", { mode: "safe" });

  assert.deepEqual(calls.map(([name]) => name), [
    "mark", "remove", "removed", "deleteSession", "deleteSession", "finalize"
  ]);
  assert.deepEqual(result.resources.deletedSessionIds, ["session:one", "session:two"]);
});

test("Session deletion failure stops before Worktree cleanup and remains retryable", async () => {
  const { service, calls, getItem } = fixture({ sessions: [{ id: "session:one" }] });
  service.deleteSession = async () => {
    throw Object.assign(new Error("provider unavailable"), { code: "PROVIDER_UNAVAILABLE" });
  };

  await assert.rejects(
    service.delete("task:one", { mode: "safe" }),
    (error) => error.code === "PROVIDER_UNAVAILABLE" && /请重新检查后继续清理/.test(error.message)
  );
  assert.equal(getItem().deletion_worktree_removed_at, null);
  assert.deepEqual(calls.map(([name]) => name), ["mark", "mark"]);
});

test("missing and unauthorized Tasks return explicit errors before inspection or mutation", async () => {
  // Simulate a missing record with the same Store contract used in production.
  const missingService = new TaskDeletionService({
    store: {
      getTask: () => null,
      listSessionsByTask: () => [],
      listTaskDeletionBlockingAssociations: () => ({ artifacts: [] }),
      finalizeTaskDeletion: () => {}
    },
    authorize: async () => true,
    inspectWorktree: async () => assert.fail("missing Task must not inspect a Worktree"),
    removeWorktree: async () => assert.fail("missing Task must not remove a Worktree"),
    deleteSession: async () => assert.fail("missing Task must not delete a Session"),
    handleArtifacts: async () => assert.fail("missing Task must not dispose Artifacts")
  });
  await assert.rejects(missingService.inspect("task:missing"), (error) =>
    error.code === "TASK_NOT_FOUND" && error.statusCode === 404
  );

  const unauthorized = fixture({ authorize: async () => false });
  await assert.rejects(
    unauthorized.service.delete("task:one", { mode: "safe" }, { type: "agent", id: "agent:other" }),
    (error) => error.code === "TASK_DELETE_FORBIDDEN" && error.statusCode === 403
  );
  assert.deepEqual(unauthorized.calls, []);
});

test("bound Artifacts are exposed in the plan and use the selected deletion disposition", async () => {
  const { service, calls } = fixture({
    associations: {
      artifacts: [{ artifactId: "artifact:one", title: "Acceptance evidence" }]
    },
    inspection: {
      status: "available",
      worktree: {
        worktreeId: "worktree:one", branchName: "task/one", dirty: false,
        mergedIntoMain: true, aheadOfMain: 0, statusSummary: ""
      }
    }
  });
  const plan = await service.inspect("task:one");
  assert.equal(plan.status, "safe");
  assert.deepEqual(plan.artifacts.map((artifact) => artifact.artifactId), ["artifact:one"]);
  await service.delete("task:one", { mode: "safe", artifactDisposition: "work" });
  assert.deepEqual(calls.map(([name]) => name), ["mark", "remove", "removed", "artifacts", "finalize"]);
  assert.deepEqual(calls.find(([name]) => name === "artifacts"), ["artifacts", "work"]);
});

test("retaining a Worktree bypasses Worktree-only risks and cleanup", async () => {
  const { service, calls } = fixture({
    inspection: {
      status: "available", blocker: "UNCOMMITTED_CHANGES", repositoryId: "repository:one",
      worktree: {
        worktreeId: "worktree:one", path: "/repo-one", branchName: "task/one",
        dirty: true, mergedIntoMain: false, aheadOfMain: 2, statusSummary: " M draft.txt"
      }
    }
  });
  const result = await service.delete("task:one", {
    mode: "safe", deleteWorktree: false, artifactDisposition: "retain"
  });
  assert.equal(result.ok, true);
  assert.equal(calls.some(([name]) => name === "remove"), false);
  assert.equal(calls.some(([name]) => name === "removed"), false);
});


test("parent deletion may discard Artifacts and stale code snapshots without another confirmation", async () => {
  const f = fixture({ task: { parent_task_id: "task:parent" }, associations: { artifacts: [{artifactId:"a"}] },
    inspection: { status:"available",worktree:{worktreeId:"w",path:"/new",branchName:"task/new",headOid:"new",mergedIntoMain:false,statusSummary:"?? unsaved"} } });
  await f.service.delete("task:one", {artifactDisposition:"delete",target:{taskId:"task:one",path:"/old",headOid:"old",sessionIds:[],artifactIds:[]}}, {type:"parent_session",id:"logical:parent"});
  assert.deepEqual(f.calls.find(([name])=>name==="artifacts"),["artifacts","delete"]);
  const removal=f.calls.find(([name])=>name==="remove")[1];
  assert.equal(removal.force,true);
  assert.equal(removal.target.path,"/new");
});

test("explicit stop permission must settle a busy Session before Worktree removal", async () => {
  const sessions=[{id:"s",status:"running"}];
  const f=fixture({sessions});
  let stops=0;
  f.service.stopSession=async id=>{assert.equal(id,"s");stops++;sessions[0].status="idle";};
  await f.service.delete("task:one",{stopRunning:true});
  assert.equal(stops,1);
  const stuck=fixture({sessions:[{id:"s",status:"running"}]});
  stuck.service.stopSession=async()=>{};
  await assert.rejects(stuck.service.delete("task:one",{stopRunning:true}),{code:"SESSION_BUSY"});
  assert.equal(stuck.calls.some(([name])=>name==="remove"),false);
});

for(const blocker of ["WORKTREE_LOCKED","GIT_OPERATION_IN_PROGRESS","UNRESOLVED_CONFLICTS"]) test(`explicit deletion discards ${blocker} without requiring resolution`,async()=>{
  const f=fixture({inspection:{status:"available",blocker,worktree:{worktreeId:"w",branchName:"task/test",mergedIntoMain:false}}});
  assert.equal((await f.service.delete("task:one")).ok,true);
  assert.equal(f.calls.find(([name])=>name==="remove")[1].force,true);
});

test("integration blockers expose the exact occupying job and cancellation action",async()=>{
  const f=fixture({integrationJob:{id:"job:one",status:"running",phase:"merging"}});
  f.service.cancelIntegration=async()=>{};
  const plan=await f.service.inspect("task:one");
  assert.deepEqual({id:plan.blockers[0].jobId,phase:plan.blockers[0].phase,action:plan.blockers[0].action,canResolve:plan.blockers[0].canResolve},
    {id:"job:one",phase:"merging",action:"cancelIntegration",canResolve:true});
  await assert.rejects(f.service.delete("task:one",{cancelIntegration:true}),{code:"ACTIVE_WORKTREE_INTEGRATION_JOB"});
  assert.equal(f.calls.some(([name])=>name==="remove"),false);
});


test("failed deletion retains the dispatch fence", () => {
  const store = { getTask: () => ({ deletion_status: "delete_failed" }) };
  assert.equal(worktreeDispatchBlocker(store, { logicalSession: { taskId: "task:one" } }).reason, "TASK_DELETION_IN_PROGRESS");
});

test("detached background work blocks even when the Session turn is complete", async () => {
  const f = fixture({ inspection: { status: "available", worktree: { path: "/work", worktreeId: "tree", mergedIntoMain: true } } });
  let stopped = false;
  f.service.backgroundWork = {
    inspect: async () => ({ processes: stopped ? [] : [{ pid: 123 }], canStop: true }),
    stop: async () => { stopped = true; }, cancelWakeups: () => {}
  };
  assert.equal((await f.service.inspect("task:one")).blockers[0].code, "TASK_BACKGROUND_WORK_RUNNING");
  await assert.rejects(f.service.delete("task:one"), { code: "TASK_BACKGROUND_WORK_RUNNING" });
  assert.equal((await f.service.delete("task:one", { stopRunning: true })).ok, true);
});
