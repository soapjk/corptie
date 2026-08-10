function parsedTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function timelineGroups(items) {
  const groups = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const previous = groups.at(-1);
    const turnId = item?.turnId ?? null;
    if (previous && turnId && previous.turnId === turnId) {
      previous.end = index + 1;
      const timestamp = parsedTimestamp(item?.createdAt);
      if (timestamp !== null) previous.timestamp ??= timestamp;
      continue;
    }
    groups.push({
      turnId,
      start: index,
      end: index + 1,
      timestamp: parsedTimestamp(item?.createdAt)
    });
  }
  return groups;
}

function insertionIndexForItem(item, groups, itemCount) {
  const turnId = item?.turnId ?? null;
  if (turnId) {
    const matchingGroups = groups.filter((group) => group.turnId === turnId);
    if (matchingGroups.length > 0) return matchingGroups.at(-1).end;
  }

  const timestamp = parsedTimestamp(item?.createdAt);
  if (timestamp === null) return itemCount;
  const nextGroup = groups.find((group) => group.timestamp !== null && group.timestamp > timestamp);
  return nextGroup?.start ?? itemCount;
}

/**
 * Inserts supplemental cards into a provider-owned transcript without reordering
 * the transcript itself. Provider process items often lack timestamps, so a
 * global timestamp sort would split them from their turn.
 */
export function mergeSupplementalTimelineItems(detailItems = [], supplementalItems = []) {
  if (supplementalItems.length === 0) return detailItems;
  if (detailItems.length === 0) {
    return supplementalItems
      .map((item, order) => ({ item, order, timestamp: parsedTimestamp(item?.createdAt) }))
      .sort(compareSupplementalItems)
      .map(({ item }) => item);
  }

  const groups = timelineGroups(detailItems);
  const insertions = new Map();
  supplementalItems.forEach((item, order) => {
    const index = insertionIndexForItem(item, groups, detailItems.length);
    const candidates = insertions.get(index) ?? [];
    candidates.push({ item, order, timestamp: parsedTimestamp(item?.createdAt) });
    insertions.set(index, candidates);
  });
  for (const candidates of insertions.values()) candidates.sort(compareSupplementalItems);

  const merged = [];
  for (let index = 0; index <= detailItems.length; index += 1) {
    for (const candidate of insertions.get(index) ?? []) merged.push(candidate.item);
    if (index < detailItems.length) merged.push(detailItems[index]);
  }
  return merged;
}

function compareSupplementalItems(left, right) {
  if (left.timestamp === null && right.timestamp !== null) return 1;
  if (left.timestamp !== null && right.timestamp === null) return -1;
  if (left.timestamp !== null && right.timestamp !== null && left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  return left.order - right.order;
}
