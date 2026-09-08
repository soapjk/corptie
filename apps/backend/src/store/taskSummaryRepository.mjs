import { createHash } from "node:crypto";
import { TASK_SUMMARY_PROMPT_VERSION, taskSummaryDefinitionHash } from "../application/taskSummaryContract.mjs";
import { validateEntityName } from "../domain/workTaskValidation.mjs";

export function migrateTaskSummary(store) {
  store.ensureColumn("tasks", "user_summary_json", "TEXT");
  store.db.run(`CREATE TABLE IF NOT EXISTS task_summary_jobs (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'dirty',
    basis_hash TEXT,
    basis_json TEXT,
    operation_id TEXT,
    error_code TEXT,
    requested_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  )`);
  store.db.run(`CREATE INDEX IF NOT EXISTS task_summary_jobs_pending
    ON task_summary_jobs(status, requested_at, task_id)`);
  store.db.run(`CREATE TABLE IF NOT EXISTS task_summary_versions (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    basis_hash TEXT NOT NULL,
    input_hash TEXT,
    content_hash TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(task_id, generation)
  )`);
}

export class TaskSummaryRepository {
  constructor(store) { this.store = store; }

  basis(taskID) {
    const task = this.store.getTask(taskID);
    if (!task || task.deletion_status === "deleting" || task.deletion_status === "deleted" || task.archived) return null;
    const session = task.current_session_id ? this.store.getSession(task.current_session_id) : null;
    if (!session || session.archived) return null;
    const timeline = this.store.selectOne("SELECT revision FROM session_timeline_revisions WHERE session_id=?", [session.id]);
    const basis = {
      taskID, taskRevision: Number(task.revision ?? 1), sessionID: session.id,
      timelineRevision: Number(timeline?.revision ?? 0),
      definitionHash: taskSummaryDefinitionHash(task),
      executionStatus: session.executionStatus ?? session.status,
      lifecycleState: task.lifecycle_state,
      promptVersion: TASK_SUMMARY_PROMPT_VERSION
    };
    return { ...basis, hash: hash(basis) };
  }

  get(taskID) { return this.store.selectOne("SELECT * FROM task_summary_jobs WHERE task_id=?", [taskID]); }

  *pending() {
    // Keyset pages avoid starving eligible work behind the first 64 busy
    // Tasks. Unlike OFFSET, cancelling an invalid job cannot skip a later row.
    let cursor = null;
    while (true) {
      const page = this.store.selectAll(`SELECT jobs.task_id, jobs.requested_at FROM task_summary_jobs jobs
        WHERE jobs.status='dirty'
        ${cursor ? "AND (jobs.requested_at, jobs.task_id) > (?, ?)" : ""}
        ORDER BY jobs.requested_at, jobs.task_id LIMIT 64`,
      cursor ? [cursor.requested_at, cursor.task_id] : []);
      if (!page.length) return;
      cursor = page.at(-1);
      yield* page;
      if (page.length < 64) return;
    }
  }

  request(taskID) {
    if (!this.basis(taskID)) return null;
    return this.store.runInTransaction(() => {
      const time = new Date().toISOString();
      this.store.db.run(`INSERT INTO task_summary_jobs(task_id, generation, status, requested_at)
        VALUES (?, 1, 'dirty', ?) ON CONFLICT(task_id) DO UPDATE SET
        generation=generation+1, status='dirty', requested_at=excluded.requested_at,
        error_code=NULL`, [taskID, time]);
      this.publish(taskID, "stale");
      return this.get(taskID);
    });
  }

  claim(taskID, operationID) {
    return this.store.runInTransaction(() => {
      const job = this.get(taskID);
      const basis = this.basis(taskID);
      if (!basis || job?.status !== "dirty") return null;
      this.store.db.run(`UPDATE task_summary_jobs SET status='running', basis_hash=?, basis_json=?,
        operation_id=?, started_at=?, finished_at=NULL WHERE task_id=? AND generation=? AND status='dirty'`,
      [basis.hash, JSON.stringify(basis), operationID, new Date().toISOString(), taskID, job.generation]);
      if (this.store.db.getRowsModified() !== 1) return null;
      this.publish(taskID, "generating");
      return { taskID, generation: job.generation, operationID, basis };
    });
  }

  complete(claim, summary, metadata = {}) {
    return this.store.runInTransaction(() => {
      const job = this.get(claim.taskID);
      const currentBasis = this.basis(claim.taskID);
      if (!job || job.generation !== claim.generation || job.operation_id !== claim.operationID || job.status !== "running") return false;
      if (!currentBasis || currentBasis.hash !== claim.basis.hash) {
        if (currentBasis) this.request(claim.taskID);
        else this.cancel(claim.taskID);
        return false;
      }
      const time = new Date().toISOString();
      let titleChange = null;
      if (summary.suggestedTitle) {
        validateEntityName(summary.suggestedTitle, "title", "Task");
        if (summary.suggestedTitle.length > 64) throw new Error("Suggested title exceeds limit.");
        const task = this.store.getTask(claim.taskID);
        if (task.title !== summary.suggestedTitle) {
          titleChange = { from: task.title, to: summary.suggestedTitle };
          // Local product-owned projection, not a tool granted to the background
          // Session. Same transaction and stale-result checks as the summary.
          // Do not touch updated_at or trigger another summary generation.
          this.store.db.run("UPDATE tasks SET title=?, resource_version=resource_version+1 WHERE id=?",
            [summary.suggestedTitle, claim.taskID]);
        }
      }
      const content = { ...summary, basis: titleChange ? this.basis(claim.taskID) : claim.basis,
        ...(titleChange ? { titleChange } : {}),
        generatedAt: time, providerID: metadata.providerId ?? null,
        model: metadata.model ?? null, operationID: claim.operationID,
        generation: claim.generation, inputHash: metadata.inputHash ?? null };
      // History and the visible projection commit together, after all stale
      // result checks. Store no duplicate transcript or private input body.
      this.store.db.run(`INSERT INTO task_summary_versions
        (task_id,generation,operation_id,basis_hash,input_hash,content_hash,content_json,created_at)
        VALUES(?,?,?,?,?,?,?,?)`, [claim.taskID, claim.generation, claim.operationID,
        claim.basis.hash, content.inputHash, hash(content), JSON.stringify(content), time]);
      this.store.db.run("UPDATE task_summary_jobs SET status='ready', finished_at=?, error_code=NULL WHERE task_id=?", [time, claim.taskID]);
      this.publish(claim.taskID, "ready", content);
      return true;
    });
  }

  fail(claim, errorCode) {
    return this.store.runInTransaction(() => {
      this.store.db.run(`UPDATE task_summary_jobs SET status='failed', error_code=?, finished_at=?
        WHERE task_id=? AND generation=? AND operation_id=? AND status='running'`,
      [errorCode, new Date().toISOString(), claim.taskID, claim.generation, claim.operationID]);
      if (this.store.db.getRowsModified() !== 1) return false;
      this.publish(claim.taskID, "failed", undefined, errorCode);
      return true;
    });
  }

  block(taskID, errorCode) {
    return this.store.runInTransaction(() => {
      const job = this.get(taskID);
      if (job?.status === "blocked" && job.error_code === errorCode) return;
      const time = new Date().toISOString();
      this.store.db.run(`INSERT INTO task_summary_jobs(task_id,generation,status,error_code,requested_at,finished_at)
        VALUES(?,1,'blocked',?,?,?) ON CONFLICT(task_id) DO UPDATE SET
        generation=generation+1,status='blocked',error_code=excluded.error_code,finished_at=excluded.finished_at`,
      [taskID, errorCode, time, time]);
      this.publish(taskID, "blocked", undefined, errorCode);
    });
  }

  cancel(taskID) {
    this.store.runInTransaction(() => {
      this.store.db.run("UPDATE task_summary_jobs SET generation=generation+1, status='cancelled', finished_at=? WHERE task_id=?", [new Date().toISOString(), taskID]);
      // A newly persisted Task has no companion Session or summary yet.
      // Cancelling nonexistent summary work must not mutate its resource version
      // between Task creation and the authoritative Session startup check.
      if (this.store.getTask(taskID)?.user_summary_json != null) {
        this.publish(taskID, "stale");
      }
    });
  }

  publish(taskID, state, content, errorCode = null) {
    const task = this.store.getTask(taskID);
    if (!task) return;
    let previous = null;
    try { previous = JSON.parse(task.user_summary_json ?? "null"); } catch {}
    const json = JSON.stringify({ state, content: content ?? previous?.content ?? null,
      ...(errorCode ? { errorCode } : {}) });
    if (task.user_summary_json === json) return;
    // Do not update updated_at: summary maintenance must not reorder Tasks.
    this.store.db.run("UPDATE tasks SET user_summary_json=?, resource_version=resource_version+1 WHERE id=?", [json, taskID]);
    this.store.scheduleSave();
  }
}

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
