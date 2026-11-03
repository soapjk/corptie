import { parseJson } from "./storedJson.mjs";
import { boundedUnicodeText } from "../utils/unicodeText.mjs";
import { CHILD_TASK_RESULT_NOTICE_PREFIX } from "../utils/sessionEventPresentation.mjs";

export function isAgentNoise(text = "") {
  return /^现$|^your config\.toml:?$|^Started codex resume |You have \d+ usage limit resets available|10;\?11;\?.*>_ OpenAI Codex|^(?:10;\?11;\?|\[[0-9;?]*[a-zA-Z])$|^>_ OpenAI Codex|^model:\s|^directory:\s|features?.*web[_\s-]?search[_\s-]?request.*deprecated|web[_\s-]?search[_\s-]?request.*deprecated|set [`'"]?web[_\s-]?search[`'"]?.*(live|true|enabled)|falling back from web ?sockets? to https|websocket.*fallback|under a profile\) in config\.toml|Tip: Try the Codex App|HooksLifecycle hooks|EventInstalledActiveReviewDescription|MCP startup incomplete|MCP client .* timed out|Starting MCP servers|startup_timeout_sec|\[mcp_servers\.|0;[⠼⠴⠦⠧⠇⠏⠋⠙⠹⠸]/i.test(text);
}

export function normalizeStoredItem(item, provider) {
  // Product timeline projections may carry provider-neutral presentation
  // fields that are intentionally not first-class SQLite columns (automation,
  // collaboration, system-event metadata). Keep the indexed identity/content
  // columns authoritative while restoring those optional fields on reads.
  const metadata = parseJson(item.rawMetadataJSON, null);
  const restored = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? { ...metadata, ...item }
    : item;
  if (restored.type === "userMessage" && !restored.presentationRole
      && (restored.messageOrigin === "scheduled_task" || restored.sourceChannel === "scheduled_session_task")) {
    return { ...restored, presentationRole: "automation",
      automationEventType: "ScheduledSessionRunQueued", automationRunStatus: restored.status,
      automationEventOccurredAt: restored.createdAt };
  }
  return presentChildTaskResult(restored);
}

export function normalizeStoredText(text = "", provider = "") {
  return text;
}

// Display-only normalization of the product-owned mailbox report format. This
// covers historical rows without queue lookups, migrations or new writes.
function presentChildTaskResult(item) {
  if (item.type !== "userMessage" || item.presentationRole
      || item.sourceChannel !== "mailbox_event"
      || !item.id?.startsWith("mailbox-event:")
      || !item.text?.startsWith(CHILD_TASK_RESULT_NOTICE_PREFIX)) return item;
  const fallback = { ...item, presentationRole: "system_event", systemEventKind: "child_task_result",
    systemEventSource: "task_coordination", presentationText: "子任务已返回执行结果，请查看后续汇报。" };
  if (item.text.length > 64 * 1024) return fallback;
  let results;
  try { results = JSON.parse(item.text.slice(item.text.indexOf("\n") + 1)); }
  catch { return fallback; }
  if (!Array.isArray(results) || results.length === 0 || !results.every(result =>
    result && typeof result === "object" && typeof result.dispatchId === "string"
    && result.dispatchId.startsWith("dispatch:") && typeof result.status === "string")) return fallback;
  const states = { completed: "已完成", failed: "执行失败", cancelled: "已取消", unknown: "结果待确认",
    blocked: "等待输入", running: "执行中" };
  const lines = [`收到 ${results.length} 个子任务的执行结果。`];
  for (const [index, result] of results.slice(0, 8).entries()) {
    lines.push(`子任务 ${index + 1} · ${Object.hasOwn(states, result.status) ? states[result.status] : "状态已更新"}`);
    const excerpt = typeof result.resultExcerpt === "string" ? result.resultExcerpt
      : typeof result.errorMessage === "string" ? result.errorMessage : "";
    if (excerpt.trim()) lines.push(boundedUnicodeText(excerpt.trim(), 240, "…"));
  }
  if (results.length > 8) lines.push(`另有 ${results.length - 8} 个子任务结果，请查看后续汇报。`);
  return { ...item, presentationRole: "system_event", systemEventKind: "child_task_result",
    systemEventSource: "task_coordination", presentationText: lines.join("\n\n") };
}
