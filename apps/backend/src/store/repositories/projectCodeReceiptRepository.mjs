// Query operations use the Store-owned connection; this module opens no database.
export class ProjectCodeReceiptRepository {
  constructor({ getDatabase, selectOne, scheduleSave }) {
    this.getDatabase = getDatabase;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
  }

  get db() { return this.getDatabase(); }

  putProjectCodeReceipt(input) {
    const receipt = input?.receipt;
    if (!receipt || receipt.receiptId !== input.receiptId || receipt.receiptHash !== input.receiptHash) {
      throw new Error("Project-code receipt identity does not match its persistence envelope.");
    }
    const existing = this.selectOne(
      "SELECT receipt_hash FROM project_code_receipts WHERE receipt_id=?",
      [input.receiptId]
    );
    if (existing && existing.receipt_hash !== receipt.receiptHash) throw new Error("PROJECT_CODE_RECEIPT_IMMUTABLE");
    if (!existing) this.db.run(
      `INSERT INTO project_code_receipts (
        receipt_id, receipt_type, logical_session_id, work_id, task_id,
        repository_id, worktree_id, source_fingerprint, receipt_hash, receipt_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.receiptId, input.receiptType, input.logicalSessionId, input.workId, input.taskId,
        input.repositoryId, input.worktreeId, input.sourceFingerprint, input.receiptHash,
        JSON.stringify(receipt), input.createdAt]
    );
    this.scheduleSave();
    return this.getProjectCodeReceipt(input.receiptId, input.logicalSessionId);
  }

  getProjectCodeReceipt(receiptId, logicalSessionId) {
    const row = this.selectOne(
      "SELECT * FROM project_code_receipts WHERE receipt_id=? AND logical_session_id=?",
      [receiptId, logicalSessionId]
    );
    return row ? {
      receiptType: row.receipt_type,
      receipt: JSON.parse(row.receipt_json),
      sourceFingerprint: row.source_fingerprint,
      repositoryId: row.repository_id,
      worktreeId: row.worktree_id,
      createdAt: row.created_at
    } : null;
  }

  getLatestProjectCodeSnapshot(logicalSessionId) {
    const row = this.selectOne(
      `SELECT * FROM project_code_receipts
       WHERE logical_session_id=? AND receipt_type='RepositorySourceSnapshotReceipt'
       ORDER BY created_at DESC LIMIT 1`,
      [logicalSessionId]
    );
    return row ? {
      receiptType: row.receipt_type,
      receipt: JSON.parse(row.receipt_json),
      sourceFingerprint: row.source_fingerprint,
      repositoryId: row.repository_id,
      worktreeId: row.worktree_id,
      createdAt: row.created_at
    } : null;
  }

  getProjectCodeReceiptById(receiptId) {
    const row = this.selectOne("SELECT * FROM project_code_receipts WHERE receipt_id=?", [receiptId]);
    return row ? {
      receiptType: row.receipt_type,
      logicalSessionId: row.logical_session_id,
      workId: row.work_id,
      taskId: row.task_id,
      repositoryId: row.repository_id,
      worktreeId: row.worktree_id,
      sourceFingerprint: row.source_fingerprint,
      receipt: JSON.parse(row.receipt_json),
      createdAt: row.created_at
    } : null;
  }
}
