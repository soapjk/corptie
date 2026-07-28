import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { getOperation, performSessionAction } from "../../lib/api/client";

type ActionMode = "approval" | "collaboration";

export function ActionControls({
  sessionId,
  itemId,
  mode,
  confirmationId,
  optionId
}: {
  sessionId: string;
  itemId: string;
  mode: ActionMode;
  confirmationId?: string | null;
  optionId?: string | null;
}) {
  const queryClient = useQueryClient();
  const keys = useRef(new Map<string, string>());
  const [notice, setNotice] = useState("");
  const mutation = useMutation({
    retry: false,
    mutationFn: async (approved: boolean) => {
      const action = mode === "collaboration"
        ? (approved ? "collaboration.confirm" : "collaboration.reject")
        : "approval.respond";
      const keyName = `${itemId}:${action}:${approved}`;
      let key = keys.current.get(keyName);
      if (!key) {
        key = `web-action:${sessionId}:${keyName}`;
        keys.current.set(keyName, key);
      }
      const payload = mode === "collaboration"
        ? { confirmationId }
        : { itemId, optionId, approved };
      const result = await performSessionAction(sessionId, action, payload, key);
      if (result.status === "result-unknown" || result.status === "accepted") {
        setNotice("正在确认操作结果…");
        return getOperation(result.operationId);
      }
      return result;
    },
    onSuccess: (result) => {
      setNotice(result.status === "succeeded" ? "操作已完成" : "操作状态仍待确认，请稍后重试查询。");
      void queryClient.invalidateQueries({ queryKey: ["attention"] });
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (cause) => {
      const message = cause instanceof Error ? cause.message : "操作失败，请刷新后重试。";
      setNotice(message);
    }
  });

  function act(approved: boolean) {
    if (approved && !window.confirm("这是高风险操作。确认继续吗？")) return;
    mutation.mutate(approved);
  }

  return (
    <div className="action-controls">
      <div className="action-risk">高风险操作 · 请确认目标与影响范围</div>
      <div className="action-buttons">
        <button
          className="action-reject"
          disabled={mutation.isPending}
          onClick={() => act(false)}
          type="button"
        >
          {mode === "collaboration" ? "拒绝发送" : "拒绝"}
        </button>
        <button
          className="action-approve"
          disabled={mutation.isPending || (mode === "collaboration" && !confirmationId)}
          onClick={() => act(true)}
          type="button"
        >
          {mutation.isPending ? "处理中…" : (mode === "collaboration" ? "确认发送" : "批准")}
        </button>
      </div>
      {notice ? <p className="action-notice" role="status">{notice}</p> : null}
    </div>
  );
}
