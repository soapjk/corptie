import { useQuery } from "@tanstack/react-query";
import type { CSSProperties, ReactNode } from "react";
import { getSessionMetadata } from "../../lib/api/client";
import { useLiveQueryInvalidation } from "../../lib/realtime/useLiveQueryInvalidation";

export function SessionMetadata({ sessionId }: { sessionId: string }) {
  const query = useQuery({
    queryKey: ["session-metadata", sessionId],
    queryFn: () => getSessionMetadata(sessionId),
    refetchInterval: 30_000
  });
  useLiveQueryInvalidation(query.data?.eventCursor, [["session-metadata", sessionId]]);
  if (!query.data) return null;
  const account = accountMetric(query.data.accountUsage);
  const context = contextMetric(query.data.contextUsage);
  if (!query.data.branch && !query.data.avatarUrl && !account && !context) return null;
  return (
    <section className="surface session-metadata-panel" aria-label="Session 元数据">
      {query.data.avatarUrl ? <img alt="" className="session-metadata-avatar" src={query.data.avatarUrl} /> : null}
      {query.data.branch ? (
        <span aria-label={`Git 分支：${query.data.branch}`} className="session-meta-branch" title={`Git 分支：${query.data.branch}`}>
          <BranchIcon />
          <strong>{query.data.branch}</strong>
        </span>
      ) : null}
      <span className="session-meta-spacer" />
      {context ? <UsageItem icon={<ContextIcon />} metric={context} /> : null}
      {account ? <UsageItem icon={<QuotaIcon />} metric={account} /> : null}
    </section>
  );
}

type UsageMetric = {
  label: string;
  value: string;
  progress: number;
  tone: "normal" | "warning" | "danger";
};

function UsageItem({ icon, metric }: { icon: ReactNode; metric: UsageMetric }) {
  return (
    <span
      aria-label={`${metric.label}：${metric.value}`}
      className={`session-usage-item usage-${metric.tone}`}
      title={`${metric.label}：${metric.value}`}
    >
      <span
        className="session-usage-ring"
        style={{ "--usage-progress": `${Math.round(metric.progress * 360)}deg` } as CSSProperties}
      >
        {icon}
      </span>
      <strong>{metric.value}</strong>
    </span>
  );
}

function contextMetric(value: Record<string, unknown> | null): UsageMetric | null {
  if (!value) return null;
  const used = numberFor(value, "usedTokens");
  const window = numberFor(value, "contextWindow");
  if (used === null || window === null || window <= 0) return null;
  const usedPercent = numberFor(value, "usedPercent") ?? used / window * 100;
  return {
    label: `上下文用量（${formatPercent(usedPercent)}% 已使用）`,
    value: `${formatInteger(used)}/${formatInteger(window)}`,
    progress: clamp(usedPercent / 100),
    tone: usedPercent > 70 ? "danger" : usedPercent > 50 ? "warning" : "normal"
  };
}

function accountMetric(value: Record<string, unknown> | null): UsageMetric | null {
  if (!value) return null;
  const flattened = flatten(value);
  const explicitRemaining = numericEntry(flattened.find((entry) => /remainingPercent$/i.test(entry.key)));
  const usedPercent = numericEntry(flattened.find((entry) => /(?:primary|rateLimits).*usedPercent$/i.test(entry.key)))
    ?? numberFor(value, "usedPercent");
  const remainingPercent = explicitRemaining ?? (usedPercent === null ? null : 100 - usedPercent);
  if (remainingPercent === null) return null;
  return {
    label: "套餐余额",
    value: `${formatPercent(remainingPercent)}%`,
    progress: clamp(remainingPercent / 100),
    tone: remainingPercent < 30 ? "danger" : remainingPercent <= 50 ? "warning" : "normal"
  };
}

function flatten(value: Record<string, unknown>, prefix = ""): Array<{ key: string; value: string | number }> {
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) return flatten(entry as Record<string, unknown>, path);
    return typeof entry === "string" || typeof entry === "number" ? [{ key: path, value: entry }] : [];
  });
}

function numberFor(value: Record<string, unknown>, name: string) {
  return numericEntry(flatten(value).find((entry) => entry.key.split(".").at(-1) === name));
}

function numericEntry(entry?: { value: string | number }) {
  if (!entry) return null;
  const number = typeof entry.value === "number" ? entry.value : Number(entry.value);
  return Number.isFinite(number) ? number : null;
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function BranchIcon() {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="4" cy="3" r="1.5" /><circle cx="4" cy="13" r="1.5" /><circle cx="12" cy="5" r="1.5" /><path d="M4 4.5v7M5.5 10c4 0 5-1.5 5-3.5" /></svg>;
}

function ContextIcon() {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 4h10M3 8h8M3 12h6" /></svg>;
}

function QuotaIcon() {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M9 1.8 4.5 8h3L7 14.2 11.5 7h-3L9 1.8Z" /></svg>;
}
