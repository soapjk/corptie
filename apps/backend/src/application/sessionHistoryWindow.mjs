export const DEFAULT_SESSION_HISTORY_WINDOW = 200;
export const MAX_SESSION_HISTORY_PAGE = 200;

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
