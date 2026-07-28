import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SafeMarkdown } from "../../components/SafeMarkdown";
import { getSession } from "../../lib/api/client";
import type { ThreadItem } from "../../lib/api/types";
import { useLiveQueryInvalidation } from "../../lib/realtime/useLiveQueryInvalidation";
import { SessionComposer } from "./SessionComposer";
import { ActionControls } from "../actions/ActionControls";
import { SessionControls } from "./SessionControls";
import { SessionManagement } from "./SessionManagement";
import { SessionMetadata } from "./SessionMetadata";
import { TurnDiffPanel } from "./TurnDiffPanel";

export function SessionPage() {
  const { sessionId } = useParams();
  const decodedId = safeDecode(sessionId);
  const queryKey = useMemo(() => ["session", decodedId] as const, [decodedId]);
  const query = useQuery({
    queryKey,
    queryFn: () => getSession(decodedId),
    enabled: Boolean(decodedId)
  });
  useLiveQueryInvalidation(query.data?.eventCursor, [queryKey]);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  if (query.isPending) return <div className="surface loading-state">正在载入 Session…</div>;
  if (query.isError || !query.data) {
    return (
      <div className="surface error-state">
        <h1>无法载入 Session</h1>
        <p>请检查 Mac 是否在线，然后重试。</p>
      </div>
    );
  }

  const session = query.data.session;
  return (
    <section className="session-workspace">
      <header className="session-detail-header">
        <Link className="back-link" to="/sessions">← Sessions</Link>
        <div className="session-detail-identity">
          <div className="session-avatar accent-blue" aria-hidden="true">{session.title.slice(0, 1).toLocaleUpperCase()}</div>
          <div>
            <h1>{session.title}</h1>
            <p>{[session.agent, session.currentModel, session.cwd].filter(Boolean).join(" · ")}</p>
          </div>
          <div className="session-detail-actions">
            <SessionControls session={session} />
            <SessionManagement session={session} />
          </div>
        </div>
      </header>
      <SessionMetadata sessionId={session.id} />

      <div className="timeline" aria-label="Session 时间线">
        {session.items.length === 0 ? (
          <div className="surface empty-state"><p>这个 Session 还没有消息。</p></div>
        ) : session.items.map((item) => <TimelineItem item={item} key={item.id} sessionId={session.id} />)}
        {pendingMessage ? (
          <article className="surface timeline-item item-user optimistic-message" aria-live="polite">
            <div className="timeline-item-heading">
              <strong>你</strong>
              <span>发送中…</span>
            </div>
            <SafeMarkdown>{pendingMessage}</SafeMarkdown>
          </article>
        ) : null}
      </div>
      <SessionComposer session={session} onPendingChange={setPendingMessage} />
    </section>
  );
}

function TimelineItem({ item, sessionId }: { item: ThreadItem; sessionId: string }) {
  const isProcess = isProcessItem(item);
  const content = (
    <>
      <div className="timeline-item-heading">
        <strong>{item.title || itemLabel(item)}</strong>
        <time>{formatTime(item.createdAt)}</time>
      </div>
      {item.collaborationTaskTitle ? (
        <div className="collaboration-context">
          <span>Agent 协作</span>
          <strong>{item.collaborationTaskTitle}</strong>
          <small>{[item.collaborationSenderName, item.collaborationRecipientName].filter(Boolean).join(" → ")}</small>
        </div>
      ) : null}
      <SafeMarkdown>{item.presentationText || item.text}</SafeMarkdown>
      {item.type === "approval" && !isResolved(item.status) ? (
        <ActionControls
          itemId={item.id}
          mode="approval"
          optionId={item.options?.find((option) => option.role === "approve")?.id}
          sessionId={sessionId}
        />
      ) : null}
      {item.collaborationConfirmationId && item.collaborationConfirmationStatus === "pending" ? (
        <ActionControls
          confirmationId={item.collaborationConfirmationId}
          itemId={item.id}
          mode="collaboration"
          sessionId={sessionId}
        />
      ) : null}
      {item.fileChanges?.length ? (
        <ul className="file-changes" aria-label="文件变化">
          {item.fileChanges.map((change, index) => (
            <li key={`${change.path}-${index}`}>
              <span className={`change-kind change-${change.kind}`}>{change.kind}</span>
              <code>{change.path}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {item.turnDiff && item.turnId ? <TurnDiffPanel sessionId={sessionId} turnId={item.turnId} /> : null}
    </>
  );

  return (
    <article
      className={`surface timeline-item item-${itemRole(item)}`}
      id={`item-${item.id}`}
    >
      {isProcess ? (
        <details className="process-disclosure">
          <summary>{item.title || "执行过程"}</summary>
          <div className="process-content">{content}</div>
        </details>
      ) : content}
    </article>
  );
}

function isResolved(status?: string | null) {
  return ["complete", "completed", "resolved", "sent"].includes(String(status ?? "").toLowerCase());
}

function itemRole(item: ThreadItem) {
  const role = `${item.presentationRole ?? ""} ${item.type}`.toLowerCase();
  if (role.includes("user")) return "user";
  if (role.includes("collaboration")) return "collaboration";
  if (isProcessItem(item)) return "process";
  return "agent";
}

function isProcessItem(item: ThreadItem) {
  const value = `${item.type} ${item.presentationRole ?? ""}`.toLowerCase();
  return /(tool|command|reasoning|analysis|process|execution|filechange|diff)/.test(value);
}

function itemLabel(item: ThreadItem) {
  if (itemRole(item) === "collaboration") return "Agent 协作";
  if (itemRole(item) === "user") return "你";
  return "Agent";
}

function formatTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function safeDecode(value?: string) {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
