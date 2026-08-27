import assert from "node:assert/strict";
import test from "node:test";
import { WorkItemDeletionService } from "../src/application/workItemDeletionService.mjs";

function fixture(options = {}) {
  let item = { id: "work_item:one", deletion_worktree_removed_at: null };
  const calls = [];
  const store = {
    getWorkItem: () => item,
    selectOne: () => options.activeStart ? { operation_id: "start:one" } : null,
    listWorkItemDeletionBlockingAssociations: () => options.associations ?? { artifacts: [] },
    markWorkItemDeletion: (...args) => calls.push(["mark", ...args]),
    markWorkItemWorktreeRemoved: (...args) => {
      calls.push(["removed", ...args]);
      item = { ...item, deletion_worktree_removed_at: "now" };
    },
    finalizeWorkItemDeletion: (...args) => {
      calls.push(["finalize", ...args]);
      if (options.finalizeError) throw options.finalizeError;
      item = null;
      return { archivedSessionIds: [] };
    }
  };
  const inspection = options.inspection ?? { status: "none", worktree: null, blocker: null };
  const service = new WorkItemDeletionService({
    store,
    authorize: async (input) => options.authorize ? options.authorize(input) : true,
    inspectWorktree: async () => inspection,
    removeWorktree: async (input) => {
      calls.push(["remove", input]);
      if (options.removeError) throw options.removeError;
      return { removed: true };
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
        worktreeId: "worktree:one", path: "/repo-one", branchName: "workitem/one",
        dirty: true, mergedIntoMain: false, aheadOfMain: 2,
        statusSummary: " M tracked.txt\n?? untracked.txt"
      }
    }
  });
  const plan = await service.inspect("work_item:one");
  assert.equal(plan.status, "risky");
  assert.deepEqual(plan.risks.map((risk) => risk.code), [
    "UNCOMMITTED_CHANGES", "UNTRACKED_FILES", "NOT_MERGED_INTO_MAIN"
  ]);
  await assert.rejects(
    service.delete("work_item:one", { mode: "safe" }),
    (error) => error.code === "WORK_ITEM_DELETE_RISK_CONFIRMATION_REQUIRED" && error.deletion.risks.length === 3
  );
});

test("force deletion requires the exact branch and cleans Worktree before metadata", async () => {
  const { service, calls } = fixture({
    inspection: {
      status: "available", blocker: "NOT_MERGED_INTO_MAIN",
      repositoryId: "repository:one",
      worktree: {
        worktreeId: "worktree:one", path: "/repo-one", branchName: "workitem/one",
        dirty: false, mergedIntoMain: false, aheadOfMain: 1, statusSummary: ""
      }
    }
  });
  await assert.rejects(
    service.delete("work_item:one", { mode: "force", acknowledgeDataLoss: true, confirmedBranchName: "wrong" }),
    (error) => error.code === "WORK_ITEM_FORCE_DELETE_CONFIRMATION_REQUIRED"
  );
  const result = await service.delete("work_item:one", {
    mode: "force", acknowledgeDataLoss: true, confirmedBranchName: "workitem/one"
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(([name]) => name), ["mark", "remove", "removed", "finalize"]);
});

test("metadata failure leaves an explicit retryable state after Worktree removal", async () => {
  const { service, calls, getItem } = fixture({
    inspection: {
      status: "available", blocker: null,
      worktree: {
        worktreeId: "worktree:one", path: "/repo-one", branchName: "workitem/one",
        dirty: false, mergedIntoMain: true, aheadOfMain: 0, statusSummary: ""
      }
    },
    finalizeError: Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" })
  });
  await assert.rejects(
    service.delete("work_item:one", { mode: "safe" }),
    (error) => error.code === "SQLITE_BUSY" && /可安全重试/.test(error.message)
  );
  assert.ok(getItem().deletion_worktree_removed_at);
  assert.equal(calls.at(-1)[0], "mark");
  assert.equal(calls.at(-1)[2], "delete_failed");
  const retryPlan = await service.inspect("work_item:one");
  assert.equal(retryPlan.worktree, null);
  assert.equal(retryPlan.status, "safe");
});

test("main and shared Worktrees can never be force deleted", async () => {
  for (const blocker of ["MAIN_WORKTREE", "SHARED_WITH_ACTIVE_WORK_ITEM"]) {
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
      service.delete("work_item:one", { mode: "force", acknowledgeDataLoss: true, confirmedBranchName: "main" }),
      (error) => error.code === "WORK_ITEM_DELETE_BLOCKED"
    );
    assert.equal(calls.some(([name]) => name === "remove"), false);
  }
});

test("WorkItem without a Worktree deletes metadata without unnecessary Git cleanup", async () => {
  const { service, calls } = fixture();
  const result = await service.delete("work_item:one", { mode: "safe" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(([name]) => name), ["mark", "finalize"]);
});

test("missing and unauthorized WorkItems return explicit errors before inspection or mutation", async () => {
  // Simulate a missing record with the same Store contract used in production.
  const missingService = new WorkItemDeletionService({
    store: {
      getWorkItem: () => null,
      listWorkItemDeletionBlockingAssociations: () => ({ artifacts: [] }),
      finalizeWorkItemDeletion: () => {}
    },
    authorize: async () => true,
    inspectWorktree: async () => assert.fail("missing WorkItem must not inspect a Worktree"),
    removeWorktree: async () => assert.fail("missing WorkItem must not remove a Worktree")
  });
  await assert.rejects(missingService.inspect("work_item:missing"), (error) =>
    error.code === "WORK_ITEM_NOT_FOUND" && error.statusCode === 404
  );

  const unauthorized = fixture({ authorize: async () => false });
  await assert.rejects(
    unauthorized.service.delete("work_item:one", { mode: "safe" }, { type: "agent", id: "agent:other" }),
    (error) => error.code === "WORK_ITEM_DELETE_FORBIDDEN" && error.statusCode === 403
  );
  assert.deepEqual(unauthorized.calls, []);
});

test("bound retained Artifacts block deletion before Worktree cleanup or metadata mutation", async () => {
  const { service, calls } = fixture({
    associations: {
      artifacts: [{ artifactId: "artifact:one", title: "Acceptance evidence" }]
    },
    inspection: {
      status: "available",
      worktree: { worktreeId: "worktree:one", branchName: "workitem/one" }
    }
  });
  const plan = await service.inspect("work_item:one");
  assert.equal(plan.status, "blocked");
  assert.equal(plan.blockers[0].code, "WORK_ITEM_HAS_BOUND_ARTIFACTS");
  assert.match(plan.blockers[0].message, /Acceptance evidence/);
  await assert.rejects(service.delete("work_item:one", { mode: "force" }), (error) =>
    error.code === "WORK_ITEM_DELETE_BLOCKED" && error.deletion.blockers[0].code === "WORK_ITEM_HAS_BOUND_ARTIFACTS"
  );
  assert.deepEqual(calls, []);
});
