import { useState } from "react";
import {
  type NotificationCategory,
  type NotificationPreferences,
  readNotificationPreferences,
  writeNotificationPreferences
} from "../../lib/notifications/preferences";
import { reloadPwa } from "../../lib/pwa/reload";

const CATEGORIES: Array<{ id: NotificationCategory; label: string; detail: string }> = [
  { id: "input", label: "需要输入", detail: "Agent 等待你补充信息时提醒。" },
  { id: "approval", label: "审批与确认", detail: "审批或协作确认需要处理时提醒。" },
  { id: "failure", label: "失败与断连", detail: "执行失败或连接中断时提醒。" },
  { id: "completed", label: "任务完成", detail: "Session 完成且尚未查看时提醒。" }
];

export function DeviceSettingsPage() {
  const [preferences, setPreferences] = useState(readNotificationPreferences);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission
  );

  const save = (next: NotificationPreferences) => {
    setPreferences(next);
    writeNotificationPreferences(next);
  };

  const enable = async () => {
    if (typeof Notification === "undefined") return;
    const nextPermission = await Notification.requestPermission();
    setPermission(nextPermission);
    save({ ...preferences, enabled: nextPermission === "granted" });
  };

  return (
    <section className="settings-page page-stack">
      <header>
        <span className="eyebrow">当前设备</span>
        <h1>通知与偏好</h1>
        <p>设置只保存在这台设备。通知不会显示 Session 名称、提示词、审批内容或错误详情。</p>
      </header>

      <div className="surface settings-panel">
        <div className="settings-row">
          <div>
            <h2>重新载入 Web App</h2>
            <p>检查新版本并刷新当前页面；尚未发送的 Session 草稿会保留。</p>
          </div>
          <button type="button" onClick={() => void reloadPwa()}>重新载入</button>
        </div>
        <div className="settings-row">
          <div>
            <h2>系统通知</h2>
            <p>{permissionLabel(permission)}</p>
          </div>
          {permission === "granted" ? (
            <label className="switch-label">
              <input
                type="checkbox"
                checked={preferences.enabled}
                onChange={(event) => save({ ...preferences, enabled: event.target.checked })}
              />
              {preferences.enabled ? "已开启" : "已关闭"}
            </label>
          ) : (
            <button type="button" onClick={() => void enable()} disabled={permission === "denied" || permission === "unsupported"}>
              请求授权
            </button>
          )}
        </div>

        <div className="notification-categories">
          {CATEGORIES.map((category) => (
            <label className="settings-row" key={category.id}>
              <span>
                <strong>{category.label}</strong>
                <small>{category.detail}</small>
              </span>
              <input
                type="checkbox"
                checked={preferences.categories[category.id]}
                disabled={!preferences.enabled}
                onChange={(event) => save({
                  ...preferences,
                  categories: {
                    ...preferences.categories,
                    [category.id]: event.target.checked
                  }
                })}
              />
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}

function permissionLabel(permission: NotificationPermission | "unsupported") {
  if (permission === "granted") return "浏览器已授权，可按下方类型独立开关。";
  if (permission === "denied") return "浏览器已拒绝通知；核心开发功能仍可正常使用。";
  if (permission === "unsupported") return "当前浏览器不支持系统通知；核心开发功能不受影响。";
  return "默认关闭。授权请求只会在你点击按钮后出现。";
}
