export type NotificationCategory = "input" | "approval" | "failure" | "completed";

export type NotificationPreferences = {
  enabled: boolean;
  categories: Record<NotificationCategory, boolean>;
};

export const NOTIFICATION_PREFERENCES_EVENT = "corptie:notification-preferences";
const PREFERENCES_KEY = "corptie:web:notification-preferences:v1";

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: false,
  categories: {
    input: true,
    approval: true,
    failure: true,
    completed: true
  }
};

export function readNotificationPreferences(storage: Storage = localStorage): NotificationPreferences {
  try {
    const stored = JSON.parse(storage.getItem(PREFERENCES_KEY) ?? "{}") as Partial<NotificationPreferences>;
    return {
      enabled: stored.enabled === true,
      categories: {
        input: stored.categories?.input !== false,
        approval: stored.categories?.approval !== false,
        failure: stored.categories?.failure !== false,
        completed: stored.categories?.completed !== false
      }
    };
  } catch {
    return structuredClone(DEFAULT_NOTIFICATION_PREFERENCES);
  }
}

export function writeNotificationPreferences(
  preferences: NotificationPreferences,
  storage: Storage = localStorage
) {
  storage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  window.dispatchEvent(new CustomEvent(NOTIFICATION_PREFERENCES_EVENT));
}
