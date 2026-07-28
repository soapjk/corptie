import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getAttention, markAttentionRead } from "../../lib/api/client";
import type { AttentionItem, AttentionKind } from "../../lib/api/types";
import { useLiveQueryInvalidation } from "../../lib/realtime/useLiveQueryInvalidation";
import { ActionControls } from "../actions/ActionControls";

const KIND_LABELS: Record<AttentionKind, string> = {
  "high-risk-approval": "高风险审批",
  "collaboration-confirmation": "协作确认",
  "input-required": "需要输入",
  "failure": "执行失败",
  "disconnected": "连接中断",
  "approval": "需要审批",
  "completed-unread": "已完成"
};

export function AttentionPage() {
  const queryClient = useQueryClient();
  const attention = useQuery({
    queryKey: ["attention"],
    queryFn: getAttention,
    refetchInterval: 10_000
  });
  const markRead = useMutation({
    mutationFn: markAttentionRead,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attention"] })
  });

  useLiveQueryInvalidation(attention.data?.eventCursor, [["attention"]]);

  if (attention.isPending) {
    return <div className="surface loading-state">正在读取待处理事项…</div>;
  }
  if (attention.isError) {
    return (
      <section className="surface error-state">
        <span className="eyebrow">连接不可用</span>
        <h1>无法读取 Corptie</h1>
        <p>{attention.error.message}</p>
        <Link className="button-link" to="/pair">重新配对</Link>
      </section>
    );
  }

  return (
    <section className="attention-page">
      <header className="attention-hero">
        <div>
          <span className="eyebrow">现在需要你</span>
          <h1>待处理 {attention.data.count}</h1>
          <p>{attention.data.runningCount} 个 Session 正在运行</p>
        </div>
        <div className="attention-count" aria-label={`${attention.data.count} items`}>
          {attention.data.count}
        </div>
      </header>

      {attention.data.items.length === 0 ? (
        <div className="surface empty-state">
          <h2>暂时不需要操作</h2>
          <p>Agent 需要输入、审批或连接恢复时，会优先显示在这里。</p>
        </div>
      ) : (
        <div className="attention-list">
          {attention.data.items.map((item) => (
            <AttentionCard
              item={item}
              key={item.id}
              onOpen={() => {
                if (item.kind === "completed-unread") markRead.mutate(item.sessionId);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AttentionCard({ item, onOpen }: { item: AttentionItem; onOpen: () => void }) {
  return (
    <article className={`surface attention-card attention-${item.kind}`}>
      <div className="attention-card-heading">
        <span className="attention-kind">{KIND_LABELS[item.kind]}</span>
        <time dateTime={item.updatedAt}>{relativeTime(item.updatedAt)}</time>
      </div>
      <h2>{item.sessionTitle}</h2>
      <p className="attention-agent">{item.agent}</p>
      <p className="attention-summary">{item.summary || "打开 Session 查看最新状态。"}</p>
      {item.kind === "high-risk-approval" ? (
        <ActionControls
          itemId={item.contextItemId ?? item.id}
          mode="approval"
          optionId={stringContext(item.actionContext, "optionId")}
          sessionId={item.sessionId}
        />
      ) : null}
      {item.kind === "collaboration-confirmation" ? (
        <ActionControls
          confirmationId={stringContext(item.actionContext, "confirmationId")}
          itemId={item.contextItemId ?? item.id}
          mode="collaboration"
          sessionId={item.sessionId}
        />
      ) : null}
      <Link
        className="attention-open"
        to={`/sessions/${encodeURIComponent(item.sessionId)}${item.contextItemId ? `#item-${encodeURIComponent(item.contextItemId)}` : ""}`}
        onClick={onOpen}
      >
        {item.kind.includes("approval") || item.kind === "collaboration-confirmation"
          ? "查看并处理"
          : "打开 Session"}
      </Link>
    </article>
  );
}

function stringContext(context: Record<string, unknown> | undefined, key: string) {
  return typeof context?.[key] === "string" ? context[key] : null;
}

function relativeTime(value: string) {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
