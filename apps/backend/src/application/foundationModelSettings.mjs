import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export const FOUNDATION_API_ID = "foundation-api";
export const FOUNDATION_PURPOSES = new Set(["task-summary", "assist-draft", "assist-form-draft", "commit-message"]);
const defaults = { mode: "default", providerId: "", model: "", reasoning: "", baseURL: "", apiKey: "" };
export class FoundationModelSettings {
  constructor(dataRoot) {
    this.directory = join(dataRoot, "config");
    this.path = join(this.directory, "foundation-model.json");
    this.value = { ...defaults };
    try { this.value = validateFoundationSettings(JSON.parse(readFileSync(this.path, "utf8")), defaults); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  publicValue() { const { apiKey, ...value } = this.value; return { ...value, hasApiKey: Boolean(apiKey) }; }
  save(input) {
    const value = validateFoundationSettings(input, this.value);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.path);
    this.value = value;
    return this.publicValue();
  }
}
export function validateFoundationSettings(input, previous = defaults) {
  const value = { ...defaults };
  for (const key of Object.keys(defaults)) {
    value[key] = input[key] === undefined ? previous[key] : input[key];
    if (typeof value[key] !== "string" || value[key].length > (key === "apiKey" ? 8192 : 2048)) throw new Error("Invalid model settings.");
    value[key] = value[key].trim();
  }
  if (!["default", "provider", "api"].includes(value.mode)) throw new Error("Invalid model source.");
  if (value.baseURL !== previous.baseURL && input.apiKey === undefined) value.apiKey = "";
  if (value.mode === "provider" && !value.providerId) throw new Error("Choose a Provider.");
  if (value.mode === "api") {
    let url;
    try { url = new URL(value.baseURL); } catch { throw new Error("Invalid API Base URL."); }
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new Error("API requires HTTPS (HTTP allowed only for localhost), without URL credentials or query parameters.");
    }
    if (!value.model) throw new Error("API model is required.");
  }
  return value;
}

/// Text-only adapter: never exposes tools or follows redirects with credentials.
export async function invokeFoundationAPI(config, request, fetcher = fetch) {
  const endpoint = config.baseURL.replace(/\/+$/, "") + "/chat/completions";
  const body = { model: config.model, stream: false,
    messages: [{ role: "system", content: request.developerInstructions || "Complete the supplied text task. Do not call tools." },
      { role: "user", content: request.prompt }],
    ...(config.reasoning ? { reasoning_effort: config.reasoning } : {}),
    ...(request.outputSchema ? { response_format: { type: "json_schema", json_schema: {
      name: "corptie_result", strict: true, schema: request.outputSchema } } } : {}) };
  const response = await fetcher(endpoint, { method: "POST", redirect: "error", signal: request.signal,
    headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify(body) });
  // Do not echo third-party error bodies, prompts or credentials into logs.
  if (!response.ok) throw Object.assign(new Error(`Background API HTTP ${response.status}`), { code: "BACKGROUND_API_ERROR" });
  const reader = response.body.getReader();
  let bytes = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error("Background API response too large.");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Background API returned invalid JSON."); }
  const message = parsed?.choices?.[0]?.message;
  if (message?.tool_calls?.length || typeof message?.content !== "string" || !message.content.trim()) {
    throw Object.assign(new Error("Background API returned no usable text."), { code: "BACKGROUND_API_INVALID_OUTPUT" });
  }
  return { text: message.content, model: config.model };
}
