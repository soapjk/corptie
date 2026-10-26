import { createHash } from "node:crypto";

const active = "COALESCE(deletion_status,'') <> 'deleted' AND creation_state='ready'";
export function taskHierarchyError(code, message = code, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

// Only a fully observed, empty failure can leave the delivery dependency set.
// Compensation alone is not proof that an allocation never existed.
export function startupHasNoDeliveryResources(operation, isChild) {
  // A child must freeze its parent base BEFORE invoking workspace allocation.
  // A compensated failure before that boundary cannot own a delivery. Do not
  // extend this inference to roots (which have no parent-base boundary).
  if(!isChild || operation.state!=="failed_compensated" || operation.error_stage!=="worktree_preparation"
    || operation.compensation_state!=="completed" || operation.worktree_base_context_json!=null
    || ["worktree_id","allocation_json","logical_session_id","legacy_session_id","provider_binding_id",
      "binding_generation","worktree_prepared_at","session_bound_at","provider_bound_at","ready_at"]
      .some(key=>operation[key]!=null) || operation.initial_turn_state==="accepted") return false;
  try {
    const result=JSON.parse(operation.compensation_result_json);
    return result?.status==="completed" && result.failedStep===null
      && Array.isArray(result.completedSteps) && result.completedSteps.length===1 && result.completedSteps[0]==="task_claim_released";
  } catch { return false; }
}

export function classifyTaskDeliveryParticipation(record) {
  if (record.deletion_status === "deleted") return "excluded_deleted";
  if (record.creation_state === "ready" || record.current_session_id || record.has_delivery
    || record.has_session || record.has_startup_binding || record.has_receipt || record.has_allocation) return "required";
  if ((record.has_startup && !record.startups_proven_empty) || record.has_workspace_request) return "uncertain";
  if (record.creation_state === "failed" && record.evidence_complete === true) return "ignored_failed";
  return "pending";
}

// Owns no connection. All mutations participate in the Store transaction.
export class TaskHierarchyRepository {
  constructor(ports) { Object.assign(this, ports); }
  get db() { return this.getDatabase(); }

  assertParentForCreate({ workId, parentTaskId, expectedParentResourceVersion }) {
    if (!parentTaskId) return null;
    const parent = this.getTask(parentTaskId);
    if (!parent || parent.work_id !== workId) throw taskHierarchyError("TASK_PARENT_UNAVAILABLE");
    if (!Number.isSafeInteger(expectedParentResourceVersion) || expectedParentResourceVersion < 1
      || parent.resource_version !== expectedParentResourceVersion) {
      throw taskHierarchyError("TASK_PARENT_VERSION_CONFLICT");
    }
    if (parent.parent_task_id) throw taskHierarchyError("TASK_MAX_DEPTH_EXCEEDED");
    if (parent.archived || parent.lifecycle_state === "done" || parent.deletion_status || parent.creation_state !== "ready") {
      throw taskHierarchyError("TASK_PARENT_UNAVAILABLE");
    }
    const context = this.getTaskWorkspaceContext(parent);
    if (context?.repository && this.selectOne(`SELECT 1 FROM worktree_integration_jobs
      WHERE repository_id=? AND status IN ('queued','running','paused','cancellation_requested','replanning') LIMIT 1`,
    [context.repository.id])) throw taskHierarchyError("TASK_HIERARCHY_BUSY");
    return parent;
  }

  bumpHierarchyRevision(rootTaskId) {
    this.db.run("UPDATE tasks SET hierarchy_revision=hierarchy_revision+1 WHERE id=?", [rootTaskId]);
  }

  hasTaskChildren(taskId) {
    return (this.readTaskDeliveryParticipation({parentTaskIds:[taskId]}).byParentTaskId.get(taskId) ?? []).some(row=>row.participates);
  }

  readTaskDeliveryParticipation({taskIds=[],parentTaskIds=[]}={}) {
    const byTaskId=new Map(),byParentTaskId=new Map();
    for (const [column,values] of [["id",taskIds],["parent_task_id",parentTaskIds]]) {
      const ids=[...new Set(values.filter(Boolean))];
      for(let offset=0;offset<ids.length;offset+=400) {
        const batch=ids.slice(offset,offset+400);
        const rows=this.selectAll(`SELECT t.id,t.parent_task_id,t.work_id,t.title,t.revision,t.creation_state,
          t.deletion_status,t.current_session_id,t.lifecycle_state,d.worktree_id,d.binding_revision,w.head_oid,
          d.task_id IS NOT NULL AS has_delivery
          FROM tasks t LEFT JOIN task_delivery_worktrees d ON d.task_id=t.id
          LEFT JOIN git_worktrees w ON w.worktree_id=d.worktree_id
          WHERE t.${column} IN (${batch.map(()=>"?").join(",")}) ORDER BY t.id`,batch);
        // Ready and bound Tasks already participate. Only unresolved failures
        // need historical evidence; batch those reads instead of scanning the
        // Session/startup tables once for every card on the page.
        const unresolved=rows.filter(row=>row.creation_state==="failed" && row.deletion_status!=="deleted"
          && !row.current_session_id && !row.has_delivery);
        for(let start=0;start<unresolved.length;start+=100) {
          const pending=unresolved.slice(start,start+100),taskIds=pending.map(row=>row.id);
          const placeholders=taskIds.map(()=>"?").join(",");
          const evidence=this.selectAll(`SELECT task_id,'has_session' AS kind FROM sessions WHERE task_id IN (${placeholders})
            UNION SELECT task_id,'has_startup' FROM work_session_startup_operations WHERE task_id IN (${placeholders})
            UNION SELECT task_id,'has_startup_binding' FROM work_session_startup_bindings WHERE task_id IN (${placeholders})
            UNION SELECT o.task_id,'has_receipt' FROM work_session_startup_receipts r JOIN work_session_startup_operations o
              ON o.startup_operation_id=r.startup_operation_id WHERE o.task_id IN (${placeholders})
            UNION SELECT task_id,'has_allocation' FROM work_session_startup_operations WHERE task_id IN (${placeholders})
              AND (worktree_id IS NOT NULL OR logical_session_id IS NOT NULL OR legacy_session_id IS NOT NULL OR allocation_json IS NOT NULL)
            UNION SELECT o.task_id,'has_allocation' FROM git_worktrees w JOIN work_session_startup_operations o
              ON o.startup_operation_id=w.created_by_startup_operation_id WHERE o.task_id IN (${placeholders})
            UNION SELECT task_id,'has_allocation' FROM execution_spaces WHERE task_id IN (${placeholders})
            UNION SELECT task_id,'has_workspace_request' FROM workspace_creation_requests WHERE task_id IN (${placeholders})`,
          Array.from({length:8},()=>taskIds).flat());
          const byId=new Map(pending.map(row=>[row.id,row]));
          for(const item of evidence) byId.get(item.task_id)[item.kind]=true;
          const operations=this.selectAll(`SELECT * FROM work_session_startup_operations WHERE task_id IN (${placeholders})`,taskIds);
          for(const row of pending) row.startups_proven_empty=true;
          for(const operation of operations) {
            const row=byId.get(operation.task_id);
            if(!startupHasNoDeliveryResources(operation,Boolean(row.parent_task_id))) row.startups_proven_empty=false;
          }
        }
        for(const row of rows) {
          const participation=classifyTaskDeliveryParticipation({...row,evidence_complete:true});
          byTaskId.set(row.id,{...row,participation,participates:!["ignored_failed","excluded_deleted"].includes(participation)});
        }
      }
    }
    for(const row of [...byTaskId.values()].sort((a,b)=>a.id<b.id ? -1 : a.id>b.id ? 1 : 0)) {
      const children=byParentTaskId.get(row.parent_task_id) ?? [];
      children.push(row);byParentTaskId.set(row.parent_task_id,children);
    }
    return {byTaskId,byParentTaskId};
  }

  taskHierarchyAncestors(tasks) {
    const present=new Set(tasks.map(task=>task.id));
    const ids=[...new Set(tasks.map(task=>task.parent_task_id).filter(id=>id && !present.has(id)))];
    const childScopes=new Set(tasks.filter(task=>task.parent_task_id).map(task=>JSON.stringify([task.parent_task_id,task.work_id])));
    const byId=new Map(tasks.map(task=>[task.id,task]));
    const ancestors=[];
    for(let offset=0;offset<ids.length;offset+=400) {
      const batch=ids.slice(offset,offset+400);
      const rows=this.selectAll(`SELECT * FROM tasks WHERE id IN (${batch.map(()=>"?").join(",")}) AND ${active} AND parent_task_id IS NULL`,batch);
      for(const parent of rows) if(childScopes.has(JSON.stringify([parent.id,parent.work_id]))) {
        if(!byId.has(parent.id)) {ancestors.push(parent);byId.set(parent.id,parent);}
      }
    }
    return ancestors;
  }

  assertStandaloneWorktreeMutation({ worktreeIds = [], paths = [], readPaths = [], jobId = null }) {
    if (!worktreeIds.length && !paths.length && !readPaths.length) return;
    const ids = [...new Set(worktreeIds.filter(Boolean))];
    const locations = [...new Set([...paths,...readPaths].filter(Boolean))];
    if (!ids.length && !locations.length) return;
    const predicates = [
      ...(ids.length ? [`w.worktree_id IN (${ids.map(()=>"?").join(",")})`] : []),
      ...(locations.length ? [`(w.path IN (${locations.map(()=>"?").join(",")}) OR w.canonical_path IN (${locations.map(()=>"?").join(",")}))`] : [])
    ];
    const members = this.selectAll(`SELECT t.id,t.parent_task_id FROM task_delivery_worktrees d
      JOIN tasks t ON t.id=d.task_id JOIN git_worktrees w ON w.worktree_id=d.worktree_id
      WHERE (${predicates.join(" OR ")}) AND (t.parent_task_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=t.id AND COALESCE(c.deletion_status,'')<>'deleted'))`,
    [...ids,...locations,...locations]);
    const participation=this.readTaskDeliveryParticipation({parentTaskIds:members.filter(row=>!row.parent_task_id).map(row=>row.id)});
    const protectedMembers=members.filter(row=>row.parent_task_id || (participation.byParentTaskId.get(row.id) ?? []).some(child=>child.participates));
    const member=protectedMembers[0];
    if (member) {
      const job=jobId && this.selectOne("SELECT * FROM worktree_integration_jobs WHERE id=?",[jobId]);
      const plan=job?.details_json ? JSON.parse(job.details_json).plan : null;
      const scope=plan?.taskScope;
      const graph=plan?.orchestration;
      if(graph?.version===1 && ["queued","running","paused","cancellation_requested"].includes(job?.status)) {
        // The graph is generated exclusively on the server and bound to the
        // reviewed candidate. Restrict each Git write to the active step.
        const reserved=new Set(plan.reservedWorktreeIds ?? []);
        const writable=new Set(plan.writeWorktreeIds ?? []);
        const graphMembers=this.selectAll(`SELECT worktree_id,path,canonical_path FROM git_worktrees w WHERE ${predicates.join(" OR ")}`,[...ids,...locations,...locations]);
        const rootsFresh=graph.groups.every(group=>{
          const task=this.getTask(group.rootTaskId);
          const children=(this.readTaskDeliveryParticipation({parentTaskIds:[group.rootTaskId]}).byParentTaskId.get(group.rootTaskId) ?? []).filter(child=>child.participates);
          return task && !task.archived && !task.deletion_status && task.lifecycle_state!=="done" && task.hierarchy_revision===group.scope.expectedHierarchyRevision
            && JSON.stringify(children.map(child=>child.id))===JSON.stringify(group.bindings.slice(1).map(child=>child.taskId))
            && group.bindings.every(item=>{
              const binding=this.getTaskDeliveryBinding(item.taskId),child=this.getTask(item.taskId);
              return binding?.worktree_id===item.worktreeId && binding.binding_revision===item.bindingRevision
                && child?.work_id===task.work_id && (child.parent_task_id ?? null)===item.parentTaskId;
            });
        });
        const covered=protectedMembers.every(row=>graph.groups.some(group=>group.bindings.some(item=>item.taskId===row.id)));
        if(rootsFresh && covered && graphMembers.length && graphMembers.every(tree=>reserved.has(tree.worktree_id))
          && ids.every(id=>graphMembers.some(tree=>tree.worktree_id===id && writable.has(id)))
          && paths.every(path=>graphMembers.some(tree=>(tree.path===path || tree.canonical_path===path) && writable.has(tree.worktree_id)))
          && readPaths.every(path=>graphMembers.some(tree=>tree.path===path || tree.canonical_path===path))) return;
        throw taskHierarchyError("TASK_HIERARCHY_SCOPE_REQUIRED", "The integration graph no longer authorizes this write.");
      }
      const root=scope && this.getTask(scope.rootTaskId);
      const binding=scope && this.getTaskDeliveryBinding(scope.rootTaskId);
      const actual=this.selectAll(`SELECT worktree_id FROM git_worktrees w WHERE ${predicates.join(" OR ")}`,[...ids,...locations,...locations]);
      const writePaths=[...new Set(paths.filter(Boolean))];
      const writable=new Set(plan?.writeWorktreeIds ?? []);
      const writes=this.selectAll(`SELECT worktree_id,path,canonical_path FROM git_worktrees WHERE worktree_id IN (${ids.map(()=>"?").join(",") || "NULL"})
        OR path IN (${writePaths.map(()=>"?").join(",") || "NULL"}) OR canonical_path IN (${writePaths.map(()=>"?").join(",") || "NULL"})`,[...ids,...writePaths,...writePaths]);
      if(scope?.version===1 && ["queued","running","paused","cancellation_requested"].includes(job?.status)
        && root?.hierarchy_revision===scope.expectedHierarchyRevision && binding?.binding_revision===scope.expectedBindingRevision
        && actual.length && actual.every(w=>plan.reservedWorktreeIds?.includes(w.worktree_id))
        && writes.every(w=>writable.has(w.worktree_id)) && ids.every(id=>writes.some(w=>w.worktree_id===id))
        && writePaths.every(path=>writes.some(w=>w.path===path || w.canonical_path===path))) return;
      throw taskHierarchyError("TASK_HIERARCHY_SCOPE_REQUIRED", "Use the parent-scoped integration workflow; legacy main-branch operations cannot mutate this delivery.");
    }
  }

  hierarchySummaries(taskIds) {
    const ids = [...new Set(taskIds)];
    const output = new Map();
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400);
      const placeholders = batch.map(() => "?").join(",");
      const receipts=new Map(this.selectAll(`SELECT a.*,s.payload_json,w.head_oid AS cached_head_oid,d.binding_revision AS current_binding_revision
        FROM task_integration_acceptances a JOIN task_integration_snapshots s ON s.snapshot_id=a.snapshot_id
        JOIN tasks t ON t.id=a.task_id LEFT JOIN task_delivery_worktrees d ON d.task_id=t.id
        LEFT JOIN git_worktrees w ON w.worktree_id=d.worktree_id
        WHERE t.id IN (${placeholders}) AND a.receipt_id=json_extract(CASE WHEN json_valid(t.acceptance_assessment_json) THEN t.acceptance_assessment_json ELSE '{}' END,'$.integrationReceiptId')`,batch).map(row=>[row.task_id,row]));
      const childrenByParent=new Map([...this.readTaskDeliveryParticipation({parentTaskIds:batch}).byParentTaskId]
        .map(([id,children])=>[id,children.filter(child=>child.participates)]));
      const rows = this.selectAll(`SELECT t.*, p.hierarchy_revision AS root_revision,
        p.work_id AS parent_work_id, p.parent_task_id AS grandparent_task_id,
        d.worktree_id AS delivery_worktree_id, d.binding_revision
        FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_task_id
        LEFT JOIN task_delivery_worktrees d ON d.task_id=t.id
        WHERE t.id IN (${placeholders})`, batch);
      for (const row of rows) {
        const participatingChildren=childrenByParent.get(row.id) ?? [];
        row.child_count=participatingChildren.length;
        row.completed_count=participatingChildren.filter(child=>child.lifecycle_state==="done").length;
        let acceptance={state:row.child_count ? "not_recorded" : "not_applicable",receiptId:null,testedHeadOid:null,reason:null};
        const receipt=receipts.get(row.id);
        if(receipt && row.child_count) {
          let snapshot,assessment;
          try {snapshot=JSON.parse(receipt.payload_json);assessment=JSON.parse(row.acceptance_assessment_json);} catch { /* corrupt records cannot authorize */ }
          const children=childrenByParent.get(row.id) ?? [];
          const stale=!snapshot || !Array.isArray(snapshot.children) || assessment?.status!=="passed" || snapshot.hierarchyRevision!==row.hierarchy_revision
            || snapshot.bindingRevision!==receipt.current_binding_revision || snapshot.taskRevision!==row.revision
            || receipt.cached_head_oid && receipt.cached_head_oid!==snapshot.parentHeadOid
            || children.length!==snapshot.children.length || children.some((child,index)=>{
              const frozen=snapshot.children[index];
              return !frozen || child.id!==frozen.taskId || child.revision!==frozen.taskRevision
                || child.worktree_id!==frozen.worktreeId || child.binding_revision!==frozen.bindingRevision
                || child.head_oid && child.head_oid!==frozen.sourceHeadOid;
            });
          acceptance={state:stale ? "stale" : "not_proven",receiptId:receipt.receipt_id,testedHeadOid:snapshot?.parentHeadOid ?? null,
            reason:stale ? "INTEGRATION_ACCEPTANCE_STALE" : "INTEGRATION_ACCEPTANCE_RECHECK_REQUIRED"};
        }
        const valid = !row.parent_task_id || (row.root_revision && row.parent_work_id === row.work_id && !row.grandparent_task_id);
        const unavailable = !valid ? "TASK_PARENT_INVALID"
          : row.parent_task_id ? "TASK_MAX_DEPTH_EXCEEDED"
            : row.archived || row.lifecycle_state === "done" || row.deletion_status || row.creation_state !== "ready" ? "TASK_PARENT_UNAVAILABLE" : null;
        output.set(row.id, {
          version: 1, rootTaskId: row.parent_task_id ?? row.id, depth: row.parent_task_id ? 1 : 0,
          revision: row.root_revision ?? row.hierarchy_revision,
          childCount: row.child_count, completedChildCount: row.completed_count,
          activeChildCount: row.child_count - row.completed_count,
          deliveryWorktreeId: row.delivery_worktree_id ?? null, bindingRevision: row.binding_revision ?? null,
          actions: { createChild: { available: !unavailable, reason: unavailable } },
          acceptance
        });
      }
    }
    return output;
  }

  listTaskHierarchyPage({ workId, parentTaskId = null, query = "", includeCompleted = true, includeArchived = false, limit = 50, cursor = null }) {
    const text = String(query).trim().slice(0, 512);
    const mode = text ? "search" : parentTaskId ? "children" : "roots";
    if (!this.getWork(workId)) throw taskHierarchyError("WORK_NOT_FOUND", "Work not found", 404);
    if (parentTaskId) {
      const parent = this.getTask(parentTaskId);
      if (!parent || parent.work_id !== workId || parent.parent_task_id) throw taskHierarchyError("TASK_PARENT_UNAVAILABLE");
    }
    const queryHash = createHash("sha256").update(JSON.stringify([workId,mode,parentTaskId,text,includeCompleted,includeArchived])).digest("hex");
    let after = null;
    if (cursor) {
      try { after = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { /* reject below */ }
      if (after?.queryHash !== queryHash || !Number.isInteger(after?.rank)
        || typeof after.updatedAt !== "string" || typeof after.id !== "string") {
        throw taskHierarchyError("INVALID_CURSOR", "Cursor belongs to another hierarchy scope", 400);
      }
    }
    const count = Math.max(1, Math.min(100, Number(limit) || 50));
    const rank = "CASE WHEN lifecycle_state='done' THEN 1 ELSE 0 END";
    const terms = text.split(/\s+/u).filter(Boolean).slice(0,8).map(term => `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    const rows = this.selectAll(`SELECT *,${rank} AS completion_rank FROM tasks
      WHERE work_id=? AND ${active}
      ${mode === "roots" ? "AND parent_task_id IS NULL" : mode === "children" ? "AND parent_task_id=?" : ""}
      ${!includeCompleted ? "AND lifecycle_state<>'done'" : ""}
      ${!includeArchived ? "AND archived=0" : ""}
      ${terms.length ? `AND (${terms.map(() => "title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'").join(" OR ")})` : ""}
      ${after ? `AND (${rank}>? OR (${rank}=? AND updated_at<?) OR (${rank}=? AND updated_at=? AND id<?))` : ""}
      ORDER BY completion_rank ASC,updated_at DESC,id DESC LIMIT ?`,
    [workId,...(mode === "children" ? [parentTaskId] : []),...terms.flatMap(t => [t,t]),
      ...(after ? [after.rank,after.rank,after.updatedAt,after.rank,after.updatedAt,after.id] : []),count+1]);
    const items = rows.slice(0,count).map(({ completion_rank: _,...row }) => row);
    const parentIDs = [...new Set([...(parentTaskId ? [parentTaskId] : []),...items.map(t=>t.parent_task_id).filter(Boolean)])];
    const ancestors = parentIDs.length ? this.selectAll(`SELECT * FROM tasks WHERE work_id=? AND ${active} AND id IN (${parentIDs.map(()=>"?").join(",")})`, [workId,...parentIDs]) : [];
    const tail = rows[count-1];
    return { schemaVersion:1,scope:{workId,mode,parentTaskId,queryHash},items,ancestors,
      hasMore:rows.length>count,nextCursor:rows.length>count ? Buffer.from(JSON.stringify({queryHash,rank:tail.completion_rank,updatedAt:tail.updated_at,id:tail.id})).toString("base64url") : null };
  }

  getTaskDeliveryBinding(taskId) {
    return this.selectOne("SELECT * FROM task_delivery_worktrees WHERE task_id=?", [taskId]);
  }

  bindTaskDeliveryWorktree({ taskId, repositoryId, worktreeId, startupOperationId, baseContext = null }) {
    const existing = this.getTaskDeliveryBinding(taskId);
    if (existing) {
      if (existing.worktree_id !== worktreeId || existing.repository_id !== repositoryId) throw taskHierarchyError("TASK_DELIVERY_BINDING_CHANGED");
      return existing;
    }
    const proof = this.selectOne(`SELECT o.task_id,o.repository_id,o.worktree_id FROM work_session_startup_operations o
      JOIN work_session_startup_receipts r ON r.startup_operation_id=o.startup_operation_id
      WHERE o.startup_operation_id=? AND o.state='ready'`, [startupOperationId]);
    if (!proof || proof.task_id !== taskId || proof.repository_id !== repositoryId || proof.worktree_id !== worktreeId) {
      throw taskHierarchyError("TASK_DELIVERY_BINDING_UNPROVEN");
    }
    const now = new Date().toISOString();
    this.db.run(`INSERT INTO task_delivery_worktrees
      (task_id,repository_id,worktree_id,startup_operation_id,base_worktree_id,base_commit_oid,base_tree_oid,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, [taskId,repositoryId,worktreeId,startupOperationId,baseContext?.parentWorktreeId ?? null,
      baseContext?.baseCommitOid ?? null,baseContext?.baseTreeOid ?? null,now,now]);
    const task = this.getTask(taskId);
    this.bumpHierarchyRevision(task.parent_task_id ?? task.id);
    this.scheduleSave();
    return this.getTaskDeliveryBinding(taskId);
  }
}
