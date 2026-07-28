import { useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import {
  activatePwaUpdate,
  createPwaUpdateChecker,
  createReloadOnce,
  PWA_UPDATE_INTERVAL_MS,
  registerPwa
} from "../lib/pwa/register";
import { useAttentionNotifications } from "../lib/notifications/useAttentionNotifications";
import { useViewportZoomLock } from "../lib/mobile/useViewportZoomLock";
import { PullToRefresh } from "./PullToRefresh";

export function AppShell() {
  useAttentionNotifications();
  useViewportZoomLock();
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    let active = true;
    let stopUpdateChecks = () => {};
    const handleControllerChange = createReloadOnce(() => window.location.reload());
    navigator.serviceWorker?.addEventListener("controllerchange", handleControllerChange);
    void registerPwa((update) => {
      if (active) activatePwaUpdate(update);
    }).then((registration) => {
      if (!active || !registration) return;
      const checkForUpdate = createPwaUpdateChecker(registration);
      const handleFocus = () => void checkForUpdate();
      const handleVisibilityChange = () => {
        if (document.visibilityState === "visible") void checkForUpdate();
      };
      const interval = window.setInterval(handleFocus, PWA_UPDATE_INTERVAL_MS);
      window.addEventListener("focus", handleFocus);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      stopUpdateChecks = () => {
        window.clearInterval(interval);
        window.removeEventListener("focus", handleFocus);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      };
      void checkForUpdate();
    }).catch(() => {
      // Installation remains optional; LAN browser access must continue to work.
    });
    return () => {
      active = false;
      stopUpdateChecks();
      navigator.serviceWorker?.removeEventListener("controllerchange", handleControllerChange);
    };
  }, []);
  return (
    <div className="app-shell">
      <PullToRefresh />
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="top-bar">
        <Link className="brand" to="/sessions" aria-label="Corptie Sessions">
          <span className="brand-mark" aria-hidden="true">C</span>
          <span className="brand-copy">
            <strong>Corptie</strong>
            <small>Development</small>
          </span>
        </Link>
        <div className="top-bar-actions">
          <span className={`connection-badge ${online ? "" : "is-offline"}`}>
            <span aria-hidden="true" />
            {online ? "LAN" : "离线"}
          </span>
          <Link className="settings-link" to="/settings" aria-label="通知与偏好">
            <span aria-hidden="true">⚙</span>
            <span className="settings-label">设置</span>
          </Link>
        </div>
      </header>
      {!online ? <div className="stale-snapshot-banner" role="status">当前显示上一次同步的只读快照；恢复网络后会自动重新同步，未发送操作不会自动重放。</div> : null}
      <main className="app-content" id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
      <nav className="bottom-nav" aria-label="Primary">
        <NavLink to="/attention"><span aria-hidden="true">!</span><strong>待处理</strong></NavLink>
        <NavLink to="/sessions"><span aria-hidden="true">▤</span><strong>Sessions</strong></NavLink>
        <NavLink to="/collaboration"><span aria-hidden="true">⌘</span><strong>协作</strong></NavLink>
        <NavLink to="/settings"><span aria-hidden="true">⚙</span><strong>设置</strong></NavLink>
      </nav>
    </div>
  );
}
