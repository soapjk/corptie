// A visible conversation belongs to the logical Session, while each Provider
// binding owns only one physical runtime transcript. Compose immutable
// historical bindings with the active binding so switching Provider never
// clears the user's conversation history.
export async function composeLogicalSessionTimeline({
  bindings = [],
  activeDetail = null,
  readHistoricalBinding
} = {}) {
  if (!Array.isArray(bindings) || bindings.length <= 1) {
    return activeDetail?.items ?? [];
  }
  const ordered = bindings.filter((binding) => binding?.state !== "invalid").sort(compareBindings);
  const segments = [];
  for (const binding of ordered) {
    let detail = null;
    if (binding.state === "active") {
      detail = activeDetail;
    } else if (typeof readHistoricalBinding === "function") {
      detail = await readHistoricalBinding(binding);
    }
    const items = (detail?.items ?? []).map((item, index) => bindingItem(item, binding, index));
    segments.push(...items);
  }
  return segments;
}

export async function buildHistoricalSessionContext({
  bindings = [],
  readHistoricalBinding,
  maxMessages = 40,
  maxCharacters = 24_000
} = {}) {
  const items = await composeLogicalSessionTimeline({
    bindings,
    activeDetail: { items: [] },
    readHistoricalBinding
  });
  const messages = items
    .filter((item) => item?.providerBinding?.state !== "active")
    .filter((item) => ["userMessage", "agentMessage"].includes(item?.type))
    .filter((item) => typeof item?.text === "string" && item.text.trim())
    .slice(-Math.max(1, maxMessages))
    .map((item) => `${item.type === "userMessage" ? "User" : "Assistant"}: ${item.text.trim()}`);
  while (messages.length > 1 && messages.join("\n\n").length > maxCharacters) {
    messages.shift();
  }
  if (messages.length === 0) return null;
  const transcript = messages.join("\n\n");
  return {
    prompt: [
      "Conversation context from this logical Session before its Provider was switched.",
      "Treat it as prior conversation context; do not repeat it unless relevant.",
      transcript.length > maxCharacters ? transcript.slice(-maxCharacters) : transcript
    ].join("\n\n"),
    messageCount: messages.length
  };
}

function bindingItem(item, binding, index) {
  const historical = binding.state !== "active";
  const itemId = item?.id ?? `item:${index}`;
  const turnId = item?.turnId ?? `turn:${index}`;
  return {
    ...item,
    id: historical ? `${binding.bindingId}:${itemId}` : itemId,
    turnId: historical ? `${binding.bindingId}:${turnId}` : turnId,
    providerBinding: {
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      state: binding.state,
      routingVersion: binding.routingVersion
    }
  };
}

function compareBindings(left, right) {
  const routeOrder = Number(left?.routingVersion ?? 0) - Number(right?.routingVersion ?? 0);
  if (routeOrder !== 0) return routeOrder;
  const createdOrder = String(left?.createdAt ?? "").localeCompare(String(right?.createdAt ?? ""));
  if (createdOrder !== 0) return createdOrder;
  return String(left?.bindingId ?? "").localeCompare(String(right?.bindingId ?? ""));
}
