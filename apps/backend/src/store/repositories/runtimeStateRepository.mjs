import { parseJson } from "../storedJson.mjs";

// Uses the Store-owned connection; owns no database lifecycle.
export class RuntimeStateRepository {
  constructor({ getDatabase, selectOne }) {
    this.getDatabase = getDatabase;
    this.selectOne = selectOne;
  }

  get db() { return this.getDatabase(); }

  getRuntimeState(key) {
    const row = this.selectOne(
      "SELECT value_json FROM runtime_state WHERE key = ?",
      [String(key)]
    );
    return row ? parseJson(row.value_json, null) : null;
  }

  setRuntimeState(key, value) {
    this.db.run(
      `INSERT INTO runtime_state (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json=excluded.value_json,
         updated_at=excluded.updated_at`,
      [String(key), JSON.stringify(value ?? null), new Date().toISOString()]
    );
  }
}
