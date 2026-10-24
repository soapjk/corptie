import { createHash } from "node:crypto";

const active = "COALESCE(deletion_status,'') <> 'deleted' AND creation_state='ready'";
export function taskHierarchyError(code, message = code, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
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
    return Boolean(this.selectOne(`SELECT 1 FROM tasks WHERE parent_task_id=? AND COALESCE(deletion_status,'')<>'deleted'
      AND (creation_state<>'failed' OR current_session_id IS NOT NULL) LIMIT 1`, [taskId]));
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
    const member = this.selectOne(`SELECT t.id FROM task_delivery_worktrees d
      JOIN tasks t ON t.id=d.task_id JOIN git_worktrees w ON w.worktree_id=d.worktree_id
      WHERE (${predicates.join(" OR ")}) AND (t.parent_task_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=t.id AND COALESCE(c.deletion_status,'')<>'deleted')) LIMIT 1`,
    [...ids,...locations,...locations]);
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
          return task && !task.archived && !task.deletion_status && task.lifecycle_state!=="done" && task.hierarchy_revision===group.scope.expectedHierarchyRevision
            && group.bindings.every(item=>{
              const binding=this.getTaskDeliveryBinding(item.taskId),child=this.getTask(item.taskId);
              return binding?.worktree_id===item.worktreeId && binding.binding_revision===item.bindingRevision
                && child?.work_id===task.work_id && (child.parent_task_id ?? null)===item.parentTaskId;
            });
        });
        if(rootsFresh && graphMembers.length && graphMembers.every(tree=>reserved.has(tree.worktree_id))
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
      const childrenByParent=new Map();
      for(const child of this.selectAll(`SELECT t.id,t.parent_task_id,t.revision,d.worktree_id,d.binding_revision,w.head_oid
        FROM tasks t LEFT JOIN task_delivery_worktrees d ON d.task_id=t.id LEFT JOIN git_worktrees w ON w.worktree_id=d.worktree_id
        WHERE t.parent_task_id IN (${placeholders}) AND COALESCE(t.deletion_status,'')<>'deleted' AND t.creation_state='ready' ORDER BY t.id`,batch)) {
        const children=childrenByParent.get(child.parent_task_id) ?? [];
        children.push(child);childrenByParent.set(child.parent_task_id,children);
      }
      const rows = this.selectAll(`SELECT t.*, p.hierarchy_revision AS root_revision,
        p.work_id AS parent_work_id, p.parent_task_id AS grandparent_task_id,
        d.worktree_id AS delivery_worktree_id, d.binding_revision,
        COALESCE(c.child_count,0) AS child_count, COALESCE(c.completed_count,0) AS completed_count
        FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_task_id
        LEFT JOIN task_delivery_worktrees d ON d.task_id=t.id
        LEFT JOIN (SELECT parent_task_id,COUNT(*) AS child_count,
          SUM(CASE WHEN lifecycle_state='done' THEN 1 ELSE 0 END) AS completed_count
          FROM tasks WHERE parent_task_id IN (${placeholders}) AND ${active} GROUP BY parent_task_id) c ON c.parent_task_id=t.id
        WHERE t.id IN (${placeholders})`, [...batch,...batch]);
      for (const row of rows) {
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
