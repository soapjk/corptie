const coded = (code,message=code,extra={}) => Object.assign(new Error(message),{code,statusCode:409,...extra});
const identity = ["-c","user.name=Corptie","-c","user.email=snapshot@corptie.local","-c","commit.gpgsign=false"];

export function snapshotBaseForWorktree(store, worktreeId) {
  if (!store.selectOne || !worktreeId) return null;
  const row=store.selectOne(`SELECT d.*,o.worktree_base_context_json FROM task_delivery_worktrees d
    JOIN work_session_startup_operations o ON o.startup_operation_id=d.startup_operation_id
    WHERE d.worktree_id=?`,[worktreeId]);
  const original=row?.worktree_base_context_json && JSON.parse(row.worktree_base_context_json);
  return original?.kind==="parent_workspace_snapshot" ? {taskId:row.task_id,parentWorktreeId:row.base_worktree_id,
    baseCommitOid:row.base_commit_oid,baseTreeOid:row.base_tree_oid} : null;
}

async function scalar(manager,path,args) {return (await manager.gitOutput(path,args)).trim();}

// A temporary commit with an explicit parent selects S as the merge base on
// Git versions supporting merge-tree --write-tree, without touching any index.
export async function computeSnapshotMerge(manager,{path,base,ours,theirs}) {
  if (!await manager.gitSucceeds(path,["merge-base","--is-ancestor",base,theirs])) {
    throw coded("SNAPSHOT_BASE_DIVERGED","The child no longer descends from its captured baseline.");
  }
  const tree=await scalar(manager,path,["rev-parse",`${ours}^{tree}`]);
  const virtual=await scalar(manager,path,[...identity,"commit-tree",tree,"-p",base,"-m","Corptie explicit snapshot merge base"]);
  try {
    const output=await manager.gitOutput(path,["merge-tree","--write-tree",virtual,theirs]);
    return output.split(/\r?\n/)[0].trim();
  } catch(cause) {
    // Conflicts are isolated; the parent index and working directory stay intact.
    if((cause.code ?? cause.cause?.code)===1) throw coded("MERGE_CONFLICT",
      "Child changes conflict with the current parent. Resources were preserved; resolve using the snapshot baseline.",
      {snapshotBase:base,ours,theirs,cause});
    throw coded("SNAPSHOT_MERGE_UNAVAILABLE","Git could not prepare a snapshot-aware merge. No workspace was changed.",{cause});
  }
}

async function apply(manager,{path,base,ours,theirs,jobId,recovery=false}) {
  if(await manager.integrationOperationState(path)) throw coded("GIT_OPERATION_IN_PROGRESS");
  const resultTree=await computeSnapshotMerge(manager,{path,base,ours,theirs});
  const current=await scalar(manager,path,["rev-parse","HEAD"]);
  if(current!==ours) {
    const parents=(await scalar(manager,path,["rev-list","--parents","-n","1",current])).split(/\s+/).slice(1);
    if(!recovery || parents[0]!==ours || parents[1]!==theirs
      || await scalar(manager,path,["rev-parse",`${current}^{tree}`])!==resultTree) throw coded("MAIN_HEAD_CHANGED");
    return {head:current,resultTree,recovered:true};
  }
  await manager.assertIntegrationTreePolicy(path,resultTree,ours);
  const head=await scalar(manager,path,[...identity,"commit-tree",resultTree,"-p",ours,"-p",theirs,
    "-m",`Corptie snapshot integration ${jobId ?? ""}`]);
  // FF checks HEAD and refuses local overwrites. No reset/stash is used.
  if(await scalar(manager,path,["rev-parse","HEAD"])!==ours) throw coded("MAIN_HEAD_CHANGED");
  await manager.runGit(path,["merge","--autostash","--ff-only",head]);
  if(await scalar(manager,path,["rev-parse","HEAD"])!==head
    || await scalar(manager,path,["diff","--name-only","--diff-filter=U"])) throw coded("MERGE_CONFLICT");
  return {head,resultTree,recovered:false};
}

export async function mergeWorkspaceSnapshot(manager,input) {
  const base=input.snapshotBase.baseCommitOid;
  const binding=manager.store.getTaskDeliveryBinding?.(input.snapshotBase.taskId);
  if(binding && (binding.base_commit_oid!==base || binding.base_tree_oid!==input.snapshotBase.baseTreeOid)) {
    throw coded("SNAPSHOT_BASE_CHANGED","The reviewed child baseline changed; review a fresh integration plan.");
  }
  if(await scalar(manager,input.mainPath,["rev-parse",`${input.sourceHead}^{tree}`])===input.snapshotBase.baseTreeOid) {
    if(await scalar(manager,input.mainPath,["rev-parse","HEAD"])!==input.expectedMainHead) throw coded("MAIN_HEAD_CHANGED");
    if(await manager.integrationOperationState(input.mainPath)) throw coded("GIT_OPERATION_IN_PROGRESS");
    return {merged:false,alreadyMerged:true,mainHead:input.expectedMainHead,
      snapshotReceipt:{version:1,baseCommitOid:base,childHead:input.sourceHead,parentBefore:input.expectedMainHead,
        parentAfter:input.expectedMainHead,noChanges:true}};
  }
  const result=await apply(manager,{path:input.mainPath,base,ours:input.expectedMainHead,theirs:input.sourceHead,
    jobId:input.jobId,recovery:input.allowRecordedMergeRecovery});
  return {merged:true,alreadyMerged:false,recovered:result.recovered,mainHead:result.head,
    snapshotReceipt:{version:1,baseCommitOid:base,childHead:input.sourceHead,parentBefore:input.expectedMainHead,
      parentAfter:result.head,resultTree:result.resultTree}};
}

export async function prepareSnapshotConflictWorkspace(manager,input,preparation) {
  const workspace=preparation.workspace ?? preparation;
  const path=workspace.path;
  const tree=await scalar(manager,path,["rev-parse",`${input.expectedMainHead}^{tree}`]);
  const virtual=await scalar(manager,path,[...identity,"commit-tree",tree,"-p",input.expectedMainHead,
    "-p",input.snapshotBase.baseCommitOid,"-m","Corptie snapshot conflict baseline"]);
  // Only the newly allocated, clean, plan-owned conflict workspace is moved.
  await manager.runGit(path,["merge","--ff-only",virtual]);
  try { await manager.runGit(path,["merge","--no-commit","--no-ff",input.sourceHead]); }
  catch(cause) {
    if(!await manager.gitSucceeds(path,["rev-parse","--verify","MERGE_HEAD"])) throw cause;
  }
  return preparation;
}

export async function synchronizeWorkspaceSnapshot(manager,input) {
  // Replay only S -> C onto P, preserving history and advancing the delta base.
  const base=input.snapshotBase;
  const bindingBefore=manager.store.getTaskDeliveryBinding(base.taskId);
  if(bindingBefore?.base_commit_oid!==base.baseCommitOid || bindingBefore.base_tree_oid!==base.baseTreeOid) {
    if(!input.allowResolvedRebase || bindingBefore?.base_commit_oid!==input.targetHead) throw coded("SNAPSHOT_BASE_CHANGED");
  }
  let tree;
  try {
    tree=await computeSnapshotMerge(manager,{path:input.path,base:base.baseCommitOid,
      ours:input.targetHead,theirs:input.expectedSourceHead});
  } catch(error) {
    if(error.code==="MERGE_CONFLICT") error.code="REBASE_CONFLICT";
    throw error;
  }
  if(await manager.integrationOperationState(input.path)) throw coded("GIT_OPERATION_IN_PROGRESS");
  const current=await scalar(manager,input.path,["rev-parse","HEAD"]);
  let head=current;
  if(current===input.expectedSourceHead) {
    await manager.assertIntegrationTreePolicy(input.path,tree,current);
    head=await scalar(manager,input.path,[...identity,"commit-tree",tree,"-p",current,"-p",input.targetHead,
      "-m",`Corptie snapshot synchronization ${input.jobId ?? ""}`]);
    await manager.runGit(input.path,["merge","--autostash","--ff-only",head]);
  } else {
    const parents=(await scalar(manager,input.path,["rev-list","--parents","-n","1",head])).split(/\s+/).slice(1);
    if(!input.allowResolvedRebase || parents[0]!==input.expectedSourceHead || parents[1]!==input.targetHead
      || await scalar(manager,input.path,["rev-parse",`${head}^{tree}`])!==tree) throw coded("WORKTREE_HEAD_CHANGED");
  }
  if(await scalar(manager,input.path,["rev-parse","HEAD"])!==head
    || await scalar(manager,input.path,["diff","--name-only","--diff-filter=U"])) throw coded("REBASE_CONFLICT");
  const targetTree=await scalar(manager,input.path,["rev-parse",`${input.targetHead}^{tree}`]);
  manager.store.runInTransaction(()=>{
    const binding=manager.store.getTaskDeliveryBinding(base.taskId);
    if(binding?.base_commit_oid===input.targetHead && binding.base_tree_oid===targetTree) return;
    if(binding?.base_commit_oid!==base.baseCommitOid || binding.base_tree_oid!==base.baseTreeOid) throw coded("TASK_DELIVERY_BINDING_CHANGED");
    manager.store.db.run(`UPDATE task_delivery_worktrees SET base_commit_oid=?,base_tree_oid=?,updated_at=? WHERE task_id=?`,
      [input.targetHead,targetTree,new Date().toISOString(),base.taskId]);
    manager.store.scheduleSave();
  });
  return {rebased:true,headOid:head,recovered:current!==input.expectedSourceHead,alreadySynchronized:false};
}
