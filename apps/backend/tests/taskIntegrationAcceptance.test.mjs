import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
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
import { automaticWorktreeMutationActive } from "../src/application/worktreeAutoFollowService.mjs";
import { createRuntimeAgentWorkQueue } from "../src/runtime/runtimeAgentWorkQueue.mjs";
import { ChildTaskDeliveryService } from "../src/application/childTaskDeliveryService.mjs";
import { TaskCompletionService } from "../src/application/taskCompletionService.mjs";

const exec = promisify(execFile);
const git = async (path, args) => (await exec("git", ["-C", path, ...args], {
  encoding: "utf8", timeout: 15000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" }
})).stdout.trim();

async function freezeFixtureBases(f) {
  const tree=await git(f.mainPath,["rev-parse",`${f.baseHead}^{tree}`]);
  for(const child of f.children) f.store.db.run("UPDATE task_delivery_worktrees SET base_commit_oid=?,base_tree_oid=? WHERE task_id=?",[f.baseHead,tree,child.id]);
}

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
    // This fixture registers explicit test inventory IDs. Verify the real Git
    // evidence through those IDs instead of rediscovering production hash IDs.
    inspectMainIntegrationCompletion: async input => {
      assert.equal(input.repositoryId,"repository:integration");
      assert.equal(input.targetWorktreeId,"worktree:main");
      assert.equal(input.targetPath,f.mainPath);
      assert.equal(await git(f.mainPath,["symbolic-ref","--short","HEAD"]),input.branchName);
      assert.equal(await git(f.mainPath,["rev-parse","HEAD"]),input.expectedTargetHead);
      assert.equal(await git(f.mainPath,["status","--porcelain=v1"]),"");
      assert.equal(await manager.integrationOperationState(f.mainPath),null);
      for(const head of input.requiredHeads) await git(f.mainPath,["merge-base","--is-ancestor",head,"HEAD"]);
      return {mainWorktreeId:"worktree:main",mainHead:input.expectedTargetHead,verifiedHeads:input.requiredHeads};
    },
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


async function waitForTerminal(jobs, id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const job = jobs.get(id);
    if (["completed", "paused", "canceled"].includes(job.status)
      && !jobs.activeJobs.has(id) && !jobs.dispatchSafetyChecks.has(id)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Integration job ${id} did not settle`);
}


test("accepted child delivery uses a real scoped Git Job, never main or a sibling",{timeout:20000},async t=>{
  const f=await fixture(t),child=f.children[0],tree=f.trees.get(child.id),manager=new GitWorkspaceManager({store:f.store});
  const childHead=await f.commit(child,"delivered.js","export const delivered = true;\n");
  await f.commit(f.children[1],"sibling.js","export const pending = true;\n");
  const siblingHead=await git(f.trees.get(f.children[1].id).path,["rev-parse","HEAD"]);
  const jobs=integrationJobs(f);let cleanupCount=0;
  const service=new ChildTaskDeliveryService({store:f.store,gitWorkspaces:manager,jobs,artifactService:{},deletionService:{
    requestAfterChildDelivery:async()=>{cleanupCount++;return {operation:{operationId:"delete:fixture"}};},
    resumeChildDeliveryDeletion:async()=>{},getOperation:()=>({state:"succeeded"})
  }});
  jobs.onEvent=(type,payload)=>service.onRuntimeEvent(type,payload);
  const completion=new TaskCompletionService({store:f.store});completion.childDelivery=service;
  const receipt=await completion.issueMacOSIntent(child.id,{requestId:"real:child",interactionId:"real:click",uiSurface:"task_completion_confirmation",
    displayedTaskId:child.id,displayedTaskTitle:child.title},{type:"user",id:"user:local-macos"});
  const result=await completion.completeFromMacOS(child.id,{requestId:receipt.requestId,intentToken:receipt.intentToken,idempotencyKey:"real:accept"});
  const id=result.childDelivery.operationId;
  for(let attempt=0;attempt<100;attempt++) {
    await service.inFlight.get(id);
    const op=service.repository.getOperation(id);
    if(["completed","blocked"].includes(op.state)) break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  const op=service.repository.getOperation(id);
  assert.equal(op.state,"completed",op.errorMessage);
  assert.equal(cleanupCount,1);
  await git(f.parentTree.path,["merge-base","--is-ancestor",childHead,"HEAD"]);
  assert.equal(await git(f.mainPath,["rev-parse","HEAD"]),f.baseHead);
  assert.equal(await git(f.trees.get(f.children[1].id).path,["rev-parse","HEAD"]),siblingHead);
  assert.equal(await git(tree.path,["rev-parse","HEAD"]),childHead);
});

test("native delivery preparation commits only child code, and refuses unapproved documents",{timeout:20000},async t=>{
  const f=await fixture(t),child=f.children[0],tree=f.trees.get(child.id),manager=new GitWorkspaceManager({store:f.store});
  const parentHead=await git(f.parentTree.path,["rev-parse","HEAD"]);
  const service=new ChildTaskDeliveryService({store:f.store,gitWorkspaces:manager,jobs:{},artifactService:{verifyRepositoryPromotion:async()=>false},deletionService:{},prepareProtection:async()=>{}});
  await writeFile(join(tree.path,"uncommitted.js"),"export const prepared = true;\n");
  const snapshot=await service.prepareVersion(child.id);
  assert.notEqual(snapshot.git.headOid,f.baseHead);
  assert.equal(await git(tree.path,["status","--porcelain=v1"]),"");
  assert.equal(await git(f.parentTree.path,["rev-parse","HEAD"]),parentHead);
  assert.equal(await git(f.mainPath,["rev-parse","HEAD"]),f.baseHead);
  await writeFile(join(tree.path,"unapproved.md"),"Do not silently track\n");
  await assert.rejects(()=>service.prepareVersion(child.id),{code:"GIT_ARTIFACT_POLICY_REJECTED"});
  assert.equal(await git(tree.path,["rev-parse","HEAD"]),snapshot.git.headOid);
});

test("messages admitted behind an executing integration do not prevent its next step", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const first = await addStandalone(f, "queued-first"), second = await addStandalone(f, "queued-second");
  const agent = f.store.createAgent({ name: "Queued_worker", role: "independentContributor" });
  const sessionId = "session:queued-worker";
  f.store.upsertSession({ id: sessionId, title: "Queued_worker", status: "complete", provider: "provider:test" });
  const route = f.store.createLogicalSessionRoute({ logicalSessionId: "logical:queued-worker", legacySessionId: sessionId,
    providerId: "provider:test", providerThreadId: "thread:queued-worker", bindingId: "binding:queued-worker",
    boundCwd: second.path, worktreeId: second.worktreeId, repositoryId: "repository:integration", sessionName: "Queued_worker" });
  let delivered = false;
  const jobs = integrationJobs(f, { beforeMerge: async () => {
    if (delivered) return;
    delivered = true;
    assert.equal(automaticWorktreeMutationActive(f.store, { sessionId }), true);
    f.store.createUserMessageDelivery({ deliveryId: "delivery:behind", messageId: "message:behind", sessionId,
      binding: route.activeBinding, agentId: agent.agentId, text: "arrived during merge" });
  } });
  const { job } = await startGraph(f, jobs, [first.worktreeId, second.worktreeId]);
  const result = await waitForTerminal(jobs, job.id);
  assert.equal(result.status, "completed", result.error);
  assert.equal(f.store.getMessageDelivery("delivery:behind").status, "queued");
  assert.equal(automaticWorktreeMutationActive(f.store, { sessionId }), false);
});

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

test("rollback can restore completed graph targets while source-only Worktrees remain protected", async t => {
  const f = await fixture(t);
  const child = f.children[0], tree = f.trees.get(child.id);
  const childHead = await f.commit(child, "child.txt");
  await git(f.parentTree.path, ["merge", "--no-ff", "--no-edit", childHead]);
  const parentResult = await git(f.parentTree.path, ["rev-parse", "HEAD"]);
  const parentItems = [{ ...f.parentTree, isMain: true, sourceHeadBefore: f.baseHead },
    { ...tree, sourceHeadBefore: childHead, mergeStatus: "completed", mergeMainHead: parentResult }];
  const job = f.store.createWorktreeIntegrationJob({ repositoryId: "repository:integration", status: "running",
    planFingerprint: "rollback-scope", details: { plan: {
      mainWorktreeId: "worktree:main", mainPath: f.mainPath, mainHeadBefore: f.baseHead,
      reservedWorktreeIds: ["worktree:main", ...[...f.trees.values()].map(tree => tree.worktreeId)],
      writeWorktreeIds: ["worktree:main"],
      items: [{ worktreeId: "worktree:main", path: f.mainPath, branchName: "main", sourceHeadBefore: f.baseHead, isMain: true },
        { ...f.parentTree, sourceHeadBefore: parentResult, mergeStatus: "conflict" }],
      orchestration: { version: 1, groups: [{ rootTaskId: f.parent.id,
        bindings: [f.parent, ...f.children].map(task => ({ taskId: task.id,
          worktreeId: f.trees.get(task.id).worktreeId, parentTaskId: task.parent_task_id ?? null })) }] }
    }, graphExecution: { phase: "steps", steps: [{ targetWorktreeId: f.parentTree.worktreeId, items: parentItems }] } } });
  assert.throws(() => f.store.assertStandaloneWorktreeMutation({ paths: [f.parentTree.path], jobId: job.id }),
    { code: "TASK_HIERARCHY_SCOPE_REQUIRED" });
  f.store.updateWorktreeIntegrationJob(job.id, { status: "cancellation_requested", phase: "rollback_running" });
  assert.doesNotThrow(() => f.store.assertStandaloneWorktreeMutation({ paths: [f.parentTree.path], jobId: job.id }));
  assert.throws(() => f.store.assertStandaloneWorktreeMutation({ paths: [tree.path], jobId: job.id }),
    { code: "TASK_HIERARCHY_SCOPE_REQUIRED" });
  f.store.updateWorktreeIntegrationJob(job.id, { status: "paused", phase: "rollback_review" });
  assert.throws(() => f.store.assertStandaloneWorktreeMutation({ paths: [f.parentTree.path], jobId: job.id }),
    { code: "TASK_HIERARCHY_SCOPE_REQUIRED" });
  assert.equal(await git(tree.path, ["rev-parse", "HEAD"]), childHead);
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

test("manual approval is exact-version, user-only, idempotent, never fabricates model evidence or advances main",async t=>{
  const f=await fixture(t); await freezeFixtureBases(f);
  await f.commit(f.children[0],"manual.txt"); await f.integrate();
  const user={type:"user",id:"user:local-macos"};
  const request={requestId:"manual-prepare-1",expectedHierarchyRevision:f.store.getTask(f.parent.id).hierarchy_revision,expectedBindingRevision:1};
  await assert.rejects(()=>f.acceptance.prepareUserApproval(f.parent.id,request,{type:"session",id:"session:agent"}),{code:"DIRECT_USER_INTENT_REQUIRED"});
  const intent=await f.acceptance.prepareUserApproval(f.parent.id,request,user);
  assert.equal((await f.acceptance.prepareUserApproval(f.parent.id,request,user)).confirmationToken,intent.confirmationToken);
  const input={requestId:"manual-confirm-1",snapshotId:intent.snapshotId,confirmationToken:intent.confirmationToken,acknowledgedAutomatedFailure:false};
  await assert.rejects(()=>f.acceptance.confirmUserApproval(f.parent.id,input,{type:"user",id:"user:device:other"}),{code:"USER_APPROVAL_INTENT_INVALID"});
  const before=f.store.getTask(f.parent.id);
  const results=await Promise.all([f.acceptance.confirmUserApproval(f.parent.id,input,user),f.acceptance.confirmUserApproval(f.parent.id,input,user)]);
  assert.equal(results[0].receiptId,results[1].receiptId);
  assert.equal(results[0].approvalSource,"manual_user"); assert.equal(results[0].testedHeadOid,null);
  assert.equal(results[0].canPromote,true);
  assert.equal(f.store.getTask(f.parent.id).acceptance_assessment_json,before.acceptance_assessment_json);
  assert.equal(f.store.getTask(f.parent.id).lifecycle_state,before.lifecycle_state);
  assert.equal(await git(f.mainPath,["rev-parse","HEAD"]),f.baseHead);
  await f.commit(f.parent,"changed-after-approval.txt");
  assert.equal((await f.acceptance.readStatus(f.parent.id)).state,"stale");
  assert.equal((await f.acceptance.readStatus(f.parent.id)).canPromote,true);
});

test("manual confirmation rejects a changed version, expired intent, revoked device and unacknowledged automated failure",async t=>{
  const f=await fixture(t); await freezeFixtureBases(f);
  await f.commit(f.children[0],"failure.txt"); await f.integrate();
  f.store.db.run("UPDATE tasks SET acceptance_assessment_json=? WHERE id=?",[JSON.stringify({status:"failed",results:[{verdict:"failed"}]}),f.parent.id]);
  const user={type:"user",id:"user:device:paired"};
  const intent=await f.acceptance.prepareUserApproval(f.parent.id,{requestId:"manual-failure-1",expectedHierarchyRevision:f.store.getTask(f.parent.id).hierarchy_revision,expectedBindingRevision:1},user);
  const input={requestId:"manual-failure-confirm",snapshotId:intent.snapshotId,confirmationToken:intent.confirmationToken};
  await assert.rejects(()=>f.acceptance.confirmUserApproval(f.parent.id,input,user),{code:"AUTOMATED_FAILURE_ACKNOWLEDGEMENT_REQUIRED"});
  await assert.rejects(()=>f.acceptance.confirmUserApproval(f.parent.id,{...input,acknowledgedAutomatedFailure:true},user,{revalidate:()=>{throw Object.assign(new Error("revoked"),{code:"DEVICE_REVOKED"});}}),{code:"DEVICE_REVOKED"});
  await f.commit(f.parent,"changed-before-confirm.txt");
  const historical=await f.acceptance.confirmUserApproval(f.parent.id,{...input,acknowledgedAutomatedFailure:true},user);
  assert.equal(historical.state,"stale");assert.equal(historical.canPromote,true);
  f.acceptance.now=()=>new Date("2099-01-01T00:00:00.000Z");
  await assert.rejects(()=>f.acceptance.confirmUserApproval(f.parent.id,{...input,requestId:"expired-new-request",acknowledgedAutomatedFailure:true},user),{code:"USER_APPROVAL_INTENT_EXPIRED"});
});

test("snapshots include pending children and remain immutable independent of Git capability", async t => {
  const f = await fixture(t);
  await f.commit(f.children[0], "one.txt"); await f.commit(f.children[1], "two.txt");
  const pending=await f.capture("snapshot:before-merge");
  assert.ok(pending.children.some(child=>!child.includedInParent));
  await f.integrate();
  const snapshot = await f.capture("snapshot:after-merge");
  assert.equal(snapshot.children.length, 2);
  assert.ok(snapshot.children.every(child => child.includedInParent));
  assert.deepEqual(await f.capture("snapshot:after-merge"), snapshot);
  assert.equal((await f.acceptance.readStatus(f.parent.id)).canPromote, true);
  assert.throws(() => f.store.db.run("UPDATE task_integration_snapshots SET scope_hash='forged' WHERE snapshot_id=?", [snapshot.snapshotId]), /IMMUTABLE/);
  assert.equal(await git(f.mainPath, ["rev-parse", "HEAD"]), f.baseHead);
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
  assert.equal(unintegrated.canPromote, true);
  assert.equal(unintegrated.hasUnintegratedChildren, true);
  assert.equal((await f.acceptance.validateSnapshotForAssessment(f.store.getTask(f.parent.id),input)).snapshotId,snapshot.snapshotId);
  await f.commit(f.parent, "parent-later.txt");
  await f.integrate();
  assert.equal((await f.acceptance.readStatus(f.parent.id)).state, "stale");
});

test("parent publication includes only its current branch and leaves unmerged children untouched",async t=>{
  const f=await fixture(t);await freezeFixtureBases(f);
  const parentHead=await f.commit(f.parent,"parent-only.js"),child=f.children[0];
  const childHead=await f.commit(child,"unmerged-child.js");
  const jobs=integrationJobs(f),{job,candidate}=await startGraph(f,jobs,[f.parentTree.worktreeId]);
  assert.equal(candidate.plan.orchestration.groups[0].childWorktreeIds.length,0);
  assert.ok(!candidate.plan.orchestration.steps.some(step=>step.kind==="acceptance"));
  const result=await waitForTerminal(jobs,job.id);assert.equal(result.status,"completed",result.error);
  await git(f.mainPath,["merge-base","--is-ancestor",parentHead,"HEAD"]);
  assert.equal((await git(f.mainPath,["ls-tree","--name-only","HEAD"])).includes("unmerged-child.js"),false);
  assert.equal(await git(f.trees.get(child.id).path,["rev-parse","HEAD"]),childHead);
});

test("explicit child publication includes that child and excludes unselected siblings",async t=>{
  const f=await fixture(t);await freezeFixtureBases(f);
  await f.commit(f.children[0],"selected-child.js");await f.commit(f.children[1],"pending-sibling.js");
  const jobs=integrationJobs(f),{job,candidate}=await startGraph(f,jobs,[f.trees.get(f.children[0].id).worktreeId]);
  assert.equal(candidate.plan.orchestration.addedWorktreeIds.length,1);
  const result=await waitForTerminal(jobs,job.id);assert.equal(result.status,"completed",result.error);
  const names=await git(f.mainPath,["ls-tree","--name-only","HEAD"]);
  assert.ok(names.includes("selected-child.js"));assert.ok(!names.includes("pending-sibling.js"));
  assert.ok(result.graphExecution.steps.every(step=>step.status==="completed"));
});

test("child conflict stays actionable across a normal child commit and resumes after manual resolution",async t=>{
  const f=await fixture(t),child=f.children[0],tree=f.trees.get(child.id);
  await f.commit(f.parent,"conflict.js","parent\n");await f.commit(child,"conflict.js","child\n");
  const jobs=integrationJobs(f),{job}=await startGraph(f,jobs,[tree.worktreeId]);
  const conflicted=await waitForTerminal(jobs,job.id);assert.equal(conflicted.phase,"conflict",conflicted.error);
  await writeFile(join(f.parentTree.path,"conflict.js"),"resolved\n");
  await git(f.parentTree.path,["add","conflict.js"]);await git(f.parentTree.path,["commit","--no-edit"]);
  await f.commit(child,"followup.js");
  jobs.retry(job.id);
  const completed=await waitForTerminal(jobs,job.id);assert.equal(completed.status,"completed",completed.error);
  assert.equal(await git(f.mainPath,["show","HEAD:conflict.js"]),"resolved");
  assert.ok((await git(f.mainPath,["ls-tree","--name-only","HEAD"])).includes("followup.js"));
});

test("old reviewed versions refresh automatically before execution and Task hierarchy changes do not require a new confirmation",async t=>{
  const f=await fixture(t),child=f.children[0],tree=f.trees.get(child.id),jobs=integrationJobs(f);
  const plan=await jobs.preflight("repository:integration",{operationType:"batch_merge",sourceWorktreeIds:[tree.worktreeId],
    targetWorktreeId:f.parentTree.worktreeId,taskScope:f.scope("merge_children")});
  const head=await f.commit(child,"new-after-preview.js");
  f.store.createTask({workId:f.parent.work_id,title:"Another_child",parentTaskId:f.parent.id});
  await jobs.confirm(plan.id,{confirmed:true,planFingerprint:plan.planFingerprint});
  const completed=await waitForTerminal(jobs,plan.id);assert.equal(completed.status,"completed",completed.error);
  await git(f.parentTree.path,["merge-base","--is-ancestor",head,"HEAD"]);
  assert.equal(await git(f.mainPath,["rev-parse","HEAD"]),f.baseHead);
});

test("canceling a real conflict preserves earlier merged child code and does not publish main",async t=>{
  const f=await fixture(t);await f.commit(f.parent,"shared.js","parent\n");
  const first=await f.commit(f.children[0],"first-child.js");await f.commit(f.children[1],"shared.js","child\n");
  const jobs=integrationJobs(f),{job}=await startGraph(f,jobs,f.children.map(child=>f.trees.get(child.id).worktreeId));
  const paused=await waitForTerminal(jobs,job.id);assert.equal(paused.phase,"conflict",paused.error);
  await jobs.cancel(job.id);await waitForTerminal(jobs,job.id);
  await git(f.parentTree.path,["merge-base","--is-ancestor",first,"HEAD"]);
  assert.equal(await git(f.mainPath,["rev-parse","HEAD"]),f.baseHead);
});

test("Task lifecycle can complete independently of Git acceptance while source authority stays scoped",async t=>{
  const f=await fixture(t);await f.commit(f.children[0],"pending.js");
  await f.acceptance.assertCompletionAllowed(f.store.getTask(f.parent.id));
  const status=await f.acceptance.readStatus(f.parent.id);assert.equal(status.canPromote,true);
  assert.equal(status.state,"not_recorded");assert.equal(status.hasUnintegratedChildren,true);
  const ids=f.children.map(child=>f.trees.get(child.id).worktreeId),input={operationType:"merge",sourceWorktreeIds:ids,
    targetWorktreeId:f.parentTree.worktreeId,taskScope:{...f.scope("merge_children"),expectedHierarchyRevision:1}};
  await f.hierarchy.resolveOperationScope("repository:integration",input,await f.inspect());
  const inspection=await f.inspect();
  await assert.rejects(()=>f.hierarchy.resolveOperationScope("repository:integration",{...input,targetWorktreeId:"worktree:main"},inspection),{code:"CHILD_TARGET_NOT_PARENT"});
});

for(const action of ["delete","ignore","artifact"]) test(`publication Markdown ${action} remains an actual document authorization boundary without an acceptance gate`,async t=>{
  const f=await fixture(t);await f.commit(f.parent,"policy.md","unapproved\n");
  const jobs=integrationJobs(f),manager=new GitWorkspaceManager({store:f.store});
  jobs.inspectCommitPolicyFiles=input=>manager.inspectIntegrationMarkdownFiles(input);
  jobs.deleteCommitPolicyFile=input=>manager.deleteIntegrationMarkdownFile(input);
  jobs.ignoreCommitPolicyFile=input=>manager.ignoreIntegrationMarkdownFile(input);
  jobs.convertCommitPolicyFileToArtifact=async input=>{await manager.readIntegrationMarkdownFile(input);await manager.deleteIntegrationMarkdownFile(input);return {artifactId:"artifact:policy"};};
  jobs.inspectCommitProtection=async()=>({protectedPaths:[],localSymlinkPaths:[],warningEnabled:false,requiresDecision:false});
  jobs.commitChanges=input=>manager.commitIntegrationChanges(input);
  const {job}=await startGraph(f,jobs,[f.parentTree.worktreeId]);
  const policy=await waitForTerminal(jobs,job.id);assert.equal(policy.phase,"awaiting_commit_policy_resolution",policy.error);
  await jobs.resolveCommitPolicy(job.id,{blockerId:policy.commitPolicyBlocker.id,version:policy.commitPolicyBlocker.version,
    decisions:[{path:"policy.md",action}]});
  const completed=await waitForTerminal(jobs,job.id);assert.equal(completed.status,"completed",completed.error);
  assert.ok(!(await git(f.mainPath,["ls-tree","--name-only","HEAD"])).includes("policy.md"));
});


test("new committed code after human approval is delivered under the same operation without rewriting original approval",async t=>{
  const f=await fixture(t),child=f.children[0],manager=new GitWorkspaceManager({store:f.store}),jobs=integrationJobs(f);
  let cleaned=0;
  const service=new ChildTaskDeliveryService({store:f.store,gitWorkspaces:manager,jobs,artifactService:{},deletionService:{
    requestAfterChildDelivery:async()=>{cleaned++;return {operation:{operationId:"delete:late"}};},
    resumeChildDeliveryDeletion:async()=>{},getOperation:()=>({state:"succeeded"})}});
  jobs.onEvent=(type,payload)=>service.onRuntimeEvent(type,payload);
  const completion=new TaskCompletionService({store:f.store});completion.childDelivery=service;
  const wake=service.wake;service.wake=()=>{};
  const intent=await completion.issueMacOSIntent(child.id,{requestId:"approve-before-late",interactionId:"click-late",uiSurface:"task_completion_confirmation",displayedTaskId:child.id,displayedTaskTitle:child.title},{type:"user",id:"user:local-macos"});
  const result=await completion.completeFromMacOS(child.id,{requestId:intent.requestId,intentToken:intent.intentToken,idempotencyKey:"approve-before-late"});
  const opId=result.childDelivery.operationId,approvalId=service.repository.getOperation(opId).approvalOperationId;
  const original=JSON.stringify(f.store.getTaskCompletionOperation(approvalId));
  const latest=await f.commit(child,"after-approval.js");
  service.wake=wake;await service.wake(opId);
  for(let i=0;i<100;i++){await service.inFlight.get(opId);if(["completed","blocked"].includes(service.repository.getOperation(opId).state))break;await new Promise(resolve=>setTimeout(resolve,20));}
  const final=service.repository.getOperation(opId);assert.equal(final.state,"completed",final.errorMessage);assert.equal(cleaned,1);
  await git(f.parentTree.path,["merge-base","--is-ancestor",latest,"HEAD"]);
  assert.equal(JSON.stringify(f.store.getTaskCompletionOperation(approvalId)),original);
  assert.equal(final.snapshot.git.headOid,latest);
});

test("a grandchild publishes through each immediate parent and leaves unrelated siblings unmerged",async t=>{
  const f=await fixture(t),parent=f.children[0];
  const grandchild=f.store.createTask({workId:f.parent.work_id,title:"Grandchild",parentTaskId:parent.id});
  const path=join(f.mainPath,"..","grandchild"),branch="grandchild",worktreeId="worktree:grandchild",now=new Date().toISOString();
  await git(f.mainPath,["worktree","add","-b",branch,path,await git(f.trees.get(parent.id).path,["rev-parse","HEAD"])]);
  f.store.db.run(`INSERT INTO task_delivery_worktrees(task_id,repository_id,worktree_id,startup_operation_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,[grandchild.id,"repository:integration",worktreeId,"startup:grandchild",now,now]);
  f.store.db.run(`INSERT INTO git_worktrees(worktree_id,repository_id,path,canonical_path,availability,inventory_version,observed_at,branch_name) VALUES (?,?,?,?,?,?,?,?)`,[worktreeId,"repository:integration",path,path,"available","fixture:1",now,branch]);
  f.trees.set(grandchild.id,{worktreeId,repositoryId:"repository:integration",path,canonicalPath:path,branchName:branch,availability:"available",isMain:false,isDetached:false});
  const head=await f.commit(grandchild,"grandchild.js");await f.commit(f.children[1],"sibling-pending.js");
  const jobs=integrationJobs(f),{job}=await startGraph(f,jobs,[worktreeId]);
  const completed=await waitForTerminal(jobs,job.id);assert.equal(completed.status,"completed",completed.error);
  for(const target of [f.trees.get(parent.id).path,f.parentTree.path,f.mainPath]) await git(target,["merge-base","--is-ancestor",head,"HEAD"]);
  assert.ok(!(await git(f.mainPath,["ls-tree","--name-only","HEAD"])).includes("sibling-pending.js"));
});

test("dirty merge source is captured without moving its branch or index, and dirty target changes survive",async t=>{
  const f=await fixture(t),child=f.children[0],source=f.trees.get(child.id),manager=new GitWorkspaceManager({store:f.store});
  await writeFile(join(source.path,"unsaved.js"),"export const unsaved = true;\n");
  await writeFile(join(f.parentTree.path,"base.txt"),"local parent edit\n");
  const plan=await f.hierarchy.resolveOperationScope("repository:integration",{operationType:"merge",sourceWorktreeIds:[source.worktreeId],targetWorktreeId:f.parentTree.worktreeId,taskScope:f.scope("merge_children")},await f.inspect());
  const job=f.store.createWorktreeIntegrationJob({repositoryId:"repository:integration",status:"running",planFingerprint:"dirty-snapshot",details:{plan}});
  const originalHead=await git(source.path,["rev-parse","HEAD"]),originalIndex=await git(source.path,["ls-files","--stage"]);
  const snapshot=await manager.commitIntegrationChanges({path:source.path,snapshotOnly:true,jobId:job.id});
  assert.equal(await git(source.path,["rev-parse","HEAD"]),originalHead);assert.equal(await git(source.path,["ls-files","--stage"]),originalIndex);
  const merged=await manager.mergeIntegrationSource({mainPath:f.parentTree.path,sourcePath:source.path,sourceHead:snapshot.headOid,expectedMainHead:f.baseHead,jobId:job.id});
  assert.equal(merged.merged,true);assert.equal(await git(f.parentTree.path,["show","HEAD:unsaved.js"]),"export const unsaved = true;");
  assert.equal(await readFile(join(f.parentTree.path,"base.txt"),"utf8"),"local parent edit\n");
  assert.ok((await git(f.parentTree.path,["status","--porcelain=v1"])).includes("base.txt"));
});

test("one-click graph commits dirty children to their branches before any merge", async t => {
  const f = await fixture(t);
  const manager = new GitWorkspaceManager({ store: f.store });
  const sources = f.children.map(child => f.trees.get(child.id));
  const before = await Promise.all(sources.map(source => git(source.path, ["rev-parse", "HEAD"])));
  for (const [index, source] of sources.entries()) await writeFile(join(source.path, `dirty-${index}.js`), `export const value = ${index};\n`);
  const jobs = integrationJobs(f, { beforeMerge: async () => {
    for (const source of sources) assert.equal(await git(source.path, ["status", "--porcelain=v1"]), "");
  } });
  jobs.inspectCommitProtection = async () => ({ privateFiles: [], localSymlinkPaths: [] });
  jobs.commitChanges = input => manager.commitIntegrationChanges({ ...input, snapshotOnly: false });
  const { job } = await startGraph(f, jobs, sources.map(source => source.worktreeId));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (["completed", "paused"].includes(jobs.get(job.id).status) && !jobs.activeJobs.has(job.id)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const result = jobs.get(job.id);
  assert.ok(["completed", "paused"].includes(result.status), JSON.stringify({status:result.status,phase:result.phase,error:result.error}));

  for (const [index, source] of sources.entries()) {
    const head = await git(source.path, ["rev-parse", "HEAD"]);
    assert.notEqual(head, before[index]);
    assert.equal(await git(source.path, ["status", "--porcelain=v1"]), "");
    assert.match(await git(source.path, ["show", "-s", "--format=%B", "HEAD"]), /Corptie-Integration-Job:/);
  }
});

test("graph step changes retain the plan Session and workspace and completion settles automation", async t => {
  const f = await fixture(t);
  await f.commit(f.children[0], "retained-session.js");
  let jobID;
  const checkedTargets = new Set();
  const jobs = integrationJobs(f, { beforeMerge: async input => {
    const automation = f.store.getWorktreeIntegrationJob(jobID).details.conflictAutomation;
    assert.equal(automation.sessionId, "session:plan");
    assert.equal(automation.workspaceId, "worktree:plan");
    assert.equal(automation.workspacePath, "/plan-fixed");
    checkedTargets.add(input.mainPath);
  } });
  const options = { operationType: "integrate", sourceWorktreeIds: [f.trees.get(f.children[0].id).worktreeId], targetWorktreeId: "worktree:main" };
  const candidate = await jobs.createCandidate("repository:integration", options);
  const job = await jobs.startCandidate("repository:integration", { ...options,
    candidateId: candidate.id, candidateFingerprint: candidate.planFingerprint, idempotencyKey: `retained:${candidate.id}` });
  jobID = job.id;
  const stored = f.store.getWorktreeIntegrationJob(jobID);
  f.store.updateWorktreeIntegrationJob(jobID, { details: { ...stored.details, conflictAutomation: {
    status: "running", sessionId: "session:plan", workspaceId: "worktree:plan", workspacePath: "/plan-fixed"
  } } });
  const result = await waitForTerminal(jobs, jobID);
  assert.equal(result.status, "completed", result.error);
  assert.ok(checkedTargets.size >= 2);
  assert.equal(result.conflictAutomation.sessionId, "session:plan");
  assert.equal(result.conflictAutomation.workspaceId, "worktree:plan");
  assert.equal(result.conflictAutomation.status, "completed");
});
