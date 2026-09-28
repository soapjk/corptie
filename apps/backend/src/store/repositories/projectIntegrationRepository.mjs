import { randomUUID } from "node:crypto";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { parseJson } from "../storedJson.mjs";
import { requiredText } from "../validation.mjs";

export class ProjectIntegrationRepository {
  constructor({ getDatabase, selectAll, selectOne, scheduleSave, runInTransaction }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
    this.runInTransaction = runInTransaction;
  }

  get db() {
    return this.getDatabase();
  }

  createProjectIntegrationRun(input) {
    const id = input.id ?? `integration:${randomUUID()}`;
    const timestamp = createdAtFromOrNow();
    this.runInTransaction(() => {
      this.db.run(
        `INSERT INTO project_integration_runs (
           id, repository_id, work_id, status, main_head_before,
           main_head_after, error, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
        [id, input.repositoryId, input.workId, input.status ?? "running", input.mainHeadBefore, timestamp, timestamp]
      );
      for (const [index, item] of (input.items ?? []).entries()) {
        this.db.run(
          `INSERT INTO project_integration_items (
             run_id, worktree_id, task_id, branch_name, source_head_oid,
             ordinal, status, conflict_files_json, merged_main_head, error, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', NULL, NULL, ?)`,
          [
            id,
            item.worktreeId,
            item.taskId,
            item.branchName ?? null,
            item.sourceHeadOid,
            item.ordinal ?? index,
            item.status ?? "pending",
            timestamp
          ]
        );
      }
    });
    this.scheduleSave();
    return this.getProjectIntegrationRun(id);
  }

  getProjectIntegrationRun(id) {
    const row = this.selectOne(`SELECT * FROM project_integration_runs WHERE id = ?`, [id]);
    if (!row) return null;
    const items = this.selectAll(
      `SELECT * FROM project_integration_items WHERE run_id = ? ORDER BY ordinal ASC`,
      [id]
    ).map(projectIntegrationItemFromRow);
    return projectIntegrationRunFromRow(row, items);
  }

  listProjectIntegrationRuns(limit = null) {
    const boundedLimit = limit == null ? null : Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = this.selectAll(
      `SELECT id FROM project_integration_runs
       ORDER BY created_at ${boundedLimit == null ? "ASC" : "DESC LIMIT ?"}`,
      boundedLimit == null ? [] : [boundedLimit]
    );
    return rows.map((row) => this.getProjectIntegrationRun(row.id));
  }

  getLatestProjectIntegrationRun(repositoryId, workId) {
    const row = this.selectOne(
      `SELECT * FROM project_integration_runs
       WHERE repository_id = ? AND work_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [repositoryId, workId]
    );
    return row ? this.getProjectIntegrationRun(row.id) : null;
  }

  updateProjectIntegrationRun(id, patch = {}) {
    const current = this.getProjectIntegrationRun(id);
    if (!current) return null;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    this.db.run(
      `UPDATE project_integration_runs SET
         status=?, main_head_after=?, integration_worktree_id=?, integration_worktree_path=?,
         integration_branch=?, conflict_task_id=?, conflict_session_id=?, error=?,
         updated_at=?, completed_at=? WHERE id=?`,
      [
        has("status") ? patch.status : current.status,
        has("mainHeadAfter") ? patch.mainHeadAfter : current.mainHeadAfter,
        has("integrationWorktreeId") ? patch.integrationWorktreeId : current.integrationWorktreeId,
        has("integrationWorktreePath") ? patch.integrationWorktreePath : current.integrationWorktreePath,
        has("integrationBranch") ? patch.integrationBranch : current.integrationBranch,
        has("conflictTaskId") ? patch.conflictTaskId : current.conflictTaskId,
        has("conflictSessionId") ? patch.conflictSessionId : current.conflictSessionId,
        has("error") ? patch.error : current.error,
        createdAtFromOrNow(),
        has("completedAt") ? patch.completedAt : current.completedAt,
        id
      ]
    );
    this.scheduleSave();
    return this.getProjectIntegrationRun(id);
  }

  updateProjectIntegrationItem(runId, worktreeId, patch = {}) {
    const current = this.selectOne(
      `SELECT * FROM project_integration_items WHERE run_id = ? AND worktree_id = ?`,
      [runId, worktreeId]
    );
    if (!current) return null;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    this.db.run(
      `UPDATE project_integration_items SET
         status=?, conflict_files_json=?, merged_main_head=?, error=?, updated_at=?
       WHERE run_id=? AND worktree_id=?`,
      [
        has("status") ? patch.status : current.status,
        has("conflictFiles") ? JSON.stringify(patch.conflictFiles ?? []) : current.conflict_files_json,
        has("mergedMainHead") ? patch.mergedMainHead : current.merged_main_head,
        has("error") ? patch.error : current.error,
        createdAtFromOrNow(),
        runId,
        worktreeId
      ]
    );
    this.scheduleSave();
    return projectIntegrationItemFromRow(this.selectOne(
      `SELECT * FROM project_integration_items WHERE run_id = ? AND worktree_id = ?`,
      [runId, worktreeId]
    ));
  }

  createWorktreeIntegrationJob(input) {
    const id = input.id ?? `worktree_integration:${randomUUID()}`;
    const timestamp = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO worktree_integration_jobs (
         id, repository_id, status, phase, plan_fingerprint, details_json,
         error, created_at, updated_at, confirmed_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      [
        id,
        requiredText(input.repositoryId, "repositoryId"),
        input.status ?? "awaiting_confirmation",
        input.phase ?? "preflight_complete",
        requiredText(input.planFingerprint, "planFingerprint"),
        JSON.stringify(input.details ?? {}),
        input.error ?? null,
        timestamp,
        timestamp
      ]
    );
    this.scheduleSave();
    return this.getWorktreeIntegrationJob(id);
  }

  getWorktreeIntegrationJob(id) {
    const row = this.selectOne(`SELECT * FROM worktree_integration_jobs WHERE id = ?`, [id]);
    return worktreeIntegrationJobFromRow(row);
  }

  listWorktreeIntegrationJobs(repositoryId = null) {
    const rows = repositoryId
      ? this.selectAll(
          `SELECT * FROM worktree_integration_jobs WHERE repository_id = ? ORDER BY created_at DESC`,
          [repositoryId]
        )
      : this.selectAll(`SELECT * FROM worktree_integration_jobs ORDER BY created_at DESC`);
    return rows.map(worktreeIntegrationJobFromRow);
  }

  getLatestWorktreeIntegrationJob(repositoryId) {
    const row = this.selectOne(
      `SELECT * FROM worktree_integration_jobs WHERE repository_id = ? ORDER BY created_at DESC LIMIT 1`,
      [repositoryId]
    );
    return worktreeIntegrationJobFromRow(row);
  }

  listRecoverableWorktreeIntegrationJobs() {
    return this.selectAll(
      `SELECT * FROM worktree_integration_jobs
       WHERE status IN ('queued', 'running', 'cancellation_requested', 'replanning')
          OR (status = 'paused' AND json_extract(details_json, '$.conflictAutomation.status') = 'running')
       ORDER BY created_at ASC`
    ).map(worktreeIntegrationJobFromRow);
  }

  updateWorktreeIntegrationJob(id, patch = {}) {
    const current = this.getWorktreeIntegrationJob(id);
    if (!current) return null;
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    this.db.run(
      `UPDATE worktree_integration_jobs SET
         status=?, phase=?, details_json=?, error=?, updated_at=?, confirmed_at=?, completed_at=?
       WHERE id=?`,
      [
        has("status") ? patch.status : current.status,
        has("phase") ? patch.phase : current.phase,
        JSON.stringify(has("details") ? patch.details : current.details),
        has("error") ? patch.error : current.error,
        createdAtFromOrNow(),
        has("confirmedAt") ? patch.confirmedAt : current.confirmedAt,
        has("completedAt") ? patch.completedAt : current.completedAt,
        id
      ]
    );
    this.scheduleSave();
    return this.getWorktreeIntegrationJob(id);
  }
}

function projectIntegrationRunFromRow(row, items = []) {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    workId: row.work_id,
    status: row.status,
    mainHeadBefore: row.main_head_before,
    mainHeadAfter: row.main_head_after ?? null,
    integrationWorktreeId: row.integration_worktree_id ?? null,
    integrationWorktreePath: row.integration_worktree_path ?? null,
    integrationBranch: row.integration_branch ?? null,
    conflictTaskId: row.conflict_task_id ?? null,
    conflictSessionId: row.conflict_session_id ?? null,
    error: row.error ?? null,
    items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null
  };
}

function projectIntegrationItemFromRow(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    worktreeId: row.worktree_id,
    taskId: row.task_id,
    branchName: row.branch_name ?? null,
    sourceHeadOid: row.source_head_oid,
    ordinal: Number(row.ordinal),
    status: row.status,
    conflictFiles: parseJson(row.conflict_files_json, []),
    mergedMainHead: row.merged_main_head ?? null,
    error: row.error ?? null,
    updatedAt: row.updated_at
  };
}

function worktreeIntegrationJobFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    repositoryId: row.repository_id,
    status: row.status,
    phase: row.phase,
    planFingerprint: row.plan_fingerprint,
    details: parseJson(row.details_json, {}),
    error: row.error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at ?? null,
    completedAt: row.completed_at ?? null
  };
}
