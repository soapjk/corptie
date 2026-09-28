import { parseJson } from "./storedJson.mjs";

export function isAgentNoise(text = "") {
  return /^现$|^your config\.toml:?$|^Started codex resume |You have \d+ usage limit resets available|10;\?11;\?.*>_ OpenAI Codex|^(?:10;\?11;\?|\[[0-9;?]*[a-zA-Z])$|^>_ OpenAI Codex|^model:\s|^directory:\s|features?.*web[_\s-]?search[_\s-]?request.*deprecated|web[_\s-]?search[_\s-]?request.*deprecated|set [`'"]?web[_\s-]?search[`'"]?.*(live|true|enabled)|falling back from web ?sockets? to https|websocket.*fallback|under a profile\) in config\.toml|Tip: Try the Codex App|HooksLifecycle hooks|EventInstalledActiveReviewDescription|MCP startup incomplete|MCP client .* timed out|Starting MCP servers|startup_timeout_sec|\[mcp_servers\.|0;[⠼⠴⠦⠧⠇⠏⠋⠙⠹⠸]/i.test(text);
}

export function normalizeStoredItem(item, provider) {
  // Product timeline projections may carry provider-neutral presentation
  // fields that are intentionally not first-class SQLite columns (automation,
  // collaboration, system-event metadata). Keep the indexed identity/content
  // columns authoritative while restoring those optional fields on reads.
  const metadata = parseJson(item.rawMetadataJSON, null);
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? { ...metadata, ...item }
    : item;
}

export function normalizeStoredText(text = "", provider = "") {
  return text;
}
