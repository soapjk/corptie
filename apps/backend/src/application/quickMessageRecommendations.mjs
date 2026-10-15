import { createHash } from "node:crypto";

export const QUICK_MESSAGE_DEFAULTS = ["继续", "开始开发", "给我一个完整方案"];
export const QUICK_MESSAGE_LIMIT = 8;
const DEFAULTS = new Set(QUICK_MESSAGE_DEFAULTS);
export const QUICK_MESSAGE_COMMON = [...QUICK_MESSAGE_DEFAULTS, "检查并运行测试", "继续开发", "开始实现", "总结一下", "修复这个问题", "提交更改", "Continue", "Run tests"];
const COMMON = new Set(QUICK_MESSAGE_COMMON);
const caches = new WeakMap();

export function eligibleQuickMessage(text) {
  if (typeof text !== "string" || /[\r\n\t]/u.test(text)) return null;
  const value = text.trim().replace(/ +/gu, " ");
  if (!value || [...value].length > 40 || /[\/@\\`:<>{}=]|\d{3,}|password|secret|token|api.?key|sk-|密码|口令|密钥|验证码|www\./iu.test(value)) return null;
  return value;
}

// Only eligibility/text changes affect statistics. Status/echo churn for the
// same accepted user message and streaming Agent output do not wake readers.
export function quickMessageContribution(row) {
  if (!row || row.type !== "userMessage" || !["", "user"].includes(row.presentation_role ?? "")
      || ["failed", "cancelled"].includes(row.status)) return null;
  try { if (JSON.parse(row.raw_metadata_json ?? "{}").images?.length) return null; } catch { return null; }
  return eligibleQuickMessage(row.text);
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
  const build = store.selectOne("SELECT ready,common_revision FROM quick_message_build_v1 WHERE id=1");
  const revisions = store.selectAll(`SELECT s.id,COALESCE(r.revision,0) AS revision FROM sessions s
    LEFT JOIN quick_message_revisions_v1 r ON r.session_id=s.id
    WHERE ${session.taskId ? "s.task_id=?" : "s.id=?"} AND s.deleted_at IS NULL ORDER BY s.id`, [scopeId]);
  const watermark = JSON.stringify([1, build.ready, build.common_revision, revisions]);
  if (existing?.watermark === watermark) return existing.value;
  if (!build.ready) return { ...rankQuickMessages([], [], session.taskId), preparationStatus: "building" };
  const taskRows = store.selectAll(`SELECT q.text,MAX(q.last_at) AS created_at,SUM(q.count) AS count,s.task_id
    FROM sessions s JOIN quick_message_stats_v1 q ON q.session_id=s.id
    WHERE ${session.taskId ? "s.task_id=?" : "s.id=?"} AND s.deleted_at IS NULL
    GROUP BY q.text ORDER BY count DESC,created_at DESC,q.text LIMIT 2000`, [scopeId]);
  const commonTexts = [...COMMON];
  const commonRows = store.selectAll(`SELECT q.text,MAX(q.last_at) AS created_at,SUM(q.count) AS count,
    COUNT(DISTINCT s.task_id) AS task_count FROM quick_message_stats_v1 q JOIN sessions s ON s.id=q.session_id
    WHERE trim(q.text) IN (${commonTexts.map(() => "?").join(",")}) AND s.deleted_at IS NULL
    GROUP BY q.text ORDER BY count DESC,created_at DESC LIMIT 2000`, commonTexts);
  const value = rankQuickMessages(taskRows, commonRows, session.taskId);
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(scope, { watermark, value });
  return value;
}
