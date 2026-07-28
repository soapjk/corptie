import type { AttentionItem, AttentionKind } from "../api/types";
import type { NotificationCategory, NotificationPreferences } from "./preferences";

const SEEN_KEY = "corptie:web:notification-seen:v1";
const MAX_SEEN_IDS = 256;

type NotificationPayload = {
  title: string;
  options: NotificationOptions;
};

const CATEGORY_BY_KIND: Record<AttentionKind, NotificationCategory> = {
  "input-required": "input",
  "high-risk-approval": "approval",
  "collaboration-confirmation": "approval",
  "approval": "approval",
  "failure": "failure",
  "disconnected": "failure",
  "completed-unread": "completed"
};

const GENERIC_BODY: Record<NotificationCategory, string> = {
  input: "一个 Session 正在等待你的输入。",
  approval: "一个 Session 有待处理的确认。",
  failure: "一个 Session 需要检查。",
  completed: "一个 Session 已完成。"
};

export function processAttentionNotifications(
  items: AttentionItem[],
  preferences: NotificationPreferences,
  notify: (payload: NotificationPayload) => void,
  storage: Storage = localStorage
) {
  const seen = readSeenIds(storage);
  const nextSeen = new Set(seen);
  for (const item of items) {
    const category = CATEGORY_BY_KIND[item.kind];
    if (seen.has(item.id) || !preferences.categories[category]) continue;
    notify({
      title: "Corptie 需要你的注意",
      options: {
        body: GENERIC_BODY[category],
        tag: `corptie:${item.id}`,
        data: { sessionId: item.sessionId }
      }
    });
    nextSeen.add(item.id);
  }
  writeSeenIds([...nextSeen].slice(-MAX_SEEN_IDS), storage);
}

export function countEnabledAttention(items: AttentionItem[], preferences: NotificationPreferences) {
  return items.filter((item) => preferences.categories[CATEGORY_BY_KIND[item.kind]]).length;
}

function readSeenIds(storage: Storage) {
  try {
    const value = JSON.parse(storage.getItem(SEEN_KEY) ?? "[]");
    return new Set<string>(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function writeSeenIds(ids: string[], storage: Storage) {
  try {
    storage.setItem(SEEN_KEY, JSON.stringify(ids));
  } catch {
    // Notification delivery remains best effort if storage is unavailable.
  }
}
