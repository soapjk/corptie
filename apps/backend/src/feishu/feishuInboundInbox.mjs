// Owns inbound protocol decoding and duplicate suppression. Authorization and
// message execution remain with the gateway after an event has been claimed.
export class FeishuInboundInbox {
  constructor(store) {
    this.store = store;
    this.processedEventIds = new Set();
  }

  acceptMessage(botId, line) {
    let raw;
    try { raw = JSON.parse(line); } catch { return null; }
    const event = normalizeInboundEvent(raw);
    if (!event || event.chatType !== "p2p" || event.messageType !== "text") return null;
    if (event.eventId && (this.processedEventIds.has(event.eventId)
        || !this.store.claimFeishuInboundEvent(botId, event.eventId))) return null;
    if (event.eventId) {
      this.processedEventIds.add(event.eventId);
      if (this.processedEventIds.size > 5000) {
        this.processedEventIds.delete(this.processedEventIds.values().next().value);
      }
    }
    return event;
  }

  acceptCardAction(botId, line) {
    let raw;
    try { raw = JSON.parse(line); } catch { return null; }
    const event = normalizeCardActionEvent(raw);
    if (!event?.operatorId || !event.chatId) return null;
    if (event.eventId && !this.store.claimFeishuInboundEvent(botId, `card:${event.eventId}`)) return null;
    return event;
  }
}

function normalizeInboundEvent(raw) {
  const value = raw.event ?? raw;
  const message = value.message ?? value;
  const sender = value.sender ?? {};
  const senderId = value.sender_id ?? sender.sender_id ?? {};
  const openId = typeof senderId === "string" ? senderId : senderId.open_id;
  const chatId = message.chat_id ?? value.chat_id;
  if (!openId || !chatId) {
    return null;
  }
  let content = message.content ?? value.content ?? "";
  try {
    content = JSON.parse(content)?.text ?? content;
  } catch {}
  return {
    eventId: raw.event_id ?? raw.header?.event_id ?? value.event_id ?? null,
    messageId: message.message_id ?? value.message_id ?? null,
    chatId,
    chatType: message.chat_type ?? value.chat_type ?? "",
    messageType: message.message_type ?? value.message_type ?? "",
    openId,
    tenantKey: raw.header?.tenant_key ?? value.tenant_key ?? null,
    text: String(content).trim()
  };
}

function normalizeCardActionEvent(raw) {
  const value = raw.event ?? raw;
  let actionValue = value.action_value ?? value.action?.value ?? {};
  if (typeof actionValue === "string") {
    try {
      actionValue = JSON.parse(actionValue);
    } catch {
      actionValue = {};
    }
  }
  const operator = value.operator ?? {};
  const operatorId = value.operator_id ?? operator.operator_id ?? operator.open_id ?? null;
  return {
    eventId: raw.event_id ?? raw.header?.event_id ?? value.event_id ?? value.token ?? null,
    operatorId: typeof operatorId === "string" ? operatorId : operatorId?.open_id,
    chatId: value.chat_id ?? value.context?.open_chat_id ?? null,
    token: value.token ?? null,
    actionValue: actionValue && typeof actionValue === "object" ? actionValue : {}
  };
}
