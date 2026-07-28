import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { performSessionAction } from "../../lib/api/client";
import type { SessionDetail } from "../../lib/api/types";

export function SessionManagement({ session }: { session: SessionDetail }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(session.title);
  const [notice, setNotice] = useState("");
  const mutation = useMutation({
    retry: false,
    mutationFn: ({ action, payload }: { action: string; payload: Record<string, unknown> }) =>
      performSessionAction(session.id, action, payload, `manage:${session.id}:${action}:${JSON.stringify(payload)}`),
    onSuccess: (_result, variables) => {
      if (variables.action === "session.delete") {
        navigate("/sessions", { replace: true });
        return;
      }
      setNotice("已同步");
      void queryClient.invalidateQueries({ queryKey: ["session", session.id] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (cause) => setNotice(cause instanceof Error ? cause.message : "操作失败")
  });
  const enabled = (id: string) => session.availableActions.find((action) => action.id === id)?.enabled === true;
  const run = (action: string, payload: Record<string, unknown> = {}, destructive = false) => {
    if (destructive && !window.confirm("此操作可能影响或删除 Session。确认继续吗？")) return;
    setNotice("");
    mutation.mutate({ action, payload });
  };

  return (
    <details className="session-menu session-management-menu" name="session-header-menu">
      <summary aria-label="Session 管理" title="Session 管理"><span aria-hidden="true">•••</span></summary>
      <div className="surface session-menu-popover">
        <header>
          <strong>Session 管理</strong>
          <small>名称与列表操作</small>
        </header>
        <div className="management-grid">
          <label>名称<div><input maxLength={200} onChange={(event) => setTitle(event.target.value)} value={title} /><button disabled={!enabled("session.rename") || !title.trim() || mutation.isPending} onClick={() => run("session.rename", { title })} type="button">重命名</button></div></label>
          <button disabled={!enabled("session.pin") || mutation.isPending} onClick={() => run("session.pin", { pinned: !session.pinned })} type="button">{session.pinned ? "取消置顶" : "置顶"}</button>
          {session.archived
            ? <button disabled={!enabled("session.unarchive") || mutation.isPending} onClick={() => run("session.unarchive")} type="button">取消归档</button>
            : <button disabled={!enabled("session.archive") || mutation.isPending} onClick={() => run("session.archive", {}, true)} type="button">归档</button>}
          <button className="danger-button" disabled={!enabled("session.delete") || mutation.isPending} onClick={() => run("session.delete", {}, true)} type="button">删除 Session</button>
        </div>
        {notice ? <p className="control-notice" role="status">{notice}</p> : null}
      </div>
    </details>
  );
}
