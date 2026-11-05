import { integrationBlocksWorkspaceCapture } from "../domain/worktreeCreationScope.mjs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { taskHierarchyError as error } from "../store/repositories/taskHierarchyRepository.mjs";
import { TaskIntegrationAcceptanceService, hierarchyDigest } from "./taskIntegrationAcceptanceService.mjs";
import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";
import { ProjectWorkspaceSnapshotService } from "./projectWorkspaceSnapshotService.mjs";
import { gitScalarOutput } from "../utils/gitScalarOutput.mjs";

const execFile = promisify(execFileCallback);
async function runGit(path, args) {
  return (await execFile("git", ["-C", path, ...args], { encoding:"utf8", timeout:15000, maxBuffer:1024*1024 })).stdout;
}

// Project capability; never depends on an Agent Provider or its configuration.
export class TaskWorktreeHierarchyService {
  constructor({ store, execGit = runGit }) { this.store = store; this.git = execGit; }
  async scalar(path, args) { return gitScalarOutput(await this.git(path, args)); }

  deliveryChildren(taskId) {
    return (this.store.readTaskDeliveryParticipation({parentTaskIds:[taskId]}).byParentTaskId.get(taskId) ?? [])
      .filter(child=>child.participates);
  }

  async inspectChildDeliveryChanges(childTaskId, observation=null) {
    const item = observation?.item ?? this.resolveTaskDelivery(childTaskId, { allowAdoption: false });
    if(!observation) await this.assertClean(item.inventory);
    const path = item.inventory.canonicalPath || item.inventory.path;
    const currentHeadOid = observation?.headOid ?? await this.scalar(path, ["rev-parse", "HEAD"]);
    const baseCommitOid = item.binding.base_commit_oid;
    const baseTreeOid = item.binding.base_tree_oid;
    const currentTreeOid = currentHeadOid===baseCommitOid && baseTreeOid
      ? baseTreeOid : await this.scalar(path, ["rev-parse", `${currentHeadOid}^{tree}`]);
    // Legacy deliveries without a frozen base cannot prove an exemption.
    const changeState = !baseCommitOid || !baseTreeOid ? "unavailable"
      : currentHeadOid === baseCommitOid && currentTreeOid === baseTreeOid ? "no_changes"
      : currentTreeOid === baseTreeOid ? "history_only" : "code_changes";
    if(!observation) {
      await this.assertClean(item.inventory);
      if (await this.scalar(path, ["rev-parse", "HEAD"]) !== currentHeadOid) throw error("WORKTREE_STATE_CHANGED");
    }
    return { taskId: childTaskId, parentTaskId: item.task.parent_task_id, worktreeId: item.binding.worktree_id,
      baseCommitOid, baseTreeOid, currentHeadOid, currentTreeOid, changeState };
  }

  async inspectIntegrationRequirement(rootTaskId) {
    const root = this.resolveTaskDelivery(rootTaskId, { allowAdoption: false });
    await this.assertClean(root.inventory);
    const parentHeadOid = await this.scalar(root.inventory.canonicalPath || root.inventory.path, ["rev-parse", "HEAD"]);
    const children = [];
    for (const child of this.deliveryChildren(rootTaskId)) children.push(await this.inspectChildDeliveryChanges(child.id));
    return { requirement: children.some(child => !["no_changes", "history_only"].includes(child.changeState)) ? "required" : "none",
      parentHeadOid, hierarchyRevision: root.task.hierarchy_revision, bindingRevision: root.binding.binding_revision, children };
  }

  deliveryFailure(task, binding, reason) {
    return Object.assign(error("PARENT_WORKTREE_REQUIRED", `Task ${task.title || task.id} (${task.id}) has no proven available delivery Worktree: ${reason}.`), {
      diagnosis:{taskId:task.id,parentTaskId:task.parent_task_id ?? null,worktreeId:binding?.worktree_id ?? null,
        taskTitle:task.title,sessionId:task.current_session_id ?? null,reason,
        recovery:"Return to task selection. Recover this task's startup or delivery binding before retrying; no resources were modified."}
    });
  }

  async resolveOperationScope(repositoryId, input, inspection) {
    const scope=input.taskScope;
    const ids=[...input.sourceWorktreeIds,input.targetWorktreeId];
    if(!scope) { this.store.assertStandaloneWorktreeMutation?.({worktreeIds:ids}); return null; }
    const allowed=["version","rootTaskId","action","expectedHierarchyRevision","expectedBindingRevision","acceptanceReceiptId"];
    if(Object.keys(scope).some(k=>!allowed.includes(k)) || scope.version!==1
      || !["merge_children","sync_children","sync_main","promote_parent"].includes(scope.action)
      || input.sourceWorktreeIds.length>100 || new Set(input.sourceWorktreeIds).size!==input.sourceWorktreeIds.length
      || input.sourceWorktreeIds.includes(input.targetWorktreeId)) throw error("TASK_HIERARCHY_CHANGED");
    const root=this.resolveTaskDelivery(scope.rootTaskId);
    const participatingChildren=this.deliveryChildren(root.task.id);
    if(participatingChildren.some(child=>child.work_id!==root.task.work_id)) throw error("TASK_PARENT_INVALID");
    if(scope.action!=="promote_parent" && (root.task.archived || root.task.lifecycle_state==="done" || root.task.deletion_status)) throw error("TASK_PARENT_UNAVAILABLE");
    if(root.binding.repository_id!==repositoryId) throw error("TASK_PARENT_INVALID");
    const childOperation=["merge_children","sync_children"].includes(scope.action);
    const isSync=["sync_children","sync_main"].includes(scope.action);
    if((isSync && !["sync","one_way_sync"].includes(input.operationType ?? input.type))
      || (!isSync && !["merge","batch_merge"].includes(input.operationType ?? input.type))) throw error("CHILD_TARGET_NOT_PARENT");
    const main=inspection.worktrees.find(w=>w.isMain);
    const targetId=childOperation ? root.binding.worktree_id : main?.worktreeId;
    if(input.targetWorktreeId!==targetId) throw error("CHILD_TARGET_NOT_PARENT");
    const children=participatingChildren.map(({id,worktree_id,binding_revision})=>({id,worktree_id,binding_revision}));
    if(childOperation) {
      const childIds=new Set(children.map(c=>c.worktree_id));
      if(input.sourceWorktreeIds.some(id=>!childIds.has(id))) throw error("CHILD_TARGET_NOT_PARENT");
    } else if(input.sourceWorktreeIds.length!==1 || input.sourceWorktreeIds[0]!==root.binding.worktree_id) throw error("CHILD_TARGET_NOT_PARENT");
    let syncStrategy=input.syncStrategy ?? (scope.action==="sync_main" ? "merge" : "auto");
    if(!["auto","merge","rebase"].includes(syncStrategy)) throw error("INVALID_SYNC_STRATEGY");
    if(isSync && syncStrategy==="auto") {
      // Never automatically rewrite a tracked/published branch.
      const published=await Promise.all(input.sourceWorktreeIds.map(async id=>{
        const tree=inspection.worktrees.find(w=>w.worktreeId===id);
        if(!tree?.branchName) throw error("WORKTREE_STATE_CHANGED");
        return Boolean(await this.scalar(tree.path,["for-each-ref","--format=%(upstream)",`refs/heads/${tree.branchName}`]));
      }));
      syncStrategy=published.some(Boolean) ? "merge" : "rebase";
    }
    const reservedWorktreeIds=[...new Set(ids)];
    this.assertIdle(reservedWorktreeIds,true);
    return {taskScope:{...scope,expectedHierarchyRevision:root.task.hierarchy_revision,expectedBindingRevision:root.binding.binding_revision},hierarchyDigest:hierarchyDigest([root.task.id,root.task.hierarchy_revision,root.binding,children]),
      baseHeadOid:inspection.worktrees.find(w=>w.worktreeId===targetId)?.headOid,
      syncStrategy:isSync ? syncStrategy : null,mergeStrategy:"merge",
      reservedWorktreeIds,writeWorktreeIds:isSync ? [...input.sourceWorktreeIds] : [targetId]};
  }

  assertIdle(ids,includeQueued=false) {
    for(const id of ids) for(const logical of this.store.listLogicalSessionsByWorkspaceId?.(id) ?? []) {
      const session=this.store.getSession(logical.legacySessionId);
      const blocker=sessionHasActiveRun(session)
        ? {reason:session.status==="blocked" ? "WAITING_APPROVAL" : "ACTIVE_TURN"}
        : this.store.getSessionRuntimeBlocker?.(logical.legacySessionId, { includeQueued }) ?? null;
      if(blocker) {
        const title=session?.title || logical.title || logical.legacySessionId || id;
        const reason={ACTIVE_TURN:"is still running",WAITING_APPROVAL:"is waiting for input or approval",
          UNSETTLED_DELIVERY:`has unfinished message deliveries (${blocker.count ?? "unknown"})`,
          BACKGROUND_OPERATION:"has unfinished background work"}[blocker.reason];
        throw Object.assign(error("TASK_HIERARCHY_BUSY", `Session "${title}" ${reason}. Finish that work before retrying integration.`), {
          busyContext:{worktreeId:id,sessionId:logical.logicalSessionId ?? logical.legacySessionId,sessionTitle:title,...blocker}
        });
      }
    }
  }

  async assertOperationFresh(plan,jobId) {
    if(!plan.taskScope) { this.store.assertStandaloneWorktreeMutation?.({worktreeIds:plan.items.map(w=>w.worktreeId)});return; }
    const scope=plan.taskScope,root=this.resolveTaskDelivery(scope.rootTaskId);
    this.assertIdle(plan.reservedWorktreeIds ?? [],this.store.getWorktreeIntegrationJob?.(jobId)?.status==="awaiting_confirmation");
    if(root.task.archived || root.task.deletion_status) throw error("TASK_PARENT_UNAVAILABLE");
    if(root.binding.repository_id!==plan.repositoryId) throw error("TASK_PARENT_INVALID");
    const children=new Set(this.deliveryChildren(root.task.id).map(child=>child.worktree_id));
    if(["merge_children","sync_children"].includes(scope.action)
      && plan.sourceWorktreeIds.some(id=>!children.has(id))) throw error("CHILD_TARGET_NOT_PARENT");
    if(["merge_children","sync_children"].includes(scope.action)
      && plan.targetWorktreeId!==root.binding.worktree_id) throw error("CHILD_TARGET_NOT_PARENT");
    if(["promote_parent","sync_main"].includes(scope.action)
      && (plan.sourceWorktreeIds.length!==1 || plan.sourceWorktreeIds[0]!==root.binding.worktree_id)) throw error("CHILD_TARGET_NOT_PARENT");
    return root;
  }

  async decorateInspection(inspection) {
    const rows=this.store.selectAll(`SELECT t.*,d.worktree_id,d.binding_revision FROM task_delivery_worktrees d
      JOIN tasks t ON t.id=d.task_id WHERE d.repository_id=? AND COALESCE(t.deletion_status,'')<>'deleted'`,[inspection.repositoryId ?? inspection.repository?.id ?? inspection.worktrees[0]?.repositoryId]);
    const bindings=new Map(rows.map(t=>[t.id,t])),byTree=new Map(rows.map(t=>[t.worktree_id,t]));
    const missingParents=[...new Set(rows.map(t=>t.parent_task_id).filter(id=>id && !bindings.has(id)))];
    for(let offset=0;offset<missingParents.length;offset+=400) {
      const batch=missingParents.slice(offset,offset+400);
      for(const parent of this.store.selectAll(`SELECT t.*,d.worktree_id,d.binding_revision FROM tasks t
        LEFT JOIN task_delivery_worktrees d ON d.task_id=t.id WHERE t.id IN (${batch.map(()=>"?").join(",")})`,batch)) bindings.set(parent.id,parent);
    }
    const main=inspection.worktrees.find(w=>w.isMain);
    const trees=new Map(inspection.worktrees.map(w=>[w.worktreeId,w]));
    const participation=this.store.readTaskDeliveryParticipation({parentTaskIds:rows.map(task=>task.id)});
    const counts=new Map([...participation.byParentTaskId].flatMap(([id,children])=>{
      const count=children.filter(child=>child.participates).length;
      return count ? [[id,count]] : [];
    }));
    const deliveryNotices=[...participation.byTaskId.values()].filter(child=>child.participation==="ignored_failed")
      .map(child=>({taskId:child.id,parentTaskId:child.parent_task_id,parentWorktreeId:bindings.get(child.parent_task_id)?.worktree_id,
        taskTitle:child.title,reason:"FAILED_TASK_WITHOUT_DELIVERY_RESOURCES"}));
    const result=[];
    for(const tree of inspection.worktrees) {
      const task=byTree.get(tree.worktreeId),parent=task?.parent_task_id ? bindings.get(task.parent_task_id) : null;
      if(!task || (!task.parent_task_id && !counts.has(task.id))) {result.push(tree);continue;}
      if(task.parent_task_id && !parent) {
        // Never present an orphaned child as an independent main-branch flow.
        const unavailable={available:false,reason:"PARENT_WORKTREE_REQUIRED"};
        result.push({...tree,hierarchy:{version:1,role:"child",taskId:task.id,rootTaskId:task.parent_task_id,parentTaskId:task.parent_task_id,
          parentWorktreeId:null,hierarchyRevision:0,bindingRevision:0,comparison:{kind:"parent",worktreeId:"",branchName:null,headOid:null,ahead:null,behind:null,merged:null},
          childCount:0,integratedChildCount:null,actions:Object.fromEntries(["createChild","mergeChildren","syncChildren","mergeToParent","syncFromParent","syncFromMain","promoteToMain"].map(name=>[name,unavailable]))}});
        continue;
      }
      const root=parent ?? task,baseline=parent ? trees.get(parent.worktree_id) : main;
      let ahead=null,behind=null;
      if(tree.availability==="available" && baseline?.headOid && tree.headOid) {
        const values=await this.git(tree.path,["rev-list","--left-right","--count",`${tree.headOid}...${baseline.headOid}`]).catch(()=>"");
        const match=/^(\d+)\s+(\d+)$/.exec(values.trim());
        if(match) {ahead=Number(match[1]);behind=Number(match[2]);}
      }
      const action=(available,reason=null)=>({available:Boolean(available),reason:available ? null : reason ?? "WORKTREE_UNAVAILABLE"});
      const operable=tree.availability==="available" && !tree.isDetached && baseline && !root.archived && !root.deletion_status
        && (!parent || parent.work_id===task.work_id);
      const available=operable && root.lifecycle_state!=="done";
      result.push({...tree,hierarchy:{version:1,role:parent?"child":"parent",taskId:task.id,rootTaskId:root.id,
        parentTaskId:parent?.id ?? null,parentWorktreeId:parent?.worktree_id ?? null,
        hierarchyRevision:root.hierarchy_revision,bindingRevision:root.binding_revision ?? 0,
        comparison:{kind:parent?"parent":"main",worktreeId:baseline?.worktreeId ?? "",branchName:baseline?.branchName ?? null,headOid:baseline?.headOid ?? null,ahead,behind,merged:ahead===null?null:ahead===0},
        childCount:counts.get(task.id) ?? 0,integratedChildCount:null,
        actions:{createChild:action(!task.archived && task.lifecycle_state!=="done"),mergeChildren:action(available && counts.has(task.id)),syncChildren:action(available && counts.has(task.id)),
          mergeToParent:action(parent && available),syncFromParent:action(parent && available),syncFromMain:action(!parent && available),promoteToMain:action(!parent && operable)}}});
    }
    const integratedCounts=new Map();
    for(const tree of result) if(tree.hierarchy?.parentTaskId && tree.hierarchy.comparison.ahead===0) {
      const id=tree.hierarchy.parentTaskId;
      integratedCounts.set(id,(integratedCounts.get(id) ?? 0)+1);
    }
    const childStates=new Map();
    for(const tree of result) if(tree.hierarchy?.role==="child") {
      try { tree.hierarchy.changeState=(await this.inspectChildDeliveryChanges(tree.hierarchy.taskId)).changeState; }
      catch { tree.hierarchy.changeState=tree.dirty ? "dirty" : "unavailable"; }
      const parentID=tree.hierarchy.parentTaskId;
      if(!childStates.has(parentID)) childStates.set(parentID,[]);
      childStates.get(parentID).push(tree.hierarchy.changeState);
    }
    for(const tree of result) if(tree.hierarchy?.childCount>0) {
      tree.hierarchy.integratedChildCount=integratedCounts.get(tree.hierarchy.taskId) ?? 0;
      const states=childStates.get(tree.hierarchy.taskId) ?? [];
      tree.hierarchy.integrationRequirement=states.length!==tree.hierarchy.childCount || states.some(state=>["dirty","unavailable"].includes(state))
        ? "blocked" : states.some(state=>state==="code_changes") ? "required" : "none";
    }
    return {...inspection,deliveryNotices,taskHierarchyCapabilities:{version:1,maxDepth:null,createChild:true,worktreeOperations:true,integrationAcceptance:true},worktrees:result};
  }

  resolveTaskDelivery(taskId,{allowAdoption=true}={}) {
    const task = this.store.getTask(taskId);
    if (!task) throw error("TASK_PARENT_UNAVAILABLE");
    let binding = this.store.getTaskDeliveryBinding(taskId);
    if(task.creation_state!=="ready") throw this.deliveryFailure(task,binding,
      task.creation_state==="failed" ? "FAILED_TASK_WITH_DELIVERY_EVIDENCE" : "TASK_STARTUP_INCOMPLETE");
    if (!binding) {
      if(!allowAdoption) throw this.deliveryFailure(task,binding,"DELIVERY_BINDING_MISSING");
      // Legacy adoption requires exactly one proven ready allocation. Never
      // infer ownership from a Session's latest cwd or Git association order.
      const proofs = this.store.selectAll(`SELECT o.startup_operation_id,o.repository_id,o.worktree_id
        FROM work_session_startup_operations o JOIN work_session_startup_receipts r
          ON r.startup_operation_id=o.startup_operation_id
        WHERE o.task_id=? AND o.state='ready'`, [taskId]);
      if (proofs.length !== 1) throw this.deliveryFailure(task,binding,"STARTUP_PROOF_MISSING_OR_AMBIGUOUS");
      const proof = proofs[0];
      binding = this.store.runInTransaction(() => this.store.bindTaskDeliveryWorktree({taskId,
        repositoryId:proof.repository_id,worktreeId:proof.worktree_id,startupOperationId:proof.startup_operation_id}));
    }
    const inventory = this.store.getGitWorktree(binding.worktree_id);
    const proof = this.store.selectOne(`SELECT o.task_id,o.repository_id,o.worktree_id FROM work_session_startup_operations o
      JOIN work_session_startup_receipts r ON r.startup_operation_id=o.startup_operation_id
      WHERE o.startup_operation_id=? AND o.state='ready'`, [binding.startup_operation_id]);
    if (!inventory || inventory.availability !== "available" || inventory.isMain || inventory.isDetached
      || inventory.repositoryId !== binding.repository_id || !proof || proof.task_id !== taskId
      || proof.worktree_id !== inventory.worktreeId || proof.repository_id !== binding.repository_id
      || this.store.getTaskWorkspaceContext(task)?.repository?.id !== binding.repository_id) {
      throw this.deliveryFailure(task,binding,!inventory || inventory.availability!=="available"
        ? "WORKTREE_UNAVAILABLE" : !proof ? "STARTUP_PROOF_MISSING" : "DELIVERY_PROOF_MISMATCH");
    }
    return { task, binding, inventory };
  }

  async validateCreate(taskInput) {
    if (!taskInput?.parentTaskId) return;
    this.store.assertParentForCreate(taskInput);
    const context = this.store.getTaskWorkspaceContext(taskInput.parentTaskId);
    if (context?.repository) {
      const { inventory } = this.resolveTaskDelivery(taskInput.parentTaskId);
      await this.assertSnapshotSource(inventory);
    }
  }

  async assertClean(inventory) {
    // Readability is independent of dirty state; writes prepare separately.
    await this.assertSnapshotSource(inventory);
  }

  async assertSnapshotSource(inventory) {
    const path = inventory.canonicalPath || inventory.path;
    const repository = this.store.getGitRepository(inventory.repositoryId);
    const common = await this.scalar(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!repository || await realpath(common) !== await realpath(repository.commonGitDirCanonicalPath)) {
      throw error("TASK_DELIVERY_BINDING_CHANGED");
    }
  }

  async freezeBaseForStartup({ startupOperationId, taskId, repositoryId, startupTiming = null }) {
    const task = this.store.getTask(taskId);
    if (!task?.parent_task_id) return null;
    const operation = this.store.selectOne("SELECT * FROM work_session_startup_operations WHERE startup_operation_id=?", [startupOperationId]);
    if (!operation || operation.task_id !== taskId || operation.repository_id !== repositoryId) throw error("START_REFERENCE_INVALID");
    if (operation.worktree_base_context_json) {
      const frozen = JSON.parse(operation.worktree_base_context_json);
      this.assertBaseBinding(task, frozen);
      return frozen;
    }
    const { task:parent, binding, inventory } = this.resolveTaskDelivery(task.parent_task_id);
    if (parent.work_id !== task.work_id || binding.repository_id !== repositoryId) throw error("TASK_PARENT_INVALID");
    if (parent.archived || parent.lifecycle_state === "done" || parent.deletion_status) throw error("TASK_PARENT_UNAVAILABLE");
    const path = inventory.canonicalPath || inventory.path;
    const snapshot = await new ProjectWorkspaceSnapshotService().captureParentWorkspace({path,operationId:startupOperationId,
      bindingContext:{parentTaskId:parent.id,parentWorktreeId:binding.worktree_id,parentBindingRevision:binding.binding_revision},
      startupTiming,
      validate:async()=>{
        const jobs=this.store.selectAll(`SELECT * FROM worktree_integration_jobs WHERE repository_id=?
          AND status IN ('queued','running','paused','cancellation_requested','replanning')`,[repositoryId]);
        if(jobs.some(job=>integrationBlocksWorkspaceCapture(job,inventory.worktreeId,this.store.listGitWorktrees(repositoryId)))) throw error("TASK_HIERARCHY_BUSY");
        await this.assertSnapshotSource(inventory);
      }});
    const base = {...snapshot,rootTaskId:parent.id,parentTaskId:parent.id,
      parentWorktreeId:binding.worktree_id,parentBindingRevision:binding.binding_revision,
      hierarchyRevision:parent.hierarchy_revision};
    return this.store.runInTransaction(() => {
      this.assertBaseBinding(this.store.getTask(taskId), base);
      this.store.db.run(`UPDATE work_session_startup_operations SET worktree_base_context_json=?
        WHERE startup_operation_id=? AND worktree_base_context_json IS NULL`, [JSON.stringify(base),startupOperationId]);
      this.store.scheduleSave();
      const persisted = JSON.parse(this.store.selectOne("SELECT worktree_base_context_json FROM work_session_startup_operations WHERE startup_operation_id=?", [startupOperationId]).worktree_base_context_json);
      this.assertBaseBinding(this.store.getTask(taskId), persisted);
      return persisted;
    });
  }

  assertBaseBinding(task, base) {
    const parent = this.store.getTask(base.parentTaskId);
    const binding = this.store.getTaskDeliveryBinding(base.parentTaskId);
    if (!task || task.parent_task_id !== base.parentTaskId || !parent
      || parent.work_id !== task.work_id || !binding
      || binding.repository_id!==this.store.getTaskWorkspaceContext(task)?.repository?.id) throw error("TASK_DELIVERY_BINDING_CHANGED");
    // Sibling creation and subsequent parent commits intentionally do not
    // invalidate the already captured commit. Only this relationship/binding does.
  }
}
