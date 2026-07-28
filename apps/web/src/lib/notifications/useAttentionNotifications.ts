import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getAttention } from "../api/client";
import {
  countEnabledAttention,
  processAttentionNotifications
} from "./attentionNotifications";
import {
  NOTIFICATION_PREFERENCES_EVENT,
  readNotificationPreferences
} from "./preferences";

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export function useAttentionNotifications() {
  const [preferences, setPreferences] = useState(readNotificationPreferences);
  const permission = notificationPermission();
  const active = preferences.enabled && permission === "granted";
  const attention = useQuery({
    queryKey: ["attention"],
    queryFn: getAttention,
    enabled: active,
    refetchInterval: active ? 10_000 : false
  });

  useEffect(() => {
    const update = () => setPreferences(readNotificationPreferences());
    window.addEventListener("storage", update);
    window.addEventListener(NOTIFICATION_PREFERENCES_EVENT, update);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener(NOTIFICATION_PREFERENCES_EVENT, update);
    };
  }, []);

  useEffect(() => {
    const badgeNavigator = navigator as BadgeNavigator;
    if (!active) {
      void badgeNavigator.clearAppBadge?.();
      return;
    }
    if (!attention.data) return;
    processAttentionNotifications(attention.data.items, preferences, ({ title, options }) => {
      try {
        const notification = new Notification(title, options);
        notification.onclick = () => {
          window.focus();
          const sessionId = (options.data as { sessionId?: string } | undefined)?.sessionId;
          if (sessionId) window.location.assign(`/sessions/${encodeURIComponent(sessionId)}`);
          notification.close();
        };
      } catch {
        // Unsupported notification implementations must not affect core controls.
      }
    });
    const count = countEnabledAttention(attention.data.items, preferences);
    void (count > 0 ? badgeNavigator.setAppBadge?.(count) : badgeNavigator.clearAppBadge?.());
  }, [active, attention.data, preferences]);
}

function notificationPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}
