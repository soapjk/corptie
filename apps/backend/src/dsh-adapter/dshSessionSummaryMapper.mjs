// DSH Session RPC 适配层：SessionSummary 映射器。
//
// 把 Corptie 的 TaskSession（rowToSession 返回）映射成 DSH 的 SessionSummary。
//
// DSH SessionSummary（见 apiproxy/src/api/sessions.ts + sessions.schema.ts）：
//   { sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, agentPreset?, projections? }
//
// 其中 updatedAt 是 epoch 毫秒，running 是布尔，blank 表示「尚无 turn 运行」。

/** ISO 8601 → epoch 毫秒。 */
function toEpochMs(iso) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 从 session 推导标题投影（DSH 的 title 通过 projections.values.title 承载）。
 *
 * DSH SessionSummary 协议没有独立的静态 title 字段，标题是「projections」投影块里
 * key 为 "title" 的值（前端 ProjectionValueStore 按 higher-seq-wins 规则合并，
 * displayTitleOf 优先读 title，回退 cwd 目录名，再回退 sessionId）。
 *
 * Corptie 侧标题的真实来源是 session.title（rowToSession 里已优先取 logical session
 * 的 session_name）。这里把它映射进 projections.values.title，并复用 updatedAt 的
 * epoch 毫秒作为 asOfSeq（每次 rename 都会刷新 updated_at，毫秒级单调递增，满足
 * 投影值「更高 seq 胜出」的版本语义）。
 *
 * @param {object} session - rowToSession 返回的对象
 * @returns {object|undefined} projections 块；无标题时返回 undefined（前端回退 cwd）
 */
function titleProjection(session) {
  const title = typeof session?.title === "string" ? session.title.trim() : "";
  if (!title) return undefined;
  const asOfSeq = toEpochMs(session?.updatedAt);
  return { asOfSeq, values: { title } };
}

/** Corptie status → running 布尔。running/blocked 视为运行中。 */
function isRunning(status) {
  return status === "running" || status === "blocked";
}

/**
 * TaskSession → DSH SessionSummary。
 * @param {object} session - rowToSession 返回的对象（含 id, title, status, updatedAt, external.cwd 等）
 * @returns {object} DSH SessionSummary
 */
export function mapSessionSummary(session) {
  const sessionId = String(session?.id ?? "");
  const projections = titleProjection(session);
  return {
    sessionId,
    updatedAt: toEpochMs(session?.updatedAt),
    running: isRunning(session?.status),
    // Blank is supplied by the Corptie Timeline authority. DSH uses it only
    // to reuse an already-created workspace Session instead of creating one
    // on every UI reconnect.
    blank: session?.blank === true,
    ...(session?.external?.cwd ? { cwd: session.external.cwd } : {}),
    ...(projections ? { projections } : {}),
  };
}

/**
 * TaskSession[] → DSH SessionSummary[]（session.list 的 items）。
 */
export function mapSessionList(sessions) {
  return (Array.isArray(sessions) ? sessions : []).map(mapSessionSummary);
}
