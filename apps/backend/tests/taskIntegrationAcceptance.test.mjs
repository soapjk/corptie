import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { TaskIntegrationAcceptanceService } from "../src/application/taskIntegrationAcceptanceService.mjs";
import { TaskWorktreeHierarchyService } from "../src/application/taskWorktreeHierarchyService.mjs";
import { GitWorkspaceManager } from "../src/runtime/gitWorkspaceManager.mjs";
import { WorktreeIntegrationJobService } from "../src/application/worktreeIntegrationJobService.mjs";
import { WorktreeIntegrationGraph } from "../src/application/worktreeIntegrationGraph.mjs";

test("empty failed child is absent from summaries, decoration, graph, scope and acceptance",async t=>{
  const f=await fixture(t);
  const failed=f.store.createTask({workId:f.parent.work_id,title:"Failed_empty",parentTaskId:f.parent.id},{},
    {expectedParentResourceVersion:f.store.getTask(f.parent.id).resource_version});
  f.store.db.run("UPDATE tasks SET creation_state='failed' WHERE id=?",[failed.id]);
  // Production regression: startup failed while checking the parent's base,
  // before any child workspace allocation, and only released its Task claim.
  const agent=f.store.createAgent({name:"Failed_startup",role:"independentContributor"});
  const now=new Date().toISOString();
  f.store.db.run(`INSERT INTO work_session_startup_operations
    (startup_operation_id,work_id,task_id,assignee_agent_id,expected_task_version,provider_id,repository_id,
      source_session_id,idempotency_key,request_fingerprint,state,correlation_id,allocated_at,updated_at,
      error_stage,compensation_state,compensation_result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ["startup:empty-child",f.parent.work_id,failed.id,agent.agentId,1,"provider:test","repository:integration",
    "session:source","empty-child","fixture-fingerprint","failed_compensated","fixture",now,now,
    "worktree_preparation","completed",JSON.stringify({status:"completed",completedSteps:["task_claim_released"],failedStep:null})]);
  const graph=new WorktreeIntegrationGraph({store:f.store,hierarchy:f.hierarchy});
  const inspection={...await f.inspect(),mainWorktreeId:"worktree:main"};
  const notices=[];
  const built=await graph.build(inspection,[f.parentTree.worktreeId],{onNotice:notice=>notices.push(notice)});
  assert.equal(built.groups[0].childWorktreeIds.length,2);
  assert.equal(notices[0].taskId,failed.id);
  const jobs=integrationJobs(f);
  const candidate=await jobs.createCandidate("repository:integration",{operationType:"integrate",sourceWorktreeIds:[f.parentTree.worktreeId],targetWorktreeId:"worktree:main"});
  assert.equal(candidate.notices[0].taskId,failed.id);
  assert.equal(Object.hasOwn(candidate.plan,"notices"),false);
  f.store.db.run("UPDATE work_session_startup_operations SET worktree_base_context_json='{}' WHERE startup_operation_id='startup:empty-child'");
  assert.equal(f.store.readTaskDeliveryParticipation({taskIds:[failed.id]}).byTaskId.get(failed.id).participation,"uncertain");
  f.store.db.run("UPDATE work_session_startup_operations SET worktree_base_context_json=NULL WHERE startup_operation_id='startup:empty-child'");
  f.store.db.run("UPDATE git_worktrees SET created_by_startup_operation_id='startup:empty-child' WHERE worktree_id=?",[f.parentTree.worktreeId]);
  assert.equal(f.store.readTaskDeliveryParticipation({taskIds:[failed.id]}).byTaskId.get(failed.id).participation,"required");
  f.store.db.run("UPDATE git_worktrees SET created_by_startup_operation_id=NULL WHERE worktree_id=?",[f.parentTree.worktreeId]);
  assert.equal(f.store.hierarchySummaries([f.parent.id]).get(f.parent.id).childCount,2);
  const assessment=await f.acceptance.graph(f.parent.id,{requireIncluded:false});
  assert.equal(assessment.children.length,2);
  graph.assertFresh(built);
  f.store.upsertSession({id:"session:failed-child-history",title:"History",provider:"provider:test",status:"complete",workId:f.parent.work_id,taskId:failed.id});
  assert.throws(()=>graph.assertFresh(built),{code:"TASK_HIERARCHY_CHANGED"});
  const strict=new TaskWorktreeHierarchyService({store:f.store});
  assert.throws(()=>strict.resolveTaskDelivery(failed.id,{allowAdoption:false}),cause=>{
    assert.equal(cause.diagnosis.taskId,failed.id);
    assert.equal(cause.diagnosis.parentTaskId,f.parent.id);
    return cause.code==="PARENT_WORKTREE_REQUIRED";
  });
  const resolve=f.hierarchy.resolveTaskDelivery;
  f.hierarchy.resolveTaskDelivery=(id,options)=>id===failed.id ? strict.resolveTaskDelivery(id,options) : resolve(id,options);
  await assert.rejects(()=>jobs.createCandidate("repository:integration",{operationType:"integrate",sourceWorktreeIds:[f.parentTree.worktreeId],targetWorktreeId:"worktree:main"}),
    cause=>cause.code==="PARENT_WORKTREE_REQUIRED" && cause.diagnosis.taskId===failed.id);
});

test("a parent with only an empty failed child uses ordinary merge and rejects revival",async t=>{
  const f=await fixture(t);
  for(const child of f.children) {
    f.store.db.run("DELETE FROM task_delivery_worktrees WHERE task_id=?",[child.id]);
    f.store.db.run("UPDATE tasks SET creation_state='failed' WHERE id=?",[child.id]);
  }
  const inspection={...await f.inspect(),mainWorktreeId:"worktree:main"};
  const graph=new WorktreeIntegrationGraph({store:f.store,hierarchy:f.hierarchy});
  const notices=[];
  const built=await graph.build(inspection,[f.parentTree.worktreeId],{onNotice:notice=>notices.push(notice)});
  assert.equal(built.groups.length,0);
  assert.deepEqual(built.steps.map(step=>step.kind),["merge"]);
  assert.equal(notices.length,2);
  assert.equal(f.acceptance.required(f.store.getTask(f.parent.id)),false);
  f.store.assertStandaloneWorktreeMutation({worktreeIds:[f.parentTree.worktreeId]});
  graph.assertFresh(built);
  f.store.db.run("UPDATE tasks SET creation_state='ready' WHERE id=?",[f.children[0].id]);
  assert.throws(()=>graph.assertFresh(built),{code:"TASK_HIERARCHY_CHANGED"});
  assert.throws(()=>f.store.assertStandaloneWorktreeMutation({worktreeIds:[f.parentTree.worktreeId]}),{code:"TASK_HIERARCHY_SCOPE_REQUIRED"});
  const plan={orchestration:built,reservedWorktreeIds:[f.parentTree.worktreeId],writeWorktreeIds:[f.parentTree.worktreeId]};
  const job=f.store.createWorktreeIntegrationJob({repositoryId:"repository:integration",status:"running",planFingerprint:"fixture:ordinary",details:{plan}});
  assert.throws(()=>f.store.assertStandaloneWorktreeMutation({worktreeIds:[f.parentTree.worktreeId],jobId:job.id}),{code:"TASK_HIERARCHY_SCOPE_REQUIRED"});
});

const exec = promisify(execFile);
const git = async (path, args) => (await exec("git", ["-C", path, ...args], {
  encoding: "utf8", timeout: 15000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }
})).stdout.trim();

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "corptie-integration-acceptance-"));
  const store = new CorptieStore({ dbPath: ":memory:", configPath: join(directory, "config.json"), manageProcessEnvironment: false });
  await store.initialize({ resolveDataPath: false });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const mainPath = join(directory, "main");
  await mkdir(mainPath);
  await git(mainPath, ["init", "-b", "main"]);
  await git(mainPath, ["config", "user.name", "Integration Fixture"]);
  await git(mainPath, ["config", "user.email", "integration@example.invalid"]);
  await git(mainPath, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(mainPath, "base.txt"), "base\n");
  await git(mainPath, ["add", "base.txt"]);
  await git(mainPath, ["commit", "-m", "Initial"]);
  const baseHead = await git(mainPath, ["rev-parse", "HEAD"]);
  const commonDir = await git(mainPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  store.createWorkspace({ workspaceId: "workspace:integration", kind: "linkedLocal", ownership: "userManaged", rootPath: mainPath });
  const now = new Date().toISOString();
  store.db.run(`INSERT INTO git_repositories (repository_id,workspace_id,common_git_dir,discovered_at,last_validated_at)
    VALUES (?,?,?,?,?)`, ["repository:integration", "workspace:integration", commonDir, now, now]);
  store.db.run(`INSERT INTO git_worktrees
    (worktree_id,repository_id,path,canonical_path,availability,inventory_version,observed_at,branch_name,is_main)
    VALUES (?,?,?,?,?,?,?,?,1)`, ["worktree:main","repository:integration",mainPath,mainPath,"available","fixture:1",now,"main"]);
  const entities = new WorkApplicationService({ store });
  const agent = store.createAgent({ name: "Integration", role: "independentContributor" });
  const work = entities.createWork({ name: "Integration", workspaceId: "workspace:integration", contributorAgentIds: [agent.agentId] });
  const parent = store.createTask({ workId: work.id, title: "Parent", acceptanceCriteria: "Combined changes pass" });
  const children = ["Child_one", "Child_two"].map(title => store.createTask({ workId: work.id, title, parentTaskId: parent.id }, {}, {
    expectedParentResourceVersion: store.getTask(parent.id).resource_version
  }));
  const trees = new Map();
  for (const [index, task] of [parent, ...children].entries()) {
    const path = join(directory, `tree-${index}`), branchName = `delivery-${index}`, worktreeId = `worktree:delivery-${index}`;
    await git(mainPath, ["worktree", "add", "-b", branchName, path, baseHead]);
    // Startup allocation proof is a separate tested boundary. This fixture binds
    // proven allocations directly so these tests exercise real Git freshness,
    // immutable acceptance storage, and operation direction without a Provider.
    store.db.run(`INSERT INTO task_delivery_worktrees
      (task_id,repository_id,worktree_id,startup_operation_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    [task.id, "repository:integration", worktreeId, `startup:${index}`, now, now]);
    store.db.run(`INSERT INTO git_worktrees
      (worktree_id,repository_id,path,canonical_path,availability,inventory_version,observed_at,branch_name)
      VALUES (?,?,?,?,?,?,?,?)`, [worktreeId,"repository:integration",path,path,"available","fixture:1",now,branchName]);
    trees.set(task.id, { worktreeId, repositoryId: "repository:integration", path, canonicalPath: path,
      branchName, availability: "available", isMain: false, isDetached: false });
  }
  const resolve = taskId => ({ task: store.getTask(taskId), binding: store.getTaskDeliveryBinding(taskId), inventory: trees.get(taskId) });
  const acceptance = new TaskIntegrationAcceptanceService({ store, execGit: git });
  acceptance.delivery.resolveTaskDelivery = resolve;
  entities.integrationAcceptance = acceptance;
  const hierarchy = new TaskWorktreeHierarchyService({ store, execGit: git });
  hierarchy.resolveTaskDelivery = resolve;
  const parentTree = trees.get(parent.id);
  const scope = action => ({ version: 1, rootTaskId: parent.id, action,
    expectedHierarchyRevision: store.getTask(parent.id).hierarchy_revision, expectedBindingRevision: 1 });
  const inspect = async () => ({ repositoryId: "repository:integration", worktrees: [
    { worktreeId: "worktree:main", path: mainPath, branchName: "main", isMain: true, headOid: await git(mainPath, ["rev-parse", "HEAD"]) },
    ...await Promise.all([...trees.values()].map(async tree => ({ ...tree, headOid: await git(tree.path, ["rev-parse", "HEAD"]) })))
  ] });
  const commit = async (task, name, contents = name) => {
    const path = trees.get(task.id).path;
    await writeFile(join(path, name), contents);
    await git(path, ["add", name]); await git(path, ["commit", "-m", `Change ${name}`]);
    return git(path, ["rev-parse", "HEAD"]);
  };
  const integrate = async () => {
    for (const child of children) await git(parentTree.path, ["merge", "--no-ff", "--no-edit", await git(trees.get(child.id).path, ["rev-parse", "HEAD"])]);
  };
  const capture = requestId => acceptance.captureSnapshot(parent.id, { requestId,
    expectedHierarchyRevision: store.getTask(parent.id).hierarchy_revision, expectedBindingRevision: 1 });
  return { store, entities, parent, children, trees, mainPath, baseHead, parentTree, acceptance, hierarchy, scope, inspect, commit, integrate, capture };
}

function integrationJobs(f, { beforeMerge = null } = {}) {
  const manager = new GitWorkspaceManager({ store: f.store });
  const inspect = async () => {
    const inspection = await f.inspect();
    const worktrees = await Promise.all(inspection.worktrees.map(async tree => {
      const statusSummary = await git(tree.path, ["status", "--porcelain=v1"]);
      const conflictFiles = (await git(tree.path, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
      return { ...tree, availability: "available", statusSummary, dirty: Boolean(statusSummary),
        operationState: await manager.integrationOperationState(tree.path), conflictFiles,
        changedFiles: [], isLocked: false, isPrunable: false, isDetached: false,
        aheadOfMain: tree.isMain ? 0 : 1, behindMain: 0, mergedIntoMain: false, sessions: [] };
    }));
    return { ...inspection, inventoryVersion: "fixture:1", mainWorktreeId: "worktree:main", mainPath: f.mainPath,
      mainHeadOid: worktrees.find(tree => tree.isMain).headOid, worktrees };
  };
  const unused = async () => assert.fail("Clean parent-scoped operations must not auto-commit, spawn Sessions, or alter protection policy");
  const jobs = new WorktreeIntegrationJobService({ store: f.store, inspectRepository: inspect,
    inspectCommitProtection: unused, commitChanges: unused, inspectCommitPolicyFiles: unused,
    ignoreCommitPolicyFile: unused, deleteCommitPolicyFile: unused, convertCommitPolicyFileToArtifact: unused,
    allowCommitPolicyFileTracking: unused, recoverGitOperation: unused,
    mergeSource: async input => { if (beforeMerge) await beforeMerge(input); return manager.mergeIntegrationSource(input); },
    abortMerge: input => manager.abortIntegrationMerge(input),
    rebaseSource: input => manager.rebaseIntegrationSource(input),
    inspectSyncWorktree: async ({ item }) => (await inspect()).worktrees.find(tree => tree.worktreeId === item.worktreeId),
    prepareConflictResolution: unused, inspectConflictResolution: unused, launchConflictResolution: unused });
  jobs.hierarchy = f.hierarchy;
  jobs.integrationGraph.hierarchy = f.hierarchy;
  jobs.integrationGraph.acceptance = f.acceptance;
  return jobs;
}

async function startGraph(f, jobs, sources) {
  const options = { operationType: "integrate", sourceWorktreeIds: sources, targetWorktreeId: "worktree:main" };
  const candidate = await jobs.createCandidate("repository:integration", options);
  const job = await jobs.startCandidate("repository:integration", { ...options, candidateId: candidate.id,
    candidateFingerprint: candidate.planFingerprint, idempotencyKey: `graph:${candidate.id}` });
  return { candidate, job };
}

async function acceptWaitingParent(f) {
  const snapshot = await f.capture(`snapshot:graph-acceptance:${await git(f.parentTree.path, ["rev-parse", "HEAD"])}`);
  f.store.upsertSession({ id: "session:graph-verifier", title: "Verifier", provider: "provider:test", status: "complete", workId: f.parent.work_id, taskId: f.parent.id });
  await f.entities.recordAcceptanceAssessment(f.parent.id, { sourceSessionId: "session:graph-verifier", integrationSnapshotId: snapshot.snapshotId,
    results: [{ criterion: "Combined changes pass", verdict: "passed", evidence: [{ summary: "Exact integrated code verified", reference: `commit:${snapshot.parentHeadOid}` }] }] });
  return snapshot;
}

async function addStandalone(f, name) {
  const path = join(f.mainPath, "..", name), worktreeId = `worktree:${name}`;
  await git(f.mainPath, ["worktree", "add", "-b", name, path, f.baseHead]);
  const now = new Date().toISOString();
  f.store.db.run(`INSERT INTO git_worktrees (worktree_id,repository_id,path,canonical_path,availability,inventory_version,observed_at,branch_name)
    VALUES (?,?,?,?,?,?,?,?)`, [worktreeId, "repository:integration", path, path, "available", "fixture:1", now, name]);
  f.trees.set(name, { worktreeId, repositoryId: "repository:integration", path, canonicalPath: path, branchName: name,
    availability: "available", isMain: false, isDetached: false });
  await f.commit({ id: name }, `${name}.txt`);
  return { path, worktreeId };
}

test("ordinary subset integration ignores an unrelated dirty parent and leaves unselected standalone sources untouched", async t => {
  const f = await fixture(t);
  const selected = await addStandalone(f, "selected"), unselected = await addStandalone(f, "unselected");
  await writeFile(join(f.parentTree.path, "unrelated-dirty.txt"), "Do not commit this\n");
  const jobs = integrationJobs(f);
  const { candidate, job } = await startGraph(f, jobs, [selected.worktreeId]);
  assert.equal(candidate.plan.blockingRisks.length, 0);
  assert.equal(candidate.plan.orchestration.groups.length, 0);
  assert.deepEqual(candidate.plan.items.map(item => item.worktreeId).sort(), ["worktree:main", selected.worktreeId].sort());
  const completed = await waitForTerminal(jobs, job.id);
  assert.equal(completed.status, "completed", completed.error);
  const names = await git(f.mainPath, ["ls-tree", "--name-only", "HEAD"]);
  assert.ok(names.includes("selected.txt"));
  assert.equal(names.includes("unselected.txt"), false);
  assert.equal(await git(unselected.path, ["status", "--porcelain"]), "");
  assert.ok((await git(f.parentTree.path, ["status", "--porcelain"])).includes("unrelated-dirty.txt"));
});

test("mixed integration preserves a main advance inside the plan, accepts the parent then merges standalone sources", async t => {
  const f = await fixture(t);
  const ordinary = await addStandalone(f, "ordinary-mixed");
  await f.commit(f.children[0], "mixed-child.txt");
  await writeFile(join(f.mainPath, "new-main.txt"), "main advance\n");
  await git(f.mainPath, ["add", "new-main.txt"]); await git(f.mainPath, ["commit", "-m", "Main baseline advance"]);
  const jobs = integrationJobs(f);
  const { job } = await startGraph(f, jobs, [f.parentTree.worktreeId, ordinary.worktreeId]);
  const waiting = await waitForTerminal(jobs, job.id);
  assert.equal(waiting.phase, "awaiting_integration_acceptance", waiting.error);
  assert.ok((await git(f.parentTree.path, ["ls-tree", "--name-only", "HEAD"])).includes("new-main.txt"));
  await acceptWaitingParent(f);
  jobs.retry(job.id);
  const completed = await waitForTerminal(jobs, job.id);
  assert.equal(completed.status, "completed", completed.error);
  const names = await git(f.mainPath, ["ls-tree", "--name-only", "HEAD"]);
  assert.ok(names.includes("new-main.txt") && names.includes("mixed-child.txt") && names.includes("ordinary-mixed.txt"));
});

test("graph merge conflict can be completed manually and retry skips earlier work without resetting", async t => {
  const f = await fixture(t);
  await f.commit(f.parent, "shared-graph.txt", "parent\n");
  await f.commit(f.children[0], "shared-graph.txt", "child\n");
  const jobs = integrationJobs(f);
  const { job } = await startGraph(f, jobs, [f.parentTree.worktreeId]);
  const conflicted = await waitForTerminal(jobs, job.id);
  assert.equal(conflicted.phase, "conflict", conflicted.error);
  assert.ok(conflicted.plan.items.some(item => item.conflictFiles.includes("shared-graph.txt")));
  await writeFile(join(f.parentTree.path, "shared-graph.txt"), "parent and child\n");
  await git(f.parentTree.path, ["add", "shared-graph.txt"]);
  await git(f.parentTree.path, ["commit", "--no-edit"]);
  jobs.retry(job.id);
  const waiting = await waitForTerminal(jobs, job.id);
  assert.equal(waiting.phase, "awaiting_integration_acceptance", waiting.error);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
  await acceptWaitingParent(f);
  jobs.retry(job.id);
  const completed = await waitForTerminal(jobs, job.id);
  assert.equal(completed.status, "completed", completed.error);
  assert.equal(await git(f.mainPath, ["show", "HEAD:shared-graph.txt"]), "parent and child");
});

test("integration graph expands a selected child, integrates dependencies, waits for exact acceptance and publishes once", async t => {
  const f = await fixture(t);
  await f.commit(f.children[0], "graph-one.txt");
  await f.commit(f.children[1], "graph-two.txt");
  const jobs = integrationJobs(f);
  const { candidate, job } = await startGraph(f, jobs, [f.trees.get(f.children[0].id).worktreeId]);
  assert.equal(candidate.plan.orchestration.addedWorktreeIds.length, 2);
  assert.deepEqual(candidate.plan.orchestration.steps.map(step => step.kind), ["merge_children", "merge_main_into_parent", "acceptance", "promote_parent"]);
  const waiting = await waitForTerminal(jobs, job.id);
  assert.equal(waiting.phase, "awaiting_integration_acceptance", waiting.error);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
  assert.equal(waiting.graphExecution.steps[0].status, "completed");
  assert.equal(waiting.graphExecution.steps[1].status, "completed");
  assert.equal((await git(f.parentTree.path, ["ls-tree", "--name-only", "HEAD"])).includes("graph-two.txt"), true);
  assert.throws(() => f.store.assertStandaloneWorktreeMutation({ paths: [f.parentTree.path] }), { code: "TASK_HIERARCHY_SCOPE_REQUIRED" });
  const snapshot = await acceptWaitingParent(f);
  jobs.retry(job.id);
  const completed = await waitForTerminal(jobs, job.id);
  assert.equal(completed.status, "completed", completed.error);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), snapshot.parentHeadOid);
  assert.equal(completed.graphExecution.steps.every(step => step.status === "completed"), true);
  assert.equal(completed.audit.filter(event => event.event === "integration_graph_step_started" && event.kind === "merge_children").length, 1);
  assert.notEqual(f.store.getTask(f.parent.id).lifecycle_state, "done");
});

test("integration graph cancellation preserves completed child merges and never aborts or publishes main", async t => {
  const f = await fixture(t);
  await f.commit(f.children[0], "cancel-preserved.txt");
  const jobs = integrationJobs(f);
  const { job } = await startGraph(f, jobs, [f.parentTree.worktreeId]);
  const waiting = await waitForTerminal(jobs, job.id);
  assert.equal(waiting.phase, "awaiting_integration_acceptance", waiting.error);
  const parentHead = await git(f.parentTree.path, ["rev-parse", "HEAD"]);
  const canceled = await jobs.cancel(job.id);
  assert.equal(canceled.status, "canceled");
  assert.equal(await git(f.parentTree.path, ["rev-parse", "HEAD"]), parentHead);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
});

for (const action of ["delete", "ignore", "artifact"]) test(`publication-time Markdown ${action} commits the decision and requires fresh parent acceptance before main changes`, async t => {
  const f = await fixture(t);
  await f.commit(f.parent, "late-policy.md", "unapproved version\n");
  const jobs = integrationJobs(f), manager = new GitWorkspaceManager({ store: f.store });
  jobs.inspectCommitPolicyFiles = input => manager.inspectIntegrationMarkdownFiles(input);
  jobs.deleteCommitPolicyFile = input => manager.deleteIntegrationMarkdownFile(input);
  jobs.ignoreCommitPolicyFile = input => manager.ignoreIntegrationMarkdownFile(input);
  let importedContent = null;
  // Artifact import/ownership is covered by the Artifact service/composition
  // tests; this fixture exercises the graph's exact decision and recommit.
  jobs.convertCommitPolicyFileToArtifact = async input => {
    importedContent = (await manager.readIntegrationMarkdownFile(input)).content.toString("utf8");
    await manager.deleteIntegrationMarkdownFile(input);
    return { artifactId: "artifact:graph-policy-fixture" };
  };
  jobs.inspectCommitProtection = async () => ({ protectedPaths: [], localSymlinkPaths: [], warningEnabled: false, requiresDecision: false });
  jobs.commitChanges = input => manager.commitIntegrationChanges(input);
  const { job } = await startGraph(f, jobs, [f.parentTree.worktreeId]);
  assert.equal((await waitForTerminal(jobs, job.id)).phase, "awaiting_integration_acceptance");
  const oldSnapshot = await acceptWaitingParent(f);
  jobs.retry(job.id);
  const policy = await waitForTerminal(jobs, job.id);
  assert.equal(policy.phase, "awaiting_commit_policy_resolution", policy.error);
  assert.deepEqual(policy.commitPolicyBlocker.files.map(file => file.path), ["late-policy.md"]);
  await jobs.resolveCommitPolicy(job.id, { blockerId: policy.commitPolicyBlocker.id, version: policy.commitPolicyBlocker.version,
    decisions: [{ path: "late-policy.md", action }] });
  const waiting = await waitForTerminal(jobs, job.id);
  assert.equal(waiting.phase, "awaiting_integration_acceptance", waiting.error);
  assert.equal(await git(f.parentTree.path, ["status", "--porcelain"]), "");
  assert.notEqual(await git(f.parentTree.path, ["rev-parse", "HEAD"]), oldSnapshot.parentHeadOid);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
  await acceptWaitingParent(f);
  jobs.retry(job.id);
  const completed = await waitForTerminal(jobs, job.id);
  assert.equal(completed.status, "completed", completed.error);
  assert.equal((await git(f.mainPath, ["ls-tree", "--name-only", "HEAD"])).includes("late-policy.md"), false);
  if (action === "artifact") assert.equal(importedContent, "unapproved version\n");
  if (action === "ignore") assert.ok((await git(f.mainPath, ["show", "HEAD:.gitignore"])).includes("late-policy.md"));
});

test("integration graph detects hierarchy changes and does not silently add a new child", async t => {
  const f = await fixture(t);
  const jobs = integrationJobs(f);
  const { job } = await startGraph(f, jobs, [f.parentTree.worktreeId]);
  await waitForTerminal(jobs, job.id);
  assert.throws(() => f.store.createTask({ workId: f.parent.work_id, title: "New_child", parentTaskId: f.parent.id }, {}, { expectedParentResourceVersion: f.store.getTask(f.parent.id).resource_version }), { code: "TASK_HIERARCHY_BUSY" });
  // Simulate an external revision change independently of the guarded API.
  f.store.bumpHierarchyRevision(f.parent.id);
  jobs.retry(job.id);
  const blocked = await waitForTerminal(jobs, job.id);
  assert.equal(blocked.status, "paused");
  assert.equal(blocked.audit.at(-1).code, "TASK_HIERARCHY_CHANGED");
  assert.ok(blocked.availableActions.includes("repreflight"));
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
});

test("a multi-stage graph cannot rewrite a completed parent delivery", async t => {
  const f = await fixture(t), jobs = integrationJobs(f);
  const getTask = f.store.getTask.bind(f.store);
  f.store.getTask = id => {
    const task = getTask(id);
    return id === f.parent.id ? { ...task, lifecycle_state: "done" } : task;
  };
  await assert.rejects(() => jobs.createCandidate("repository:integration", { operationType: "integrate",
    sourceWorktreeIds: [f.parentTree.worktreeId], targetWorktreeId: "worktree:main" }), { code: "TASK_PARENT_UNAVAILABLE" });
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
});

test("graph recovery pauses without replaying completed dependencies and explicit retry resumes acceptance", async t => {
  const f = await fixture(t);
  await f.commit(f.children[0], "restart-preserved.txt");
  const jobs = integrationJobs(f);
  const { job } = await startGraph(f, jobs, [f.parentTree.worktreeId]);
  await waitForTerminal(jobs, job.id);
  const parentHead = await git(f.parentTree.path, ["rev-parse", "HEAD"]);
  f.store.updateWorktreeIntegrationJob(job.id, { status: "running", phase: "step_running" });
  const restarted = integrationJobs(f);
  await restarted.recover();
  const recovered = restarted.get(job.id);
  assert.equal(recovered.phase, "recovery_required");
  assert.equal(recovered.status, "paused");
  assert.equal(await git(f.parentTree.path, ["rev-parse", "HEAD"]), parentHead);
  restarted.retry(job.id);
  const waiting = await waitForTerminal(restarted, job.id);
  assert.equal(waiting.phase, "awaiting_integration_acceptance", waiting.error);
  assert.equal(waiting.audit.filter(entry => entry.event === "integration_graph_step_started" && entry.kind === "merge_children").length, 1);
  await acceptWaitingParent(f);
  restarted.retry(job.id);
  assert.equal((await waitForTerminal(restarted, job.id)).status, "completed");
});

test("canceling a graph conflict preserves the exact conflicted parent instead of aborting it", async t => {
  const f = await fixture(t);
  await f.commit(f.parent, "cancel-conflict.txt", "parent\n");
  await f.commit(f.children[0], "cancel-conflict.txt", "child\n");
  const jobs = integrationJobs(f);
  const { job } = await startGraph(f, jobs, [f.parentTree.worktreeId]);
  const paused = await waitForTerminal(jobs, job.id);
  assert.equal(paused.phase, "conflict", paused.error);
  const mergeHead = await git(f.parentTree.path, ["rev-parse", "MERGE_HEAD"]);
  const canceled = await jobs.cancel(job.id);
  assert.equal(canceled.phase, "canceled_conflict_preserved");
  assert.equal(await git(f.parentTree.path, ["rev-parse", "MERGE_HEAD"]), mergeHead);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
});

async function waitForTerminal(jobs, id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const job = jobs.get(id);
    if (["completed", "paused", "canceled"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Integration job ${id} did not settle`);
}

test("child merge and synchronization reserve the right write side and never target main", async t => {
  const f = await fixture(t), childIds = f.children.map(child => f.trees.get(child.id).worktreeId);
  const input = { operationType: "merge", sourceWorktreeIds: childIds, targetWorktreeId: f.parentTree.worktreeId, taskScope: f.scope("merge_children") };
  const merge = await f.hierarchy.resolveOperationScope("repository:integration", input, await f.inspect());
  assert.deepEqual(merge.writeWorktreeIds, [f.parentTree.worktreeId]);
  const sync = await f.hierarchy.resolveOperationScope("repository:integration", { ...input, operationType: "sync", taskScope: f.scope("sync_children") }, await f.inspect());
  assert.deepEqual(sync.writeWorktreeIds, childIds);
  assert.equal(sync.syncStrategy, "rebase");
  const inspection = await f.inspect();
  await assert.rejects(() => f.hierarchy.resolveOperationScope("repository:integration", { ...input, targetWorktreeId: "worktree:main" }, inspection), { code: "CHILD_TARGET_NOT_PARENT" });
  await assert.rejects(() => f.hierarchy.resolveOperationScope("repository:integration", { ...input, taskScope: { ...input.taskScope, expectedHierarchyRevision: 0 } }, inspection), { code: "TASK_HIERARCHY_CHANGED" });
  assert.throws(() => f.store.assertStandaloneWorktreeMutation({ worktreeIds: childIds }), { code: "TASK_HIERARCHY_SCOPE_REQUIRED" });
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
});

test("snapshot requires all committed children, is immutable, and never itself grants acceptance", async t => {
  const f = await fixture(t);
  await f.commit(f.children[0], "one.txt"); await f.commit(f.children[1], "two.txt");
  await assert.rejects(() => f.capture("snapshot:before-merge"), { code: "CHILDREN_NOT_INTEGRATED" });
  await f.integrate();
  const snapshot = await f.capture("snapshot:after-merge");
  assert.equal(snapshot.children.length, 2);
  assert.ok(snapshot.children.every(child => child.includedInParent));
  assert.deepEqual(await f.capture("snapshot:after-merge"), snapshot);
  assert.equal((await f.acceptance.readStatus(f.parent.id)).canPromote, false);
  assert.throws(() => f.store.db.run("UPDATE task_integration_snapshots SET scope_hash='forged' WHERE snapshot_id=?", [snapshot.snapshotId]), /IMMUTABLE/);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
});

test("sync mutates only child while parent and main remain byte-identical", async t => {
  const f = await fixture(t), child = f.children[0], tree = f.trees.get(child.id);
  const parentHead = await f.commit(f.parent, "parent.txt");
  const childHead = await f.commit(child, "child.txt");
  const inspection = await f.inspect();
  const plan = await f.hierarchy.resolveOperationScope("repository:integration", {
    operationType: "sync", sourceWorktreeIds: [tree.worktreeId], targetWorktreeId: f.parentTree.worktreeId,
    taskScope: f.scope("sync_children")
  }, inspection);
  const job = f.store.createWorktreeIntegrationJob({ repositoryId: "repository:integration", status: "running", planFingerprint: "fixture:sync", details: { plan } });
  assert.doesNotThrow(() => f.store.assertStandaloneWorktreeMutation({ paths: [tree.path], readPaths: [f.parentTree.path], jobId: job.id }));
  assert.throws(() => f.store.assertStandaloneWorktreeMutation({ paths: [f.parentTree.path], jobId: job.id }), { code: "TASK_HIERARCHY_SCOPE_REQUIRED" });
  const manager = new GitWorkspaceManager({ store: f.store });
  const result = await manager.rebaseIntegrationSource({ path: tree.path, expectedSourceHead: childHead,
    targetHead: parentHead, syncStrategy: plan.syncStrategy, jobId: job.id });
  assert.equal(result.rebased, true);
  await git(tree.path, ["merge-base", "--is-ancestor", parentHead, "HEAD"]);
  assert.equal(await git(f.parentTree.path, ["rev-parse", "HEAD"]), parentHead);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
});

test("child conflict remains in parent for explicit recovery and does not advance main", async t => {
  const f = await fixture(t), child = f.children[0], tree = f.trees.get(child.id);
  const parentHead = await f.commit(f.parent, "base.txt", "parent version\n");
  const childHead = await f.commit(child, "base.txt", "child version\n");
  const plan = await f.hierarchy.resolveOperationScope("repository:integration", {
    operationType: "merge", sourceWorktreeIds: [tree.worktreeId], targetWorktreeId: f.parentTree.worktreeId,
    taskScope: f.scope("merge_children")
  }, await f.inspect());
  const job = f.store.createWorktreeIntegrationJob({ repositoryId: "repository:integration", status: "running", planFingerprint: "fixture:conflict", details: { plan } });
  const manager = new GitWorkspaceManager({ store: f.store });
  await assert.rejects(() => manager.mergeIntegrationSource({ mainPath: f.parentTree.path,
    sourcePath: tree.path, sourceHead: childHead, expectedMainHead: parentHead, jobId: job.id }), { code: "MERGE_CONFLICT" });
  assert.equal(await git(f.parentTree.path, ["rev-parse", "MERGE_HEAD"]), childHead);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
  assert.equal(await git(tree.path, ["rev-parse", "HEAD"]), childHead);
  await assert.rejects(() => manager.abortIntegrationMerge({ mainPath:f.parentTree.path,sourceHead:childHead,expectedMainHead:parentHead }),{code:"TASK_HIERARCHY_SCOPE_REQUIRED"});
  await manager.abortIntegrationMerge({ mainPath: f.parentTree.path, sourceHead: childHead, expectedMainHead: parentHead,jobId:job.id });
  assert.equal(await git(f.parentTree.path, ["rev-parse", "HEAD"]), parentHead);
});

test("only bound-session evidence grants fresh acceptance and child changes invalidate it", async t => {
  const f = await fixture(t);
  await f.commit(f.children[0], "one.txt"); await f.commit(f.children[1], "two.txt"); await f.integrate();
  const snapshot = await f.capture("snapshot:acceptance");
  f.store.upsertSession({ id: "session:parent-verifier", title: "Verifier", provider: "provider:test", status: "complete", workId:f.parent.work_id, taskId: f.parent.id });
  f.store.upsertSession({ id: "session:child-verifier", title: "Child", provider: "provider:test", status: "complete", workId:f.parent.work_id, taskId: f.children[0].id });
  const input = { sourceSessionId: "session:parent-verifier", integrationSnapshotId: snapshot.snapshotId,
    results: [{ criterion: "Combined changes pass", verdict: "passed", evidence: [{ summary: "Integration verification passed", reference: `commit:${snapshot.parentHeadOid}` }] }] };
  await assert.rejects(() => f.entities.recordAcceptanceAssessment(f.parent.id, { ...input, sourceSessionId: "session:child-verifier" }), { code: "ACCEPTANCE_SOURCE_MISMATCH" });
  await f.entities.recordAcceptanceAssessment(f.parent.id, input);
  const passed = await f.acceptance.readStatus(f.parent.id);
  assert.equal(passed.state, "passed"); assert.equal(passed.testedHeadOid, snapshot.parentHeadOid);
  await f.acceptance.assertCompletionAllowed(f.store.getTask(f.parent.id));
  const job = f.store.createWorktreeIntegrationJob({ repositoryId: "repository:integration", status: "running", planFingerprint: "fixture:promotion",
    details: { plan: { taskScope: { ...f.scope("promote_parent"), acceptanceReceiptId: passed.receiptId },
      reservedWorktreeIds: ["worktree:main", ...[...f.trees.values()].map(tree => tree.worktreeId)], writeWorktreeIds: ["worktree:main"] } } });
  const manager = new GitWorkspaceManager({ store: f.store });
  const promoted = await manager.mergeIntegrationSource({ mainPath: f.mainPath, sourcePath: f.parentTree.path,
    sourceHead: passed.testedHeadOid, expectedMainHead: f.baseHead, mergeStrategy: "ff-only", jobId: job.id });
  assert.equal(promoted.mainHead, snapshot.parentHeadOid);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), snapshot.parentHeadOid);
  f.store.updateWorktreeIntegrationJob(job.id, { status: "completed" });
  await f.commit(f.children[0], "later.txt");
  const unintegrated = await f.acceptance.readStatus(f.parent.id);
  assert.equal(unintegrated.canPromote, false);
  assert.equal(unintegrated.reason, "CHILDREN_NOT_INTEGRATED");
  await assert.rejects(() => f.acceptance.validateSnapshotForAssessment(f.store.getTask(f.parent.id), input), { code: "CHILDREN_NOT_INTEGRATED" });
  await f.commit(f.parent, "parent-later.txt");
  await f.integrate();
  assert.equal((await f.acceptance.readStatus(f.parent.id)).state, "stale");
});

test("final promotion policy rejects unmanaged Markdown and managed runtime content without mutating main", async t => {
  const f = await fixture(t), manager = new GitWorkspaceManager({ store: f.store });
  const head = await f.commit(f.parent, "unauthorized.md", "Unapproved artifact\n");
  await assert.rejects(() => manager.assertIntegrationTreePolicy(f.mainPath, head, f.baseHead), { code: "GIT_ARTIFACT_POLICY_REJECTED" });
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
  await mkdir(join(f.parentTree.path, ".corptie"));
  await writeFile(join(f.parentTree.path, ".corptie", "private.json"), "{}");
  await git(f.parentTree.path, ["add", "-f", ".corptie/private.json"]); await git(f.parentTree.path, ["commit", "-m", "Unsafe runtime content"]);
  const unsafeHead = await git(f.parentTree.path, ["rev-parse", "HEAD"]);
  await assert.rejects(() => manager.assertIntegrationTreePolicy(f.mainPath, unsafeHead, f.baseHead), { code: "GIT_ARTIFACT_POLICY_REJECTED" });
});

test("reviewed hierarchy Job merges both children into parent then synchronizes children without writing parent or main", async t => {
  const f = await fixture(t), jobs = integrationJobs(f);
  const heads = await Promise.all(f.children.map((child, index) => f.commit(child, `child-${index}.txt`)));
  const sourceWorktreeIds = f.children.map(child => f.trees.get(child.id).worktreeId);
  const plan = await jobs.preflight("repository:integration", { operationType: "batch_merge", sourceWorktreeIds,
    targetWorktreeId: f.parentTree.worktreeId, taskScope: f.scope("merge_children") });
  assert.deepEqual(plan.plan.writeWorktreeIds, [f.parentTree.worktreeId]);
  assert.ok(plan.plan.items.every(item => item.commitStatus === "not_needed"));
  await jobs.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  const merged = await waitForTerminal(jobs, plan.id);
  assert.equal(merged.status, "completed", JSON.stringify(merged));
  const parentHead = await git(f.parentTree.path, ["rev-parse", "HEAD"]);
  for (const head of heads) await git(f.parentTree.path, ["merge-base", "--is-ancestor", head, parentHead]);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
  const sync = await jobs.preflight("repository:integration", { operationType: "one_way_sync", sourceWorktreeIds,
    targetWorktreeId: f.parentTree.worktreeId, taskScope: f.scope("sync_children") });
  assert.deepEqual(sync.plan.writeWorktreeIds, sourceWorktreeIds);
  await jobs.confirm(sync.id, { confirmed: true, planFingerprint: sync.planFingerprint });
  const synchronized = await waitForTerminal(jobs, sync.id);
  assert.equal(synchronized.status, "completed", JSON.stringify(synchronized));
  for (const child of f.children) await git(f.trees.get(child.id).path, ["merge-base", "--is-ancestor", parentHead, "HEAD"]);
  assert.equal(await git(f.parentTree.path, ["rev-parse", "HEAD"]), parentHead);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
});

test("reviewed Job rejects changed child HEAD before confirmation without changing parent", async t => {
  const f = await fixture(t), jobs = integrationJobs(f), tree = f.trees.get(f.children[0].id);
  await f.commit(f.children[0], "first.txt");
  const plan = await jobs.preflight("repository:integration", { operationType: "batch_merge", sourceWorktreeIds: [tree.worktreeId],
    targetWorktreeId: f.parentTree.worktreeId, taskScope: f.scope("merge_children") });
  const frozen = plan.plan.items.find(item => item.worktreeId === tree.worktreeId).sourceHeadBefore;
  await f.commit(f.children[0], "second.txt");
  const result = await jobs.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  assert.equal(result.phase, "plan_stale");
  assert.equal(result.plan.items.find(item => item.worktreeId === tree.worktreeId).sourceHeadBefore, frozen);
  assert.equal(await git(f.parentTree.path, ["rev-parse", "HEAD"]), f.baseHead);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
});

test("sync Job refuses changed parent baseline instead of silently rebasing onto an unreviewed commit", async t => {
  const f = await fixture(t), jobs = integrationJobs(f), child = f.children[0], tree = f.trees.get(child.id);
  await f.commit(child, "child.txt");
  await f.commit(f.parent, "reviewed-parent.txt");
  const plan = await jobs.preflight("repository:integration", { operationType: "one_way_sync", sourceWorktreeIds: [tree.worktreeId],
    targetWorktreeId: f.parentTree.worktreeId, taskScope: f.scope("sync_children") });
  const childHead = await git(tree.path, ["rev-parse", "HEAD"]);
  const changedParentHead = await f.commit(f.parent, "unreviewed-parent.txt");
  await assert.rejects(() => jobs.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint }), { code: "WORKTREE_STATE_CHANGED" });
  assert.equal(await git(tree.path, ["rev-parse", "HEAD"]), childHead);
  assert.equal(await git(f.parentTree.path, ["rev-parse", "HEAD"]), changedParentHead);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
});

test("mid-batch child change pauses the Job and preserves the successfully integrated prefix", async t => {
  const f = await fixture(t);
  await f.commit(f.children[0], "one.txt"); await f.commit(f.children[1], "two.txt");
  let moved = false;
  const jobs = integrationJobs(f, { beforeMerge: async () => {
    if (!moved) { moved = true; await f.commit(f.children[1], "unreviewed.txt"); }
  } });
  const childIds = f.children.map(child => f.trees.get(child.id).worktreeId);
  const plan = await jobs.preflight("repository:integration", { operationType: "batch_merge", sourceWorktreeIds: childIds,
    targetWorktreeId: f.parentTree.worktreeId, taskScope: f.scope("merge_children") });
  const frozenSecond = plan.plan.items.find(item => item.worktreeId === childIds[1]).sourceHeadBefore;
  await jobs.confirm(plan.id, { confirmed: true, planFingerprint: plan.planFingerprint });
  const paused = await waitForTerminal(jobs, plan.id);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  assert.equal(paused.plan.items.find(item => item.worktreeId === childIds[0]).mergeStatus, "completed");
  assert.equal(paused.plan.items.find(item => item.worktreeId === childIds[1]).sourceHeadBefore, frozenSecond);
  const unreviewedHead = await git(f.trees.get(f.children[1].id).path, ["rev-parse", "HEAD"]);
  await assert.rejects(() => git(f.parentTree.path, ["merge-base", "--is-ancestor", unreviewedHead, "HEAD"]), { code: 1 });
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
});
