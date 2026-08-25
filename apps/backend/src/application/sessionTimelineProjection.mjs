import { persistableSessionItems } from "./storedSessionDetail.mjs";

export class SessionTimelineProjection {
  constructor({ store }) {
    if (!store?.upsertItemSnapshot) {
      throw new Error("SessionTimelineProjection requires a timeline-capable store.");
    }
    this.store = store;
  }

  persistDetail(sessionId, detail) {
    if (!sessionId) return 0;
    const items = persistableSessionItems(detail);
    let changed = 0;
    for (const item of items) {
      if (this.store.upsertItemSnapshot(sessionId, item) !== false) changed += 1;
    }
    return changed;
  }

  persistChangedItem({ sessionId, eventName, itemId, liveItems }) {
    if (eventName === "turn/completed") {
      // Terminal reconciliation is the correctness boundary. Providers may
      // deliver item/completed late (or omit it after reconnect), while their
      // terminal snapshot already contains the final Agent reply.
      return this.persistDetail(sessionId, { items: liveItems }) > 0;
    }
    if (eventName !== "item/started" && eventName !== "item/completed") return false;
    const changedItem = Array.isArray(liveItems)
      ? liveItems.find((item) => item?.id === itemId)
      : null;
    if (!changedItem) return false;
    return this.persistDetail(sessionId, { items: [changedItem] }) > 0;
  }
}
