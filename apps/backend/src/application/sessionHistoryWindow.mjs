export const DEFAULT_SESSION_HISTORY_WINDOW = 200;
export const MAX_SESSION_HISTORY_PAGE = 200;
export const DEFAULT_SESSION_ANCHOR_CONTEXT = 40;

export function normalizeSessionHistoryLimit(value, maximum = MAX_SESSION_HISTORY_PAGE) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return maximum;
  return Math.max(1, Math.min(maximum, Math.floor(parsed)));
}

export function windowSessionItems(items, windowSize = DEFAULT_SESSION_HISTORY_WINDOW) {
  if (!Array.isArray(items) || items.length <= windowSize) {
    return { items, hasMoreHistory: false, historyItemsCount: 0 };
  }
  const omitted = items.length - windowSize;
  const window = withTurnConversationBoundaries(items, items.slice(omitted));
  return {
    items: window,
    hasMoreHistory: true,
    historyItemsCount: omitted
  };
}

/// Raw tool/process streams can contain hundreds of items in one turn while
/// presenting as one UI card. A numeric tail cut must not leave that card
/// without the user prompt or terminal Agent reply that gives it meaning.
export function withTurnConversationBoundaries(source, window) {
  const allItems = Array.isArray(source) ? source : [];
  const baseItems = Array.isArray(window) ? window : [];
  if (baseItems.length === 0) return baseItems;
  const representedTurns = [...new Set(baseItems.map((item) => item?.turnId).filter(Boolean))];
  if (representedTurns.length === 0) return baseItems;

  const boundaryByTurn = new Map();
  for (const turnId of representedTurns) {
    const turnItems = allItems.filter((item) => item?.turnId === turnId);
    boundaryByTurn.set(turnId, {
      user: turnItems.find((item) => item?.type === "userMessage") ?? null,
      agent: turnItems.findLast((item) => item?.type === "agentMessage") ?? null
    });
  }

  const result = [];
  const emitted = new Set();
  const lastIndexByTurn = new Map();
  baseItems.forEach((item, index) => {
    if (item?.turnId) lastIndexByTurn.set(item.turnId, index);
  });
  for (let index = 0; index < baseItems.length; index += 1) {
    const item = baseItems[index];
    const turnId = item?.turnId;
    const boundary = turnId ? boundaryByTurn.get(turnId) : null;
    if (boundary?.user && !emitted.has(boundary.user.id)) {
      result.push(boundary.user);
      emitted.add(boundary.user.id);
    }
    if (!emitted.has(item?.id)) {
      result.push(item);
      if (item?.id) emitted.add(item.id);
    }
    if (turnId && lastIndexByTurn.get(turnId) === index
      && boundary?.agent && !emitted.has(boundary.agent.id)) {
      result.push(boundary.agent);
      emitted.add(boundary.agent.id);
    }
  }
  return result;
}

export function pageSessionItems(items, { beforeId = null, limit = MAX_SESSION_HISTORY_PAGE } = {}) {
  const source = Array.isArray(items) ? items : [];
  const pageLimit = normalizeSessionHistoryLimit(limit);
  const beforeIndex = beforeId == null
    ? source.length
    : source.findIndex((item) => item.id === beforeId);
  if (beforeIndex <= 0) {
    return { items: [], hasMoreHistory: false, historyItemsCount: 0 };
  }
  const startIndex = Math.max(0, beforeIndex - pageLimit);
  return {
    items: source.slice(startIndex, beforeIndex),
    hasMoreHistory: startIndex > 0,
    historyItemsCount: startIndex
  };
}

export function windowSessionItemsAroundAnchor(
  items,
  {
    anchorKind = "item",
    anchorId,
    before = DEFAULT_SESSION_ANCHOR_CONTEXT,
    after = DEFAULT_SESSION_ANCHOR_CONTEXT
  } = {}
) {
  const source = Array.isArray(items) ? items : [];
  const beforeLimit = normalizeSessionHistoryLimit(before);
  const afterLimit = normalizeSessionHistoryLimit(after);
  const normalizedKind = anchorKind === "turn" ? "turn" : "item";
  const matches = normalizedKind === "turn"
    ? (item) => item?.turnId === anchorId
    : (item) => item?.id === anchorId;
  const firstAnchorIndex = source.findIndex(matches);
  if (firstAnchorIndex < 0) {
    return {
      items: [],
      anchor: { kind: normalizedKind, requestedId: anchorId ?? null, resolvedId: null, status: "missing" },
      hasEarlier: false,
      hasLater: false
    };
  }

  let lastAnchorIndex = firstAnchorIndex;
  if (normalizedKind === "turn") {
    while (lastAnchorIndex + 1 < source.length && matches(source[lastAnchorIndex + 1])) {
      lastAnchorIndex += 1;
    }
  }
  const startIndex = Math.max(0, firstAnchorIndex - beforeLimit);
  const endIndex = Math.min(source.length, lastAnchorIndex + afterLimit + 1);
  return {
    items: source.slice(startIndex, endIndex),
    anchor: {
      kind: normalizedKind,
      requestedId: anchorId,
      resolvedId: normalizedKind === "turn" ? source[firstAnchorIndex]?.turnId : source[firstAnchorIndex]?.id,
      status: "found"
    },
    hasEarlier: startIndex > 0,
    hasLater: endIndex < source.length
  };
}
