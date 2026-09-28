import { codexPermissionsFromThread } from "../utils/codexPermissions.mjs";
import { createdAtFrom } from "../utils/timestamps.mjs";
import { providerRawMetadataJSON } from "../utils/providerRawMetadata.mjs";
import { toolExecutionForItem, withToolExecutionMetadata } from "../utils/toolExecutionProjection.mjs";
import { changeSetForCodexItem, withChangeSetMetadata } from "../utils/changeSetProjection.mjs";
import { asyncQuestionInput } from "../application/structuredInteraction.mjs";

// Provider-native values become shared Session/timeline projections here.
// This module owns no connection, request queue, or authoritative Session state.
export function normalizeCodexTokenUsage(rawUsage, fallback = {}) {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const active = rawUsage.last ?? rawUsage.lastUsage ?? rawUsage.last_usage
    ?? rawUsage.lastTokenUsage ?? rawUsage.last_token_usage
    ?? rawUsage.total ?? rawUsage.totalUsage ?? rawUsage.total_usage
    ?? rawUsage.totalTokenUsage ?? rawUsage.total_token_usage ?? rawUsage;
  const usedTokens = finiteNumber(active.totalTokens ?? active.total_tokens ?? rawUsage.totalTokens);
  const contextWindow = finiteNumber(
    rawUsage.modelContextWindow
      ?? rawUsage.model_context_window
      ?? rawUsage.contextWindow
      ?? fallback.modelContextWindow
  );
  if (usedTokens == null && contextWindow == null) return null;
  const remainingTokens = usedTokens != null && contextWindow != null
    ? Math.max(0, contextWindow - usedTokens)
    : null;
  return {
    usedTokens,
    contextWindow,
    remainingTokens,
    usedPercent: usedTokens != null && contextWindow
      ? Math.min(100, Math.max(0, usedTokens / contextWindow * 100))
      : null
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function mapCodexThreadToSession(thread) {
  const preview = thread.preview || thread.name || "Untitled Codex thread";
  const cwd = thread.cwd ? ` in ${thread.cwd}` : "";

  const permissions = codexPermissionsFromThread(thread);
  return {
    id: `codex:${thread.id}`,
    title: preview.length > 72 ? `${preview.slice(0, 69)}...` : preview,
    agent: "Codex",
    // This mapper is used only for thread/start command responses. Product
    // execution state is projected from persisted lifecycle events.
    status: "complete",
    progress: 1,
    summary: `${thread.source || "codex"} thread${cwd}`,
    capabilities: codexAppServerCapabilities(),
    updatedAt: new Date((thread.updatedAt ?? thread.createdAt ?? Date.now() / 1000) * 1000).toISOString(),
    accent: "cyan",
    external: {
      provider: "codex-app-server",
      threadId: thread.id,
      sessionId: thread.sessionId,
      connectionStatus: "app-server connected",
      rawStatus: "transport-ready",
      cwd: thread.cwd,
      source: thread.source,
      currentModel: thread.currentModel ?? thread.model ?? null,
      currentReasoningLevel: thread.currentReasoningLevel ?? thread.reasoningEffort ?? null,
      ...(permissions ?? {})
    }
  };
}

// Migration-only projection of a Provider-native thread. Live notifications
// continue to flow through ProviderEventIngestionService; this function never
// participates in ordinary Session reads or message dispatch.
export function mapCodexThreadToLegacyTimelineItems(thread) {
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
    throw new TypeError("Codex legacy history repair requires a thread object.");
  }
  const items = [];
  for (const turn of thread.turns ?? []) {
    if (!turn || typeof turn !== "object" || Array.isArray(turn) || !turn.id) {
      throw new TypeError("Codex legacy history repair encountered an invalid turn.");
    }
    for (const item of turn.items ?? []) {
      if (!item || typeof item !== "object" || Array.isArray(item) || !item.id) {
        throw new TypeError("Codex legacy history repair encountered an invalid item.");
      }
      const mapped = mapThreadItem(turn, item);
      if (mapped.type !== "taskComplete") items.push(mapped);
    }
  }
  return items;
}

function codexAppServerCapabilities() {
  return {
    canSend: true,
    canSwitchModel: true,
    canSwitchReasoning: true,
    canInterrupt: true,
    canReconnect: false
  };
}

export function mapThreadItem(turn, item) {
  const mapped = {
    id: item.id,
    turnId: turn.id,
    turnStatus: turn.status,
    type: item.type,
    title: itemTitle(item),
    text: itemText(item),
    status: item.status ?? null,
    presentationRole: normalizedCodexPresentationRole(item.phase ?? item.presentationRole),
    createdAt: createdAtFrom(item, turn),
    rawMetadataJSON: providerRawMetadataJSON("codex-app-server", item, { source: "provider_item" })
  };
  const userInput = asyncQuestionInput(item);
  if (userInput) {
    mapped.type = "userInput";
    mapped.status = "pending";
    mapped.userInput = userInput;
    mapped.rawMetadataJSON = JSON.stringify({ ...JSON.parse(mapped.rawMetadataJSON), userInput });
  }
  const toolExecution = toolExecutionForItem(mapped, {
    input: codexToolInput(item),
    result: item.aggregatedOutput ?? item.result ?? item.output ?? item.error ?? null
  });
  mapped.rawMetadataJSON = withToolExecutionMetadata(mapped.rawMetadataJSON, toolExecution);
  mapped.rawMetadataJSON = withChangeSetMetadata(mapped.rawMetadataJSON, changeSetForCodexItem(item));
  if (item.type === "fileChange") {
    mapped.fileChanges = (item.changes ?? []).map((change) => ({
      path: change.path,
      kind: fileChangeKind(change.kind),
      diff: change.diff ?? ""
    }));
  }
  if (Array.isArray(item.images) && item.images.length > 0) {
    mapped.images = item.images;
  }
  return mapped;
}

function codexToolInput(item) {
  switch (item.type) {
  case "commandExecution": return item.command ?? null;
  case "fileChange": return (item.changes ?? []).map((change) => change.path).filter(Boolean).join("\n");
  case "mcpToolCall": case "dynamicToolCall": return item.arguments ?? null;
  case "webSearch": return item.query ?? null;
  default: return null;
  }
}

function normalizedCodexPresentationRole(value) {
  const normalized = typeof value === "string"
    ? value.trim().toLowerCase().replaceAll("-", "_")
    : "";
  if (["final", "finalanswer", "final_answer"].includes(normalized)) return "final_answer";
  if (["analysis", "commentary", "progress"].includes(normalized)) return "commentary";
  return normalized || null;
}

function fileChangeKind(kind) {
  if (typeof kind === "string") {
    return kind;
  }
  if (kind && typeof kind.type === "string") {
    return kind.type;
  }
  return "update";
}

function itemTitle(item) {
  switch (item.type) {
    case "userMessage":
      return "User";
    case "agentMessage":
      return "Codex";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "commandExecution":
      return `Command ${item.status ?? ""}`.trim();
    case "fileChange":
      return `File changes ${item.status ?? ""}`.trim();
    case "mcpToolCall":
      return `MCP ${item.server}.${item.tool}`;
    case "dynamicToolCall":
      return `Tool ${item.tool}`;
    case "webSearch":
      return "Web search";
    default:
      return item.type;
  }
}

function itemText(item) {
  switch (item.type) {
    case "userMessage":
      return (item.content ?? [])
        .map((content) => content.type === "text" ? content.text : `[${content.type}]`)
        .join("\n");
    case "agentMessage":
      return item.text ?? "";
    case "reasoning":
      return [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
    case "plan":
      return item.text ?? "";
    case "commandExecution": {
      const output = item.aggregatedOutput ? `\n\n${truncate(item.aggregatedOutput, 1200)}` : "";
      return `$ ${item.command}${output}`;
    }
    case "fileChange":
      return `${item.changes?.length ?? 0} file change(s)`;
    case "mcpToolCall":
      return JSON.stringify(item.arguments ?? {}, null, 2);
    case "dynamicToolCall":
      return JSON.stringify(item.arguments ?? {}, null, 2);
    case "webSearch":
      return item.query ?? "";
    case "imageView":
      return item.path ?? "";
    default:
      return "";
  }
}

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text ?? "";
  }
  return `${text.slice(0, maxLength - 3)}...`;
}
