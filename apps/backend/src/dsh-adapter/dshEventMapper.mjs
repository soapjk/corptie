// DSH Session RPC 适配层：事件映射器。
//
// 把 Corptie 的 session_events 行（sqlite 事件溯源）映射成 DSH 的 SessionEvent
// （envelope: type / seq / time / data）。序列号直接复用 Corptie 的 sequence，
// 时间戳从 ISO 8601 字符串转 epoch 毫秒。
//
// Corptie 事件类型（见 corptieStore.mjs 的 SURFACE_EVENT_TYPES）：
//   user/message, assistant/message, assistant/chunk, memory/inject, tool/call, approval/request
//
// DSH 事件类型（见 dsh-session/known-event-types.ts），其中与 Corptie 直接对应的：
//   user/message, assistant/message, assistant/chunk, tool/call, approval/asked
//
// ContentBlock 归一化：Corptie 的 session_events.payload 目前是 { text, itemType, title, status }，
// 映射成 DSH 的单个 text block { type:'text', text }。这是唯一需要「翻译」的地方，
// 后续若 Corptie payload 丰富化（多 block、图片、工具调用），在此处扩展。

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
          id: payload.itemId ?? row.eventId,
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
            id: payload.itemId ?? row.eventId,
            role: "assistant",
            content: textBlocks(text),
            source: {
              kind: "model",
              provider: row.source?.providerId ?? row.producer ?? "provider",
              model: payload.model ?? "provider"
            },
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
          id: payload.itemId ?? row.eventId,
          role: "user",
          content: textBlocks(text),
          source: { kind: "inject", note: "memory" },
        },
      };

    default:
      return null;
  }
}
