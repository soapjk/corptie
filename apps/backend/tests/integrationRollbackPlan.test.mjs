import test from "node:test";
import assert from "node:assert/strict";
import { integrationRollbackTargets, classifyIntegrationRollback } from "../src/domain/integrationRollbackPlan.mjs";

const target = (id, head) => ({ worktreeId: id, path: `/${id}`, branchName: id, sourceHeadBefore: head, isMain: true });
const source = (id, result, status = "completed") => ({ worktreeId: id, sourceHeadBefore: `${id}-source`,
  mergeStatus: status, mergeMainHead: result });

test("rollback includes completed parent steps and the active main conflict, preserving source commits", () => {
  const parentItems = [target("parent", "parent-before"), source("child", "parent-merged")];
  const mainItems = [target("main", "main-before"), source("parent", null, "conflict")];
  const result = integrationRollbackTargets({ details: {
    graphExecution: { phase: "steps", steps: [{ targetWorktreeId: "parent", items: parentItems }] },
    plan: { mainWorktreeId: "main", mainPath: "/main", items: mainItems }
  } });
  assert.deepEqual(result.map(item => item.worktreeId), ["main", "parent"]);
  assert.equal(result[1].baselineHead, "parent-before");
  assert.equal(result[1].writes[0].sourceHead, "child-source");
});

test("a snapshot commit must not replace the target's actual pre-merge HEAD", () => {
  const items = [{ ...target("main", "actual-head"), commitHead: "detached-snapshot" }, source("feature", "merged")];
  const result = integrationRollbackTargets({ plan: { mainWorktreeId: "main", items } });
  assert.equal(result[0].baselineHead, "actual-head");
});

test("repeated graph checkpoints do not duplicate writes or replace the earliest baseline", () => {
  const items = [target("main", "before"), source("feature", "merged")];
  const result = integrationRollbackTargets({ details: { graphExecution: { phase: "steps", steps: [
    { targetWorktreeId: "main", items }, { targetWorktreeId: "main", items }
  ] }, plan: { mainWorktreeId: "main", items } } });
  assert.equal(result.length, 1);
  assert.equal(result[0].writes.length, 1);
  assert.equal(result[0].baselineHead, "before");
});

test("a committing graph or already-integrated sources do not invent rollback writes", () => {
  assert.deepEqual(integrationRollbackTargets({ details: { graphExecution: { phase: "committing", steps: [] },
    plan: { mainWorktreeId: "main", items: [target("main", "before"), source("feature", "old", "already_integrated")] } } }), []);
  assert.deepEqual(integrationRollbackTargets({ plan: { operationType: "sync" } }), []);
});

test("convergence rollback addresses its isolated Worktree and every already-published source", () => {
  const items = [{ ...target("main", "main-before"), convergenceStatus: "completed", mergeMainHead: "unified" },
    { ...source("feature", "unified"), path: "/feature", branchName: "feature", convergenceStatus: "completed" }];
  const result = integrationRollbackTargets({ details: {
    convergenceWorkspace: { worktreeId: "isolated", path: "/isolated", branchName: "integration/converge" },
    plan: { operationType: "converge", mainWorktreeId: "main", mainHeadBefore: "main-before", items }
  } });
  assert.deepEqual(result.map(item => item.worktreeId), ["feature", "main", "isolated"]);
  assert.equal(result[2].path, "/isolated");
  assert.equal(result[0].baselineHead, "feature-source");
});

const scope = { baselineHead: "before", writes: [
  { sourceHead: "source-a", resultHead: "merged-a", status: "completed" },
  { sourceHead: "source-b", resultHead: null, status: "conflict" }
] };
const observed = { head: "resolved", baselineIsAncestor: true, commits: [
  { head: "merged-a", parents: ["before", "source-a"] },
  { head: "resolved", parents: ["merged-a", "source-b"] }
] };

test("changed HEAD from this round's manually resolved conflict is rollback ownership evidence", () => {
  const result = classifyIntegrationRollback(scope, observed);
  assert.equal(result.mode, "restore_baseline");
  assert.deepEqual(result.ownedCommits, ["merged-a", "resolved"]);
  assert.deepEqual(result.additionalCommits, []);
});

test("external commits and published history require reviewing the additional impact", () => {
  const result = classifyIntegrationRollback(scope, { ...observed, head: "external", commits: [
    ...observed.commits, { head: "external", parents: ["resolved"] }
  ] });
  assert.equal(result.mode, "review_additional_history");
  assert.deepEqual(result.additionalCommits, ["external"]);
  assert.equal(classifyIntegrationRollback(scope, { ...observed, published: true }).mode, "review_additional_history");
});

test("real unrelated Git operations have a recovery action, and conflict edits require preservation", () => {
  assert.equal(classifyIntegrationRollback(scope, { ...observed, operation: "rebase" }).mode, "resolve_git_operation");
  const result = classifyIntegrationRollback(scope, { ...observed, operation: "merge", mergeHead: "source-b", dirty: true });
  assert.equal(result.operationOwned, true);
  assert.equal(result.requiresPreservation, true);
});

test("already restored and diverged histories are distinguished without comparing only expected HEAD", () => {
  assert.equal(classifyIntegrationRollback(scope, { head: "before" }).mode, "already_restored");
  assert.equal(classifyIntegrationRollback(scope, { head: "unrelated", baselineIsAncestor: false }).mode, "restore_diverged_baseline");
});
