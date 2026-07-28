import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { performSessionAction } from "../../lib/api/client";
import type { SessionDetail } from "../../lib/api/types";

export function SessionControls({ session }: { session: SessionDetail }) {
  const queryClient = useQueryClient();
  const [model, setModel] = useState(session.currentModel ?? session.external?.currentModel ?? "");
  const [reasoning, setReasoning] = useState(
    session.currentReasoningLevel ?? session.external?.currentReasoningLevel ?? "medium"
  );
  const [sandbox, setSandbox] = useState(session.external?.sandbox ?? "workspace-write");
  const [approvalPolicy, setApprovalPolicy] = useState(session.external?.approvalPolicy ?? "on-request");
  const [notice, setNotice] = useState("");
  const mutation = useMutation({
    retry: false,
    mutationFn: ({ action, payload }: { action: string; payload: Record<string, unknown> }) =>
      performSessionAction(
        session.id,
        action,
        payload,
        `session-control:${session.id}:${action}:${JSON.stringify(payload)}`
      ),
    onSuccess: () => {
      setNotice("设置已同步");
      void queryClient.invalidateQueries({ queryKey: ["session", session.id] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (cause) => setNotice(cause instanceof Error ? cause.message : "操作失败")
  });
  const action = (id: string) => session.availableActions.find((entry) => entry.id === id);
  const enabled = (id: string) => action(id)?.enabled === true;

  if (!["session.interrupt", "session.reconnect", "session.model.set", "session.reasoning.set", "session.permissions.set"]
    .some((id) => action(id))) return null;

  function run(actionId: string, payload: Record<string, unknown> = {}, highRisk = false) {
    if (highRisk && !window.confirm("权限变更会影响 Agent 可访问的范围。确认继续吗？")) return;
    setNotice("");
    mutation.mutate({ action: actionId, payload });
  }

  const hasSettings = ["session.model.set", "session.reasoning.set", "session.permissions.set"].some((id) => action(id));

  return (
    <div className="session-runtime-controls">
      {enabled("session.reconnect") ? (
        <button
          aria-label="重新连接"
          className="session-header-action"
          disabled={mutation.isPending}
          onClick={() => run("session.reconnect")}
          title="重新连接"
          type="button"
        >
          <span aria-hidden="true">↗</span>
        </button>
      ) : enabled("session.interrupt") ? (
        <button
          aria-label="中断运行"
          className="session-header-action"
          disabled={mutation.isPending}
          onClick={() => run("session.interrupt")}
          title="中断运行"
          type="button"
        >
          <span aria-hidden="true">■</span>
        </button>
      ) : null}
      {hasSettings ? (
        <details className="session-menu session-settings-menu" name="session-header-menu">
          <summary aria-label="Session 设置" title="Session 设置"><span aria-hidden="true">⚙</span></summary>
          <div className="surface session-menu-popover">
            <header>
              <strong>Session 设置</strong>
              <small>模型、推理与权限</small>
            </header>
            <div className="session-control-grid">
        {action("session.model.set") ? (
          <label>
            <span>模型</span>
            <div>
              <input disabled={!enabled("session.model.set")} onChange={(event) => setModel(event.target.value)} value={model} />
              <button disabled={!enabled("session.model.set") || !model.trim() || mutation.isPending} onClick={() => run("session.model.set", { model })} type="button">应用</button>
            </div>
          </label>
        ) : null}
        {action("session.reasoning.set") ? (
          <label>
            <span>推理级别</span>
            <div>
              <select disabled={!enabled("session.reasoning.set")} onChange={(event) => setReasoning(event.target.value)} value={reasoning}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">XHigh</option>
              </select>
              <button disabled={!enabled("session.reasoning.set") || mutation.isPending} onClick={() => run("session.reasoning.set", { reasoningLevel: reasoning })} type="button">应用</button>
            </div>
          </label>
        ) : null}
        {action("session.permissions.set") ? (
          <fieldset disabled={!enabled("session.permissions.set") || mutation.isPending}>
            <legend>权限</legend>
            <select aria-label="Sandbox" onChange={(event) => setSandbox(event.target.value)} value={sandbox}>
              <option value="read-only">Read only</option>
              <option value="workspace-write">Workspace write</option>
              <option value="danger-full-access">Danger full access</option>
            </select>
            <select aria-label="Approval policy" onChange={(event) => setApprovalPolicy(event.target.value)} value={approvalPolicy}>
              <option value="on-request">On request</option>
              <option value="ask-risky">Ask risky</option>
              <option value="on-failure">On failure</option>
              <option value="never">Never ask</option>
            </select>
            <button onClick={() => run("session.permissions.set", { sandbox, approvalPolicy }, true)} type="button">更新权限</button>
          </fieldset>
        ) : null}
            </div>
            {mutation.isPending ? <p className="control-notice" role="status">正在同步到 Mac…</p> : null}
            {!mutation.isPending && notice ? <p className="control-notice" role="status">{notice}</p> : null}
          </div>
        </details>
      ) : null}
      {!hasSettings && notice ? <span className="session-action-toast" role="status">{notice}</span> : null}
    </div>
  );
}
