// 会话日志收口（10）：生产者溯源 + 反事实重放。
//
// - filterEvents(events, producer)：剔除某来源，重建「没有该来源时模型会看到什么」。
// - deriveMessages(events)：从事件流投影消息列表（真相源 → UI 派生）。
// - replaySession(store, sessionId, { excludedProducers })：反事实重放骨架。
//
// 边界（10 §九）：日志 ≠ 世界。反事实重放只能重建「模型看到了什么」，无法撤销真实副作用。

function producerOf(event) {
  const source = event?.source;
  if (source == null) return null;
  if (typeof source === "string") return source;
  return source.producer ?? source.name ?? source.id ?? null;
}

export function filterEvents(events, producer) {
  return events.filter((event) => producerOf(event) !== producer);
}

export function deriveMessages(events) {
  return events
    .filter((e) => e.type === "message" || (e.payload && e.payload.text != null))
    .map((e) => ({
      sequence: e.sequence,
      type: e.type,
      text: e.payload?.text ?? ""
    }));
}

export function replaySession(store, sessionId, { excludedProducers = [] } = {}) {
  const events = store.listSessionEvents(sessionId);
  const filtered = excludedProducers.reduce((acc, p) => filterEvents(acc, p), events);
  return {
    sessionId,
    totalEvents: events.length,
    keptEvents: filtered.length,
    messages: deriveMessages(filtered)
  };
}
