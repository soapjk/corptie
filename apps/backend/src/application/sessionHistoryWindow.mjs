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
  return {
    items: items.slice(omitted),
    hasMoreHistory: true,
    historyItemsCount: omitted
  };
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
