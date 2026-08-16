// DSH Session RPC 适配层：事件映射器。
//
// 把 Corptie 的 session_events 行（sqlite 事件溯源）映射成 DSH 的 SessionEvent
// （envelope: type / seq / time / data）。序列号直接复用 Corptie 的 sequence，
// 时间戳从 ISO 8601 字符串转 epoch 毫秒。
//
// Corptie 事件类型（见 corptieStore.mjs 的 SURFACE_EVENT_TYPES / itemTypeToEventType）：
//   user/message, assistant/message, assistant/chunk, memory/inject, tool/call, approval/request
//
// DSH 事件类型（见 dsh-session/known-event-types.ts），其中与 Corptie 直接对应的：
//   user/message, assistant/message, assistant/chunk, tool/call, approval/asked
//
// ContentBlock 归一化：Corptie 的 session_events.payload 目前是 { text, itemType, title, status }，
// 映射成 DSH 的单个 text block { type:'text', text }。这是唯一需要「翻译」的地方，
// 后续若 Corptie payload 丰富化（多 block、图片、工具调用），在此处扩展。

import { randomUUID } from "node:crypto";

/** ISO 8601 → epoch 毫秒；解析失败回退 0（DSH time 要求 number）。 */
function toEpochMs(iso) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** 把 Corptie payload.text 归一化成 DSH ContentBlock 数组。 */
function textBlocks(text) {
  const t = typeof text === "string" ? text : (text == null ? "" : String(text));
  return [{ type: "text", text: t }];
}

/**
 * 映射一条 Corptie session_events 行 → DSH SessionEvent。
 * 无法映射（未知类型）时返回 null，由调用方跳过。
 *
 * @param {object} row - corptieStore.listSessionEvents 返回的行
 *   { eventId, sessionId, sequence, type, producer, surface, payload, createdAt, ... }
 * @returns {object|null} DSH SessionEvent { type, seq, time, data }
 */
export function mapEvent(row) {
  const type = row?.type;
  const payload = (row?.payload && typeof row.payload === "object") ? row.payload : {};
  const seq = Number(row?.sequence ?? 0);
  const time = toEpochMs(row?.createdAt);
  const text = payload.text ?? "";

  switch (type) {
    // 用户消息：data 为 UserMessage（含 id/role/content + source）。
    // DSH 前端 deriveEventMessage 对 user/message 直接 return event.data，
    // 故 data 必须是完整的 UserMessage，且事件须带 surfaceOp:'append' 标记。
    case "user/message":
      return {
        type: "user/message",
        seq,
        time,
        surfaceOp: "append",
        data: {
          id: randomUUID(),
          role: "user",
          content: textBlocks(text),
          source: { kind: "user" },
        },
      };

    // 助手消息：data 为 { turn, step, message }，message 是完整的 AssistantMessage。
    // Corptie 的 payload 没有 turn/step 信息，暂以 seq 作为稳定占位（turn=0/step=0），
    // 前端按 message.content 渲染即可，turn/step 仅用于折叠，占位不破坏渲染。
    case "assistant/message":
      return {
        type: "assistant/message",
        seq,
        time,
        surfaceOp: "append",
        data: {
          turn: 0,
          step: 0,
          message: {
            id: randomUUID(),
            role: "assistant",
            content: textBlocks(text),
            source: { kind: "model", provider: "codex", model: "codex" },
          },
        },
      };

    // 助手流式 chunk：data 为 { turn, step, chunk }。Corptie 的 assistant/chunk
    // payload 若含 text 则映射；否则跳过（chunk 通常伴随最终 assistant/message）。
    case "assistant/chunk":
      return {
        type: "assistant/chunk",
        seq,
        time,
        data: {
          turn: 0,
          step: 0,
          chunk: { text: text || "" },
        },
      };

    // 工具调用：data 为 { turn, step, name, callId, arguments }。
    // Corptie 的 tool/call payload 目前是 { text, itemType, title, status }，
    // 无 callId/arguments 结构化字段；以 title 作为 name 的尽力映射。
    case "tool/call":
      return {
        type: "tool/call",
        seq,
        time,
        data: {
          turn: 0,
          step: 0,
          name: payload.title || payload.itemType || "tool",
          callId: payload.callId || `tool:${seq}`,
          arguments: typeof payload.arguments === "string" ? payload.arguments : "{}",
        },
      };

    // 审批请求 → DSH approval/asked（字段对齐需确认 DSH approval 事件结构，先尽力映射）。
    case "approval/request":
      return {
        type: "approval/asked",
        seq,
        time,
        data: {
          turn: 0,
          text: text || "",
        },
      };

    // 记忆注入：DSH 无直接对应，映射为 user/message（source.kind 标注 synthetic）。
    case "memory/inject":
      return {
        type: "user/message",
        seq,
        time,
        surfaceOp: "append",
        data: {
          id: randomUUID(),
          role: "user",
          content: textBlocks(text),
          source: { kind: "inject", note: "memory" },
        },
      };

    default:
      return null;
  }
}

/**
 * 把一批 Corptie 行映射成 DSH HistoryEntry 数组。
 *
 * 方案 C：优先 surface 事件（user/message、assistant/message 等），
 * 若该批次没有任何可映射的 surface 事件，则回退到底层事件兜底
 * （SessionUserMessageCreated → user/message，Task 与 CodexThread 事件的 summary → assistant/message）。
 *
 * 这是为了兼容 Corptie 的「会话日志事件溯源」重构尚未落地的中间态：
 * 真实数据库中 surface===true 的事件目前为 0，会话正文只存在于底层事件流的
 * SessionUserMessageCreated.message.text（用户消息）与 summary（agent 状态摘要）。
 * agent 的逐条回复正文在 Corptie 侧并不持久化（只存在于 provider 私有存储），
 * 故兜底只能渲染用户消息 + agent 状态摘要。
 */
export function mapHistory(rows) {
  const surfaceEntries = [];
  for (const row of rows) {
    const event = mapEvent(row);
    if (event) surfaceEntries.push({ event });
  }

  if (surfaceEntries.length > 0) return surfaceEntries;

  // 回退：底层事件兜底。
  const fallbackEntries = [];
  for (const row of rows) {
    const event = mapFallbackEvent(row);
    if (event) fallbackEntries.push({ event });
  }
  return fallbackEntries;
}

/**
 * 底层事件兜底映射（surface 事件缺失时使用）。
 * 只兜底两类可渲染内容：用户消息正文、agent 状态摘要。
 */
export function mapFallbackEvent(row) {
  const type = row?.type;
  const payload = (row?.payload && typeof row.payload === "object") ? row.payload : {};
  const seq = Number(row?.sequence ?? 0);
  const time = toEpochMs(row?.createdAt);

  switch (type) {
    // 用户消息正文（真实数据里唯一可靠存在的正文）。
    case "SessionUserMessageCreated": {
      const text = payload?.message?.text ?? "";
      if (!text) return null;
      return {
        type: "user/message",
        seq,
        time,
        surfaceOp: "append",
        data: {
          id: randomUUID(),
          role: "user",
          content: textBlocks(text),
          source: { kind: "user" },
        },
      };
    }

    // agent 状态摘要（summary 字段，非逐条回复正文）。
    case "TaskCreated":
    case "TaskProgressChanged":
    case "TaskBlocked":
    case "TaskCompleted":
    case "CodexThreadCompleted":
    case "CodexThreadProgressChanged": {
      const summary = payload?.session?.summary ?? "";
      if (!summary) return null;
      return {
        type: "assistant/message",
        seq,
        time,
        surfaceOp: "append",
        data: {
          turn: 0,
          step: 0,
          message: {
            id: randomUUID(),
            role: "assistant",
            content: textBlocks(summary),
            source: { kind: "model", provider: "codex", model: "codex" },
          },
        },
      };
    }

    // 审批请求摘要。
    case "CodexThreadApprovalRequested": {
      const summary = payload?.session?.summary ?? "";
      if (!summary) return null;
      return {
        type: "approval/asked",
        seq,
        time,
        data: { turn: 0, text: summary },
      };
    }

    default:
      return null;
  }
}
