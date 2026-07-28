import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getSessions, reorderSessions } from "../../lib/api/client";
import type { SessionSummary } from "../../lib/api/types";
import { useLiveQueryInvalidation } from "../../lib/realtime/useLiveQueryInvalidation";

type SessionFilter = "all" | "attention" | "running" | "blocked" | "complete" | "codex" | "claude";

const FILTERS: Array<{ id: SessionFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "attention", label: "待处理" },
  { id: "running", label: "运行中" },
  { id: "blocked", label: "等待中" },
  { id: "complete", label: "已完成" },
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" }
];

export function SessionsPage() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [online, setOnline] = useState(() => navigator.onLine);
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: getSessions,
    refetchInterval: online ? 15_000 : false
  });
  const reorder = useMutation({
    mutationFn: reorderSessions,
    onSuccess: () => sessions.refetch()
  });
  useLiveQueryInvalidation(sessions.data?.eventCursor, [["sessions"], ["attention"]]);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const visibleSessions = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return (sessions.data?.sessions ?? []).filter((session) => {
      const matchesSearch = !needle || [
        session.title,
        session.summary,
        session.agent,
        session.external?.cwd,
        session.external?.currentModel
      ].some((value) => value?.toLocaleLowerCase().includes(needle));
      return matchesSearch && matchesFilter(session, filter);
    });
  }, [filter, search, sessions.data?.sessions]);

  return (
    <section className="sessions-page">
      <header className="sessions-heading">
        <div>
          <span className="eyebrow">工作空间</span>
          <h1>Sessions</h1>
        </div>
        <div className="sessions-heading-actions">
          <span className={`online-state ${online ? "is-online" : "is-offline"}`}>
            {online ? "在线" : "离线"}
          </span>
          <Link className="new-session-link" to="/sessions/new">新建</Link>
        </div>
      </header>

      <label className="session-search">
        <span className="visually-hidden">搜索 Sessions</span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索标题、项目、摘要或模型"
        />
      </label>

      <div className="filter-strip" role="group" aria-label="Session filters">
        {FILTERS.map((entry) => (
          <button
            type="button"
            className={filter === entry.id ? "is-selected" : ""}
            aria-pressed={filter === entry.id}
            key={entry.id}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {!online && (
        <div className="offline-banner" role="status">
          当前离线，显示上一次成功读取的 Session。
        </div>
      )}
      {sessions.isPending && <div className="surface loading-state">正在读取 Sessions…</div>}
      {sessions.isError && (
        <div className="surface error-state">
          <h2>无法读取 Sessions</h2>
          <p>{sessions.error.message}</p>
          <button type="button" onClick={() => void sessions.refetch()}>重试</button>
        </div>
      )}
      {sessions.isSuccess && visibleSessions.length === 0 && (
        <div className="surface empty-state">
          <h2>{sessions.data.sessions.length === 0 ? "还没有 Session" : "没有匹配结果"}</h2>
          <p>{sessions.data.sessions.length === 0
            ? "在 Mac 或后续的新建任务入口中启动第一个 Agent。"
            : "尝试更换筛选条件或搜索词。"}</p>
        </div>
      )}
      <div className="session-grid">
        {visibleSessions.map((session, index) => (
          <div className="session-card-wrap" key={session.id}>
            <SessionCard session={session} />
            <div className="desktop-sort-controls" aria-label={`排序 ${session.title}`}>
              <button disabled={index === 0 || reorder.isPending} onClick={() => reorder.mutate(moveSession(visibleSessions, index, -1))} type="button">上移</button>
              <button disabled={index === visibleSessions.length - 1 || reorder.isPending} onClick={() => reorder.mutate(moveSession(visibleSessions, index, 1))} type="button">下移</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function moveSession(sessions: SessionSummary[], index: number, delta: number) {
  const ids = sessions.map((session) => session.id);
  const target = index + delta;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  return ids;
}

function SessionCard({ session }: { session: SessionSummary }) {
  const workspace = workspaceName(session.external?.cwd);
  const model = session.external?.currentModel;
  const connection = session.external?.connectionStatus;
  const attention = needsAttention(session);
  return (
    <Link className="surface session-card" to={`/sessions/${encodeURIComponent(session.id)}`}>
      <div className="session-title-row">
        <div className={`session-avatar accent-${session.accent}`} aria-hidden="true">
          {session.title.slice(0, 1).toLocaleUpperCase()}
        </div>
        <div>
          <h2>{session.title}</h2>
          <p>{session.agent}{workspace ? ` · ${workspace}` : ""}</p>
        </div>
        <span className={`session-status status-${session.status}`}>
          <span aria-hidden="true" />
          {statusLabel(session.status)}
        </span>
        {attention && <span className="attention-dot" aria-label="需要处理" />}
      </div>
      <p className="session-summary">{session.activityStatus || session.summary || "暂无摘要"}</p>
      <div className="session-metadata">
        <span className="session-updated"><time dateTime={session.updatedAt}>{relativeTime(session.updatedAt)}</time></span>
        {model && <span>{shortModel(model)}</span>}
        {connection && <span className={connection.toLowerCase().includes("disconnect") ? "is-disconnected" : ""}>
          {connection}
        </span>}
      </div>
    </Link>
  );
}

function matchesFilter(session: SessionSummary, filter: SessionFilter) {
  if (filter === "all") return true;
  if (filter === "attention") return needsAttention(session);
  if (filter === "codex") return session.external?.provider.includes("codex") ?? false;
  if (filter === "claude") return session.external?.provider.includes("claude") ?? false;
  return session.status === filter;
}

function needsAttention(session: SessionSummary) {
  const connection = session.external?.connectionStatus?.toLocaleLowerCase() ?? "";
  return session.status === "blocked"
    || session.status === "failed"
    || Boolean(session.suggestedOptions?.length)
    || connection.includes("disconnect")
    || connection.includes("offline");
}

function workspaceName(path?: string | null) {
  if (!path) return null;
  return path.replace(/\/+$/, "").split("/").at(-1) || path;
}

function shortModel(model: string) {
  return model.length > 24 ? `${model.slice(0, 21)}…` : model;
}

function statusLabel(status: SessionSummary["status"]) {
  return {
    running: "运行中",
    blocked: "等待中",
    complete: "已完成",
    failed: "失败",
    cancelled: "已取消"
  }[status];
}

function relativeTime(value: string) {
  const minutes = Math.floor(Math.max(0, Date.now() - Date.parse(value)) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
