import { AgentWorkQueueRepository } from './repositories/agentWorkQueueRepository.mjs';

// A claim and its acknowledgement live in one transaction. A lost Worker reply
// is reconciled by this identity; it must never cause a second Provider start.
export function migrateAgentClaimReceipts(db) {
  db.run(`CREATE TABLE IF NOT EXISTS agent_operation_claims (
    task_id TEXT PRIMARY KEY REFERENCES agent_operations(task_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL UNIQUE, started_at TEXT NOT NULL)`);
}
export function executeAgentClaim(db, input, { inspectOnly = false } = {}) {
  const repository = new AgentWorkQueueRepository({ getDatabase: () => db,
    selectAll: (...args) => db.all(...args), selectOne: (...args) => db.get(...args), scheduleSave() {} });
  if (inspectOnly) {
    const receipt = db.get('SELECT task_id,started_at FROM agent_operation_claims WHERE request_id=?', [input.requestId]);
    const item = receipt && repository.getAgentTask(receipt.task_id);
    return item?.status === 'running' && item.startedAt === receipt.started_at ? item : null;
  }
  db.run('BEGIN IMMEDIATE');
  try {
    const replay = db.get('SELECT task_id FROM agent_operation_claims WHERE request_id=?', [input.requestId]);
    let result = null;
    if (replay) result = executeAgentClaim(db, input, { inspectOnly: true });
    else {
      const item = repository.getAgentTask(input.taskId);
      if (item?.sessionId === input.sessionId && item.updatedAt === input.updatedAt && item.status === 'queued') {
        result = repository.claimAgentTask(input.taskId);
        if (result) db.run(`INSERT INTO agent_operation_claims(task_id,request_id,started_at) VALUES(?,?,?)
          ON CONFLICT(task_id) DO UPDATE SET request_id=excluded.request_id,started_at=excluded.started_at`,
          [result.taskId,input.requestId,result.startedAt]);
      }
    }
    db.run('COMMIT');
    return result;
  } catch (error) { db.run('ROLLBACK'); throw error; }
}
