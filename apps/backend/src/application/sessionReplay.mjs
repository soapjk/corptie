// 会话日志收口（10）：生产者溯源 + 反事实重放 + surface 投影 + Fork。
//
// - filterEvents(events, producer)：剔除某来源，重建「没有该来源时模型会看到什么」。
// - deriveMessages(events)：从事件流投影消息列表（真相源 → UI 派生）。仅折叠 surface===true 的事件。
// - replaySession(store, sessionId, { excludedProducers })：反事实重放。
// - forkSession(store, sessionId, atSeq, { newSessionId })：以 atSeq 为 forkPoint 复制 [0, atSeq] 事件到新 Session。
//
// 边界（10 §九）：日志 ≠ 世界。反事实重放只能重建「模型看到了什么」，无法撤销真实副作用。

import { randomUUID } from "node:crypto";

function producerOf(event) {
  if (event?.producer != null) return event.producer;
  const source = event?.source;
  if (source == null) return null;
  if (typeof source === "string") return source;
  return source.producer ?? source.name ?? source.id ?? null;
}

export function filterEvents(events, producer) {
  return events.filter((event) => producerOf(event) !== producer);
}

// 事件类型 → UI 消息角色（deriveMessages 折叠用）。
const EVENT_ROLE = {
  "user/message": "user",
  "assistant/message": "assistant",
  "assistant/chunk": "assistant",
  "memory/inject": "system",
  "approval/request": "approval",
  "tool/call": "tool"
};

// 仅折叠 surface===true 的事件，输出 Message[] 供 UI 渲染与续跑上下文组装。
// 非 surface 事件（chunk/usage/内部状态）不进消息列表。
export function deriveMessages(events) {
  const messages = [];
  for (const event of events) {
    if (event.surface === false) continue;
    if (event.surface == null && !(event.payload && event.payload.text != null)) continue;
    messages.push({
      sequence: event.sequence,
      type: event.type,
      role: EVENT_ROLE[event.type] ?? "assistant",
      text: event.payload?.text ?? "",
      title: event.payload?.title ?? null,
      producer: producerOf(event),
      callId: event.callId ?? null
    });
  }
  return messages;
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

// Fork（10 §六）：复制 [0, atSeq] 的事件到新 Session（新 sessionId），新 Session 从该点继续。
// 原 Session 不受影响。返回新 sessionId。
export function forkSession(store, sessionId, atSeq, { newSessionId } = {}) {
  const sourceEvents = store
    .listSessionEvents(sessionId)
    .filter((event) => event.sequence <= atSeq);
  const targetId = newSessionId ?? `session:${randomUUID()}`;

  // 复制 Session 元数据（新 sessionId），并建立新 session_log。
  const sourceSession = store.getSession(sessionId);
  store.upsertSession({
    id: targetId,
    title: sourceSession ? `${sourceSession.title}（分支）` : "分支会话",
    agent: sourceSession?.agent,
    agentName: sourceSession?.agent,
    agentId: sourceSession?.agentId,
    sessionKind: sourceSession?.sessionKind,
    provider: sourceSession?.provider,
    status: "running",
    objectiveId: sourceSession?.objectiveId,
    workItemId: sourceSession?.workItemId
  });

  // 复制事件（appendSessionEvent 自动为新 session 分配连续 sequence）。
  for (const event of sourceEvents) {
    store.appendSessionEvent({
      eventId: `${targetId}:fork:${event.sequence}`,
      sessionId: targetId,
      type: event.type,
      producer: event.producer,
      surface: event.surface,
      sourceEventSeqs: event.sourceEventSeqs,
      callId: event.callId,
      source: event.source,
      payload: event.payload,
      createdAt: event.createdAt
    });
  }

  // 记录一条 fork 溯源事件，指向源 session 与 forkPoint。
  store.appendSessionEvent({
    eventId: `${targetId}:fork:meta`,
    sessionId: targetId,
    type: "system/fork",
    producer: "system",
    surface: false,
    sourceEventSeqs: sourceEvents.map((e) => e.sequence),
    payload: { sourceSessionId: sessionId, forkPointSeq: atSeq }
  });

  return targetId;
}

// 发前固化（10 §四）：在真正调用模型 API 之前持久化 request/header 事件。
// 满足「模型可见 ⇒ 已记录」不变量：system prompt + tool schemas + call config + 当轮 messages 快照，
// 全部落入事件流（surface=false，不参与消息投影，但可从日志重建喂给模型的内容）。
// request: { systemPrompt, toolSchemas, callConfig, messages }
export function finalizeRequest(store, sessionId, request = {}) {
  const eventId = `req:${randomUUID()}`;
  store.appendSessionEvent({
    eventId,
    sessionId,
    type: "request/header",
    producer: "system",
    surface: false,
    payload: {
      systemPrompt: request.systemPrompt ?? null,
      toolSchemas: request.toolSchemas ?? [],
      callConfig: request.callConfig ?? {},
      messages: request.messages ?? []
    }
  });
  return eventId;
}

// Resume 续跑（10 §七）：事件重放重建完整消息列表（含 system prompt / 记忆注入），
// 以 resume 模式重新组装上下文。atSeq 可指定续跑起点（支持 Fork 后续跑）。
// 返回 { sessionId, atSeq, messages, requestHeaders } 供调用方组装 resume 请求。
export function resumeSession(store, sessionId, { atSeq } = {}) {
  const events = store.listSessionEvents(sessionId);
  const point = atSeq == null
    ? (events.length ? events[events.length - 1].sequence : 0)
    : atSeq;

  const prefix = events.filter((event) => event.sequence <= point);

  // 从 request/header 事件中恢复最近一次完整请求快照（system prompt + tool schemas）。
  let latestHeader = null;
  for (const event of prefix) {
    if (event.type === "request/header") {
      latestHeader = {
        systemPrompt: event.payload?.systemPrompt ?? null,
        toolSchemas: event.payload?.toolSchemas ?? [],
        callConfig: event.payload?.callConfig ?? {}
      };
    }
  }

  return {
    sessionId,
    atSeq: point,
    messages: deriveMessages(prefix),
    requestHeaders: latestHeader
  };
}
