import { createHash } from "node:crypto";

export const QUICK_MESSAGE_DEFAULTS = ["继续", "开始开发", "给我一个完整方案", "检查并运行测试"];
const COMMON = new Set([...QUICK_MESSAGE_DEFAULTS, "继续开发", "开始实现", "总结一下", "修复这个问题", "提交更改", "Continue", "Run tests"]);
const caches = new WeakMap();

export function eligibleQuickMessage(text) {
  if (typeof text !== "string" || /[\r\n\t]/u.test(text)) return null;
  const value = text.trim().replace(/ +/gu, " ");
  if (!value || [...value].length > 40 || /[\/@\\`:<>{}=]|\d{3,}|password|secret|token|api.?key|sk-|密码|口令|密钥|验证码|www\./iu.test(value)) return null;
  return value;
}

export function rankQuickMessages(taskRows, commonRows, taskId) {
  function frequencies(rows) {
    const counts = new Map();
    for (const row of rows) {
      const text = eligibleQuickMessage(row.text);
      if (!text) continue;
      try { if (JSON.parse(row.raw_metadata_json ?? "{}").images?.length) continue; } catch { continue; }
      const key = text.toLocaleLowerCase("en-US");
      const item = counts.get(key) ?? { text, count: 0, last: row.created_at ?? "", tasks: new Set() };
      item.count += 1;
      if ((row.created_at ?? "") > item.last) { item.last = row.created_at; item.text = text; }
      if (row.task_id) item.tasks.add(row.task_id);
      counts.set(key, item);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last) || a.text.localeCompare(b.text));
  }
  const items = [], seen = new Set();
  function add(value, scope) {
    const key = value.text.toLocaleLowerCase("en-US");
    if (seen.has(key) || items.length >= 6) return;
    seen.add(key);
    items.push({ id: createHash("sha256").update(key).digest("hex").slice(0, 20), text: value.text, scope, count: value.count });
  }
  for (const item of frequencies(taskRows).filter(item => item.count >= 2).slice(0, 4)) add(item, taskId ? "task" : "session");
  for (const item of frequencies(commonRows).filter(item => COMMON.has(item.text) && item.count >= 3 && item.tasks.size >= 2)) add(item, "common");
  for (const text of QUICK_MESSAGE_DEFAULTS) add({ text, count: 0 }, "default");
  return { schemaVersion: 1, taskId: taskId ?? null, items };
}

// Runs in the existing read-only SQLite worker, not the backend event loop.
// Scope spans every Session of the Task, including earlier Provider bindings.
export function readQuickMessages(store, sessionId) {
  const session = store.getSession(sessionId);
  if (!session) throw Object.assign(new Error("Session unavailable"), { code: "SESSION_NOT_AVAILABLE", status: 404 });
  const scopeId = session.taskId ?? sessionId;
  const scope = `${session.taskId ? "task" : "session"}:${scopeId}`;
  let cache = caches.get(store);
  if (!cache) caches.set(store, cache = new Map());
  const existing = cache.get(scope);
  const watermark = store.selectOne("SELECT COALESCE(MAX(rowid), 0) AS value FROM session_items").value;
  if (existing && existing.watermark === watermark && Date.now() - existing.at < 15_000) return existing.value;
  const columns = "i.text, i.raw_metadata_json, i.created_at, s.task_id";
  const eligible = "i.type = 'userMessage' AND COALESCE(i.presentation_role, '') IN ('', 'user') AND COALESCE(i.status, '') NOT IN ('failed', 'cancelled') AND length(i.text) BETWEEN 1 AND 80 AND s.deleted_at IS NULL";
  const taskRows = store.selectAll(`SELECT ${columns} FROM session_items i JOIN sessions s ON s.id = i.session_id
    WHERE ${eligible} AND ${session.taskId ? "s.task_id = ?" : "s.id = ?"}
    ORDER BY i.created_at DESC, i.id DESC LIMIT 2000`, [scopeId]);
  // Bound the cross-Task sample; tool-heavy histories never trigger a full
  // database-wide scan or transport any raw history to either frontend.
  const commonRows = store.selectAll(`SELECT ${columns} FROM session_items i JOIN sessions s ON s.id = i.session_id
    WHERE i.rowid > (SELECT COALESCE(MAX(rowid), 0) - 20000 FROM session_items) AND ${eligible}
    ORDER BY i.rowid DESC LIMIT 2000`);
  const value = rankQuickMessages(taskRows, commonRows, session.taskId);
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(scope, { at: Date.now(), watermark, value });
  return value;
}
