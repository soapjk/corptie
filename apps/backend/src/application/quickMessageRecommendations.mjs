import { createHash } from "node:crypto";

export const QUICK_MESSAGE_DEFAULTS = ["继续", "开始开发", "给我一个完整方案"];
export const QUICK_MESSAGE_LIMIT = 8;
const DEFAULTS = new Set(QUICK_MESSAGE_DEFAULTS);
const COMMON = new Set([...QUICK_MESSAGE_DEFAULTS, "检查并运行测试", "继续开发", "开始实现", "总结一下", "修复这个问题", "提交更改", "Continue", "Run tests"]);
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
      const item = counts.get(key) ?? { text, count: 0, last: row.created_at ?? "", tasks: new Set(), taskCount: 0 };
      item.count += row.count ?? 1;
      item.taskCount = Math.max(item.taskCount, row.task_count ?? 0);
      if ((row.created_at ?? "") > item.last) { item.last = row.created_at; item.text = text; }
      if (row.task_id) item.tasks.add(row.task_id);
      counts.set(key, item);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last) || a.text.localeCompare(b.text));
  }
  const items = [], seen = new Set();
  function add(value, scope) {
    const key = value.text.toLocaleLowerCase("en-US");
    if (seen.has(key) || items.length >= QUICK_MESSAGE_LIMIT) return;
    seen.add(key);
    items.push({ id: DEFAULTS.has(value.text) ? `default:${value.text}` : createHash("sha256").update(key).digest("hex").slice(0, 20), text: value.text, scope, count: value.count });
  }
  for (const item of frequencies(taskRows).filter(item => item.count >= 2)) add(item, taskId ? "task" : "session");
  for (const item of frequencies(commonRows).filter(item => COMMON.has(item.text) && item.count >= 3 && Math.max(item.tasks.size, item.taskCount) >= 2)) add(item, "common");
  // Defaults only fill spare slots; learned versions keep their real usage.
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
  const eligible = `i.type = 'userMessage' AND COALESCE(i.presentation_role, '') IN ('', 'user')
    AND COALESCE(i.status, '') NOT IN ('failed', 'cancelled') AND length(i.text) BETWEEN 1 AND 80 AND s.deleted_at IS NULL
    AND CASE WHEN json_valid(COALESCE(i.raw_metadata_json, '{}'))
      THEN COALESCE(json_array_length(i.raw_metadata_json, '$.images'), 0) = 0 ELSE 0 END`;
  // Aggregate durable history in SQLite; only bounded candidate counts leave
  // the read worker. Recent one-off messages must not evict older repeats.
  const taskRows = store.selectAll(`SELECT i.text, MAX(i.created_at) AS created_at, COUNT(*) AS count, s.task_id
    FROM session_items i JOIN sessions s ON s.id = i.session_id
    WHERE ${eligible} AND ${session.taskId ? "s.task_id = ?" : "s.id = ?"}
    GROUP BY i.text ORDER BY count DESC, created_at DESC, i.text LIMIT 2000`, [scopeId]);
  // Only the small, explicit common-command allowlist is aggregated globally;
  // arbitrary history and tool traffic never enter the common recommendation set.
  const commonTexts = [...COMMON];
  const commonRows = store.selectAll(`SELECT i.text, MAX(i.created_at) AS created_at, COUNT(*) AS count,
    COUNT(DISTINCT s.task_id) AS task_count FROM session_items i JOIN sessions s ON s.id = i.session_id
    WHERE ${eligible} AND trim(i.text) IN (${commonTexts.map(() => "?").join(",")})
    GROUP BY i.text ORDER BY count DESC, created_at DESC LIMIT 2000`, commonTexts);
  const value = rankQuickMessages(taskRows, commonRows, session.taskId);
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(scope, { at: Date.now(), watermark, value });
  return value;
}
