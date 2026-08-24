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
    for (const item of items) this.store.upsertItemSnapshot(sessionId, item);
    return items.length;
  }

  persistChangedItem({ sessionId, eventName, itemId, liveItems }) {
    if (eventName !== "item/started" && eventName !== "item/completed") return false;
    const changedItem = Array.isArray(liveItems)
      ? liveItems.find((item) => item?.id === itemId)
      : null;
    if (!changedItem) return false;
    return this.persistDetail(sessionId, { items: [changedItem] }) > 0;
  }
}
