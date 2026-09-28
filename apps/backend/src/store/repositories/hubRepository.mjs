import { randomUUID } from "node:crypto";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";

export class HubRepository {
  constructor({ getDatabase, selectAll, selectOne, scheduleSave }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
  }

  get db() {
    return this.getDatabase();
  }

  cacheHubIntent({ sessionId, taskId, workId, agentId, intentHash, result }) {
    const id = `hub_cache:${randomUUID()}`;
    this.db.run(
      `INSERT INTO hub_intent_cache (id, session_id, task_id, work_id, agent_id, intent_hash, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        sessionId ?? null,
        taskId ?? null,
        workId ?? null,
        agentId ?? null,
        intentHash,
        JSON.stringify(result ?? {}),
        createdAtFromOrNow()
      ]
    );
    this.scheduleSave();
    return id;
  }

  getHubIntentCache(intentHash, { agentId } = {}) {
    return this.selectOne(
      `SELECT * FROM hub_intent_cache
       WHERE intent_hash = ? AND agent_id IS ?
       ORDER BY created_at DESC LIMIT 1`,
      [intentHash, agentId ?? null]
    );
  }

  registerActiveTool(sessionId, toolName, toolDef = {}) {
    this.db.run(
      `INSERT OR REPLACE INTO session_active_tools (session_id, tool_name, tool_def_json, registered_at)
       VALUES (?, ?, ?, ?)`,
      [sessionId, toolName, JSON.stringify(toolDef), createdAtFromOrNow()]
    );
    this.scheduleSave();
  }

  listActiveTools(sessionId) {
    return this.selectAll(
      `SELECT * FROM session_active_tools WHERE session_id = ?`,
      [sessionId]
    );
  }
}
