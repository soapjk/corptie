export function ensureProjectCodeReceiptTables({ db }) {
  db.run(`
    CREATE TABLE IF NOT EXISTS project_code_receipts (
      receipt_id TEXT PRIMARY KEY,
      receipt_type TEXT NOT NULL CHECK (receipt_type IN ('RepositorySourceSnapshotReceipt', 'SearchReceipt', 'ToolsetValidationReceipt')),
      logical_session_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      receipt_hash TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_project_code_receipts_session
    ON project_code_receipts(logical_session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_code_receipts_snapshot
    ON project_code_receipts(repository_id, worktree_id, source_fingerprint, receipt_type);
  `);
}
