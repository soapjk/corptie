import { providerSafeToolText } from "./providerRawMetadata.mjs";

const TOOL_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"]);
const MAX_NAME = 160;
const MAX_PREVIEW = 2_000;

export function toolExecutionForItem(item, { input = null, result = null } = {}) {
  if (!TOOL_TYPES.has(item?.type)) return null;
  return {
    schemaVersion: 1,
    toolId: String(item.id ?? "").slice(0, 200),
    name: String(item.title ?? item.type).slice(0, MAX_NAME),
    status: toolStatus(item.status),
    input: preview(input),
    result: preview(result)
  };
}

export function withToolExecutionMetadata(rawMetadataJSON, toolExecution) {
  if (!toolExecution) return rawMetadataJSON;
  let metadata = {};
  try {
    const parsed = JSON.parse(rawMetadataJSON);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch { /* The normalized tool projection remains available. */ }
  return JSON.stringify({ ...metadata, toolExecution });
}

export function publicToolExecution(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.toolId !== "string"
    || !value.toolId || value.toolId.length > 200 || typeof value.name !== "string"
    || !value.name || value.name.length > MAX_NAME) return null;
  return {
    schemaVersion: 1,
    toolId: value.toolId,
    name: value.name,
    status: toolStatus(value.status),
    input: preview(value.input),
    result: preview(value.result)
  };
}

function toolStatus(value) {
  switch (String(value ?? "").toLowerCase().replaceAll("_", "")) {
  case "running": case "inprogress": case "started": return "running";
  case "completed": case "complete": return "completed";
  case "failed": case "error": return "failed";
  case "cancelled": case "canceled": case "interrupted": return "cancelled";
  default: return "unknown";
  }
}

function preview(value) {
  if (value == null) return null;
  // Structured tool arguments/results can contain credentials under named keys.
  // Reuse the existing Provider metadata redactor before making a public preview.
  const text = providerSafeToolText(value);
  if (!text) return null;
  return text.length <= MAX_PREVIEW ? text : `${text.slice(0, MAX_PREVIEW - 1)}…`;
}
