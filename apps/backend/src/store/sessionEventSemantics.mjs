const SURFACE_EVENT_TYPES = new Set([
  "user/message",
  "assistant/message",
  "assistant/chunk",
  "memory/inject"
]);

export function surfaceForEventType(type) {
  return SURFACE_EVENT_TYPES.has(type) ? 1 : 0;
}

export function agentMessageEventSQL(tableAlias) {
  if (process.env.CORPTIE_OPTIMIZED_MESSAGE_CURSOR_READS === "0") {
    return `(
      ${tableAlias}.type IN ('CodexThreadCompleted', 'AgentTurnCompleted', 'turn.completed')
      AND COALESCE(json_extract(${tableAlias}.payload_json, '$.hasAgentMessage'), 0) = 1
    )`;
  }
  return `${tableAlias}.has_agent_message = 1`;
}

export function eventHasAgentMessage(event) {
  return ["CodexThreadCompleted", "AgentTurnCompleted", "turn.completed"].includes(event.type)
    && (event.payload?.hasAgentMessage === true || event.payload?.hasAgentMessage === 1);
}

export function producerFromSource(source) {
  if (source == null) return null;
  if (typeof source === "string") return source;
  return source.producer ?? source.name ?? source.id ?? null;
}
