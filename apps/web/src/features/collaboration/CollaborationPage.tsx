import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getCollaborationOverview, getCollaborationTask, performCollaborationAction } from "../../lib/api/client";
import { useLiveQueryInvalidation } from "../../lib/realtime/useLiveQueryInvalidation";

export function CollaborationPage() {
  const [selected, setSelected] = useState("");
  const overview = useQuery({ queryKey: ["collaboration"], queryFn: getCollaborationOverview });
  const detail = useQuery({
    queryKey: ["collaboration-task", selected],
    queryFn: () => getCollaborationTask(selected),
    enabled: Boolean(selected)
  });
  useLiveQueryInvalidation(overview.data?.eventCursor, [["collaboration"], ["collaboration-task", selected]]);
  if (overview.isPending) return <div className="surface loading-state">正在读取 Agent 协作…</div>;
  if (overview.isError || !overview.data) return <div className="surface error-state"><h1>无法读取 Collaboration</h1><p>{overview.error?.message}</p></div>;
  return (
    <section className="collaboration-page">
      <header><span className="eyebrow">Agent 网络</span><h1>Collaboration</h1></header>
      <div className="collaboration-stats">
        <Stat label="Agents" value={overview.data.agents.length} />
        <Stat label="Services" value={overview.data.services.length} />
        <Stat label="Tasks" value={overview.data.tasks.length} />
      </div>
      <div className={`collaboration-layout ${selected ? "has-selection" : ""}`}>
        <div className="surface collaboration-list" aria-label="协作任务">
          {overview.data.tasks.length ? overview.data.tasks.map((task) => (
            <button className={selected === text(task.taskId) ? "is-selected" : ""} key={text(task.taskId)} onClick={() => setSelected(text(task.taskId))} type="button">
              <strong>{text(task.title) || "未命名任务"}</strong>
              <span>{text(task.status)} · {text(task.type)}</span>
            </button>
          )) : <p>暂无协作任务。</p>}
        </div>
        <div className="surface collaboration-detail">
          {selected ? <button className="collaboration-back" onClick={() => setSelected("")} type="button">← 协作任务</button> : null}
          {!selected ? <p className="collaboration-placeholder">选择任务查看消息、事件和投递。</p> : detail.isPending ? <p>载入任务…</p> : detail.data ? <TaskDetail data={detail.data} /> : <p>任务不可用。</p>}
        </div>
      </div>
    </section>
  );
}

function TaskDetail({ data }: { data: { task: Record<string, unknown>; deliveries: Array<Record<string, unknown>> } }) {
  const client = useQueryClient();
  const task = data.task;
  const mutation = useMutation({
    retry: false,
    mutationFn: ({ action, targetId }: { action: "task.cancel" | "delivery.retry"; targetId: string }) =>
      performCollaborationAction(action, targetId, action === "task.cancel" ? "Canceled from Web" : "", `collab:${action}:${targetId}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["collaboration"] });
      void client.invalidateQueries({ queryKey: ["collaboration-task", text(task.taskId)] });
    }
  });
  const cancel = () => {
    if (window.confirm("确认取消这个协作任务吗？")) mutation.mutate({ action: "task.cancel", targetId: text(task.taskId) });
  };
  return (
    <>
      <h2>{text(task.title)}</h2><p>{text(task.summary)}</p>
      <dl><dt>状态</dt><dd>{text(task.status)}</dd><dt>发起</dt><dd>{text(task.initiatorAgentId)}</dd><dt>接收</dt><dd>{text(task.recipientAgentId)}</dd></dl>
      {!["completed", "rejected", "canceled", "escalated"].includes(text(task.status)) ? <button className="danger-button" disabled={mutation.isPending} onClick={cancel} type="button">取消任务</button> : null}
      <h3>时间线</h3>
      <div className="collaboration-timeline">
        {array(task.messages).map((message, index) => <article key={text(message.messageId) || index}><strong>{text(message.messageType)}</strong><p>{text(message.body)}</p></article>)}
        {array(task.events).map((event, index) => <article key={text(event.sequence) || index}><strong>{text(event.eventType)}</strong></article>)}
      </div>
      <h3>投递</h3>
      {data.deliveries.map((delivery) => <div className="delivery-row" key={text(delivery.deliveryId)}><span>{text(delivery.status)} {text(delivery.lastError)}</span>{["failed", "dead_letter"].includes(text(delivery.status)) ? <button disabled={mutation.isPending} onClick={() => {
        if (window.confirm("确认重试这次投递吗？")) mutation.mutate({ action: "delivery.retry", targetId: text(delivery.deliveryId) });
      }} type="button">重试</button> : null}</div>)}
      {mutation.isError ? <p role="alert">{mutation.error.message}</p> : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) { return <div className="surface"><span>{label}</span><strong>{value}</strong></div>; }
function text(value: unknown) { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function array(value: unknown) { return Array.isArray(value) ? value as Array<Record<string, unknown>> : []; }
