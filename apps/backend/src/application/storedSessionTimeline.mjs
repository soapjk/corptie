const SURFACE_TYPES = new Set(["user/message", "assistant/message"]);
const COMPLETION_TYPES = new Set([
  "CodexThreadCompleted",
  "TaskCompleted",
  "AgentTurnCompleted"
]);

/// Reconstructs the user-visible timeline from Corptie's provider-neutral
/// persisted event log when a Provider's private history is unavailable.
export function projectStoredSessionTimeline(events = []) {
  const ordered = [...events].sort((left, right) =>
    Number(left?.sequence ?? 0) - Number(right?.sequence ?? 0)
  );
  const surfaceItems = ordered.flatMap(surfaceItemsForEvent);
  return uniqueTimelineItems(
    surfaceItems.length > 0 ? surfaceItems : ordered.flatMap(fallbackItemsForEvent)
  );
}

function surfaceItemsForEvent(event) {
  if (!SURFACE_TYPES.has(event?.type)) return [];
  const text = normalizedText(event?.payload?.text);
  if (!text) return [];
  const isUser = event.type === "user/message";
  return [timelineItem({
    id: event.eventId ?? `stored:${event.sequence}`,
    turnId: event.payload?.turnId ?? `stored-turn:${event.sequence}`,
    type: isUser ? "userMessage" : "agentMessage",
    title: isUser ? "User" : "Agent",
    text,
    createdAt: event.createdAt
  })];
}

function fallbackItemsForEvent(event) {
  if (event?.type === "SessionUserMessageCreated") {
    const message = event.payload?.message;
    const text = normalizedText(message?.text);
    if (!text) return [];
    return [timelineItem({
      id: message?.id ?? event.eventId ?? `stored:${event.sequence}`,
      turnId: message?.turnId ?? `stored-turn:${event.sequence}`,
      type: "userMessage",
      title: message?.title ?? "User",
      text,
      createdAt: message?.createdAt ?? event.createdAt
    })];
  }

  if (!COMPLETION_TYPES.has(event?.type)) return [];
  const turn = event.payload?.turn;
  const projected = Array.isArray(turn?.items)
    ? turn.items.flatMap((item, index) => {
        const text = normalizedText(item?.text);
        if (!text) return [];
        return [timelineItem({
          ...item,
          id: item.id ?? `${event.eventId ?? `stored:${event.sequence}`}:${index}`,
          turnId: item.turnId ?? turn?.id ?? `stored-turn:${event.sequence}`,
          type: item.type ?? "agentMessage",
          title: item.title ?? "Agent",
          text,
          createdAt: item.createdAt ?? event.createdAt
        })];
      })
    : [];
  if (projected.length > 0) return projected;

  const summary = normalizedText(event.payload?.session?.summary);
  if (!summary) return [];
  return [timelineItem({
    id: event.eventId ?? `stored:${event.sequence}`,
    turnId: turn?.id ?? `stored-turn:${event.sequence}`,
    type: "agentMessage",
    title: "Agent",
    text: summary,
    createdAt: event.createdAt
  })];
}

function timelineItem(item) {
  return {
    ...item,
    turnStatus: item.turnStatus ?? "completed",
    status: item.status ?? "completed"
  };
}

function uniqueTimelineItems(items) {
  const ids = new Set();
  const result = [];
  for (const item of items) {
    if (ids.has(item.id)) continue;
    const previous = result.at(-1);
    if (previous?.type === item.type && previous.text === item.text) continue;
    ids.add(item.id);
    result.push(item);
  }
  return result;
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}
