import { createHash } from "node:crypto";

const active = "COALESCE(deletion_status,'') <> 'deleted'";
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
    if (parent.archived || parent.lifecycle_state === "done" || parent.deletion_status) {
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
    return Boolean(this.selectOne(`SELECT 1 FROM tasks WHERE parent_task_id=? AND ${active} LIMIT 1`, [taskId]));
  }

  assertStandaloneWorktreeMutation({ worktreeIds = [], paths = [] }) {
    if (!worktreeIds.length && !paths.length) return;
    const ids = [...new Set(worktreeIds.filter(Boolean))];
    const locations = [...new Set(paths.filter(Boolean))];
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
    if (member) throw taskHierarchyError("TASK_HIERARCHY_SCOPE_REQUIRED", "Use the parent-scoped integration workflow; legacy main-branch operations cannot mutate this delivery.");
  }

  hierarchySummaries(taskIds) {
    const ids = [...new Set(taskIds)];
    const output = new Map();
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.selectAll(`SELECT t.*, p.hierarchy_revision AS root_revision,
        p.work_id AS parent_work_id, p.parent_task_id AS grandparent_task_id,
        d.worktree_id AS delivery_worktree_id, d.binding_revision,
        COALESCE(c.child_count,0) AS child_count, COALESCE(c.completed_count,0) AS completed_count
        FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_task_id
        LEFT JOIN task_delivery_worktrees d ON d.task_id=t.id
        LEFT JOIN (SELECT parent_task_id,COUNT(*) AS child_count,
          SUM(CASE WHEN lifecycle_state='done' THEN 1 ELSE 0 END) AS completed_count
          FROM tasks WHERE parent_task_id IS NOT NULL AND ${active} GROUP BY parent_task_id) c ON c.parent_task_id=t.id
        WHERE t.id IN (${placeholders})`, batch);
      for (const row of rows) {
        const valid = !row.parent_task_id || (row.root_revision && row.parent_work_id === row.work_id && !row.grandparent_task_id);
        const unavailable = !valid ? "TASK_PARENT_INVALID"
          : row.parent_task_id ? "TASK_MAX_DEPTH_EXCEEDED"
            : row.archived || row.lifecycle_state === "done" || row.deletion_status ? "TASK_PARENT_UNAVAILABLE" : null;
        output.set(row.id, {
          version: 1, rootTaskId: row.parent_task_id ?? row.id, depth: row.parent_task_id ? 1 : 0,
          revision: row.root_revision ?? row.hierarchy_revision,
          childCount: row.child_count, completedChildCount: row.completed_count,
          activeChildCount: row.child_count - row.completed_count,
          deliveryWorktreeId: row.delivery_worktree_id ?? null, bindingRevision: row.binding_revision ?? null,
          actions: { createChild: { available: !unavailable, reason: unavailable } },
          acceptance: { state: row.child_count ? "not_recorded" : "not_applicable", receiptId: null, testedHeadOid: null, reason: null }
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
