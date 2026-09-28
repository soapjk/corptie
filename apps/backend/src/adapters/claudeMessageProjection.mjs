import { providerSafeToolText } from "../utils/providerRawMetadata.mjs";
import { changeSetForClaudeTool } from "../utils/changeSetProjection.mjs";
import { isClaudePlanTool } from "./claudePlanTools.mjs";

export function claudeAssistantContentItems(message, structuredPlanEvents = true) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const items = [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      items.push({
        type: "agentMessage",
        title: "Claude Code",
        text: block.text.trim(),
        presentationRole: "commentary"
      });
      continue;
    }
    if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      items.push({
        type: "reasoning",
        title: "Thinking",
        text: block.thinking.trim()
      });
      continue;
    }
    if (block?.type === "tool_use") {
      const toolName = String(block.name ?? "Claude tool").trim() || "Claude tool";
      // Only a call captured for result correlation can be replaced by the
      // structured checklist. Malformed calls must remain visible as tools.
      if (structuredPlanEvents && isClaudePlanTool(toolName) && typeof block.id === "string" && block.id
        && block.input != null && typeof block.input === "object" && !Array.isArray(block.input)) continue;
      items.push({
        type: claudeToolItemType(toolName),
        title: toolName,
        text: claudeToolInputText(toolName, block.input),
        status: "running",
        toolUseId: typeof block.id === "string" ? block.id : null,
        changeSet: changeSetForClaudeTool(toolName, block.input)
      });
    }
  }
  return items;
}

function claudeToolItemType(toolName) {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" || normalized.includes("shell") || normalized.includes("command")) {
    return "commandExecution";
  }
  if (["write", "edit", "multiedit", "notebookedit"].some((name) => normalized.includes(name))) {
    return "fileChange";
  }
  if (normalized.includes("websearch") || normalized.includes("webfetch") || normalized.includes("browser")) {
    return "webSearch";
  }
  return "mcpToolCall";
}

function claudeToolInputText(toolName, input) {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" && typeof input?.command === "string") return providerSafeToolText(input.command.trim());
  if (normalized.includes("websearch") && typeof input?.query === "string") return providerSafeToolText(input.query.trim());
  if (normalized.includes("webfetch") && typeof input?.url === "string") return providerSafeToolText(input.url.trim());
  if (typeof input?.file_path === "string") return providerSafeToolText(input.file_path.trim());
  if (!input || typeof input !== "object") return "";
  const serialized = providerSafeToolText(input, { pretty: true });
  return serialized.length > 800 ? `${serialized.slice(0, 797)}...` : serialized;
}

export function claudeToolResultPreview(content) {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text).join("\n")
      : "";
  const safe = providerSafeToolText(text.trim());
  return safe.length > 800 ? `${safe.slice(0, 797)}...` : safe;
}

export function claudeStructuredToolResult(message, block, resultCount) {
  if (resultCount === 1 && message.tool_use_result
    && typeof message.tool_use_result === "object" && !Array.isArray(message.tool_use_result)) {
    return message.tool_use_result;
  }
  const text = typeof block.content === "string" ? block.content
    : Array.isArray(block.content) ? block.content.find((part) => part?.type === "text")?.text : null;
  if (typeof text !== "string" || text.length > 100_000) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

export function finalizeClaudeTurnItems(session, turnId, turnStatus) {
  if (!turnId || !Array.isArray(session?.items)) return;
  const agentIndexes = [];
  let lastContentIndex = null;
  session.items = session.items.map((item, index) => {
    if (item.turnId !== turnId) return item;
    if (item.type === "agentMessage") agentIndexes.push(index);
    if (!["userMessage", "reasoning", "system"].includes(item.type)) lastContentIndex = index;
    return { ...item, turnStatus };
  });
  const lastAgentIndex = agentIndexes.at(-1);
  const finalAgentIndex = lastAgentIndex === lastContentIndex
    && !session.toolContinuationItemIds?.has(session.items[lastAgentIndex]?.id) ? lastAgentIndex : null;
  session.items = session.items.map((item, index) => {
    if (item.turnId !== turnId || item.type !== "agentMessage") return item;
    return {
      ...item,
      presentationRole: index === finalAgentIndex ? "final_answer" : "commentary"
    };
  });
}

export function assistantText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function taskMessageText(message) {
  const segments = [
    message?.label,
    message?.status,
    message?.patch?.status,
    message?.description,
    message?.patch?.description,
    message?.summary,
    message?.patch?.error,
    message?.message,
    message?.content
  ].filter((value) => typeof value === "string" && value.trim());
  return segments.join(": ").trim();
}

export function claudeTaskSubtype(message) {
  const subtype = message?.type === "system" ? message?.subtype : message?.type;
  return [
    "task_started",
    "task_progress",
    "task_updated",
    "task_complete",
    "task_notification"
  ].includes(subtype) ? subtype : null;
}

export function isTerminalClaudeTaskMessage(message, subtype) {
  if (subtype === "task_complete" || subtype === "task_notification") return true;
  if (subtype !== "task_updated") return false;
  return ["completed", "failed", "killed"].includes(message?.patch?.status);
}

export function claudeTaskBlocksTurnSettlement(message) {
  if (typeof message?.subagent_type === "string" && message.subagent_type.trim()) {
    return true;
  }
  return ["agent", "subagent", "local_workflow"].includes(
    String(message?.task_type ?? "").trim().toLowerCase()
  );
}

export function lastMeaningfulText(items = []) {
  for (const item of items.slice().reverse()) {
    if (item.text && item.type !== "userMessage") {
      return item.text;
    }
  }
  return "";
}

export function latestSuggestedOptions(items = []) {
  for (const item of items.slice().reverse()) {
    if (item.type === "userMessage") {
      return null;
    }
    if ((item.type === "choice" || item.type === "agentMessage") && item.status !== "selected" && Array.isArray(item.options) && item.options.length >= 1) {
      return item.options;
    }
  }
  return null;
}

export function visibleClaudeItems(items = []) {
  const visible = [];
  for (const item of items) {
    const previous = visible.at(-1);
    const isDuplicateSuccessResult = item.type === "system"
      && item.title === "Claude Code"
      && item.status === "success"
      && previous?.type === "agentMessage"
      && previous?.text === item.text;
    if (!isDuplicateSuccessResult) {
      visible.push(item);
    }
  }
  return visible;
}

export function normalizeClaudeAccountUsage(usage, model = null) {
  const windows = [];
  const addWindow = (id, label, raw, durationMinutes) => {
    const usedPercent = finiteNumber(raw?.utilization);
    if (usedPercent === null) return;
    windows.push([id, {
      limitId: id,
      limitName: label,
      primary: {
        usedPercent,
        windowDurationMins: durationMinutes,
        resetsAt: epochSeconds(raw?.resets_at)
      },
      secondary: null
    }]);
  };
  addWindow("five_hour", "5 hour", usage?.rate_limits?.five_hour, 300);
  addWindow("seven_day", "7 day", usage?.rate_limits?.seven_day, 10_080);
  addWindow("seven_day_oauth_apps", "7 day OAuth apps", usage?.rate_limits?.seven_day_oauth_apps, 10_080);
  addWindow("seven_day_opus", "7 day Opus", usage?.rate_limits?.seven_day_opus, 10_080);
  addWindow("seven_day_sonnet", "7 day Sonnet", usage?.rate_limits?.seven_day_sonnet, 10_080);
  for (const [index, raw] of (usage?.rate_limits?.model_scoped ?? []).entries()) {
    addWindow(`model_scoped_${index}`, raw?.display_name || "Model", raw, 10_080);
  }
  return {
    available: usage?.rate_limits_available === true && windows.length > 0,
    provider: "claude",
    model,
    subscriptionType: usage?.subscription_type ?? null,
    rateLimits: windows[0]?.[1] ?? null,
    rateLimitsByLimitId: Object.fromEntries(windows)
  };
}

export function unavailableClaudeAccountUsage(model = null) {
  return {
    available: false,
    provider: "claude",
    model,
    rateLimits: null,
    rateLimitsByLimitId: {}
  };
}

export function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function epochSeconds(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp / 1_000 : null;
}

export function shortTitle(value) {
  const text = String(value ?? "").trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : (text || "Claude Code");
}
