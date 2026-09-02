// choiceParser.mjs — 终端交互式 choice 选项解析（从 ptyAgentManager.mjs 抽离）。
//
// 用 LLM（OpenAI-compatible 或 local codex app-server）解析 Codex 输出的 approve/deny/选择提示，
// 供 codex-app-server 会话在 UI 中渲染可点击选项。独立于已删除的 pty/codex-pty provider。
//
// 导出：choiceParserShouldUseModel / parseChoiceStageWithConfiguredParser / configureChoiceParserRuntime

import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAppServerClient } from "./codexAppServer.mjs";
import { resolveCodexCommand } from "../utils/codexCommand.mjs";

export class LocalChoiceParserRuntime {
  constructor(options = {}) {
    this.process = null;
    this.output = "";
    this.signature = "";
    this.settings = null;
    this.ready = false;
    this.startPromise = null;
    this.queue = Promise.resolve();
    this.client = null;
    this.createClient = options.createClient
      ?? ((clientOptions) => new CodexAppServerClient(clientOptions));
  }

  configure(settings = {}) {
    if (!settings || settings.provider !== "local-agent") {
      this.stop("provider-disabled");
      return;
    }
    const signature = localChoiceParserSettingsSignature(settings);
    if (this.client && this.signature === signature) {
      return;
    }
    this.stop("reconfigure");
    this.signature = signature;
    this.settings = settings;
    const startPromise = this.start(settings);
    this.startPromise = startPromise;
    // configure() is intentionally fire-and-forget during Backend startup.
    // Preserve the rejected Promise for a later parse() caller, but observe it
    // here as well so a slow/unavailable local Provider cannot terminate Node
    // through an unhandled rejection.
    startPromise.catch((error) => {
      if (this.startPromise !== startPromise) return;
      this.ready = false;
      logChoiceParser("local-agent-start-failed", { id: "choice-parser-runtime", provider: "local-agent" }, {
        error: error?.message ?? String(error)
      });
    });
  }

  stop(reason = "stop") {
    if (this.process) {
      logChoiceParser("local-agent-stop", { id: "choice-parser-runtime", provider: "local-agent" }, { reason });
      this.process.kill();
    }
    this.client?.close().catch(() => {});
    this.client = null;
    this.process = null;
    this.output = "";
    this.ready = false;
    this.startPromise = null;
  }

  async start(settings = {}) {
    const command = settings.localCommand || defaultCodexCommand();
    const args = localChoiceParserAppServerArgs(settings);
    const cwd = localChoiceParserWorkspace();
    mkdirSync(cwd, { recursive: true });
    logChoiceParser("local-agent-start", { id: "choice-parser-runtime", provider: "local-agent" }, {
      command,
      args: redactLocalAgentArgs(args),
      model: settings.localModel || "",
      cwd
    });
    const startedAt = Date.now();
    this.client = this.createClient({
      command,
      args,
      requestTimeoutMs: Math.max(30000, settings.timeoutMs ?? 12000),
      env: {
        ...sanitizeEnv(process.env, "codex-app-server"),
        ...proxyEnvForAgent(settings.agentProxy, "choiceParser"),
        CORPTIE_CHOICE_PARSER: "1"
      }
    });
    await this.client.initialize();
    this.ready = true;
    logChoiceParser("local-agent-ready", { id: "choice-parser-runtime", provider: "local-agent" }, {
      ready: this.ready,
      durationMs: Date.now() - startedAt
    });
  }

  async parse(screenText = "", settings = {}, session = null) {
    this.configure(settings);
    this.queue = this.queue
      .catch(() => {})
      .then(() => this.parseNow(screenText, settings, session));
    return this.queue;
  }

  async parseNow(screenText = "", settings = {}, session = null) {
    if (this.startPromise) {
      await this.startPromise;
    }
    if (!this.client) {
      throw new Error("Local choice parser app-server is not running.");
    }
    const prompt = localChoiceParserPrompt(screenText);
    const startedAt = Date.now();
    logChoiceParser("local-agent-request", session, {
      chars: screenText.length,
      model: settings.localModel || "",
      promptChars: prompt.length
    });
    const timeoutMs = settings.timeoutMs ?? 12000;
    const result = await this.client.runChoiceParser({
      prompt,
      cwd: localChoiceParserWorkspace(),
      model: settings.localModel || undefined,
      timeoutMs
    });
    const json = extractChoiceParserJsonObject(result.text);
    if (json) {
      const normalized = normalizeChoiceParserJson(JSON.parse(json), screenText, "local-agent");
      logChoiceParser("local-agent-response", session, {
        ok: true,
        durationMs: Date.now() - startedAt,
        appServerDurationMs: result.durationMs,
        accepted: Boolean(normalized),
        options: normalized?.options?.length ?? 0,
        confidence: normalized?.confidence ?? 0,
        raw: normalized ? undefined : previewLogText(json)
      });
      return normalized;
    }
    logChoiceParser("local-agent-response", session, {
      ok: false,
      durationMs: Date.now() - startedAt,
      reason: "timeout-missing-json",
      timedOut: result.timedOut === true,
      output: previewLogText(result.text)
    });
    return null;
  }
}



const localChoiceParserRuntime = new LocalChoiceParserRuntime();

function sanitizeEnv(env, provider) {
  const next = { ...env };
  if (provider === "codex-app-server") {
    delete next.npm_config_prefix;
    delete next.npm_config_global;
    delete next.npm_config_user_agent;
    next.CORPTIE_MANAGED_CODEX = "1";
  }
  return next;
}

function proxyEnvForAgent(agentProxy = {}, agentKey = "") {
  const profile = agentProxy?.[agentKey];
  if (!profile?.enabled) {
    return {};
  }

  const env = {};
  setProxyEnvPair(env, "HTTP_PROXY", profile.httpProxy);
  setProxyEnvPair(env, "HTTPS_PROXY", profile.httpsProxy);
  setProxyEnvPair(env, "ALL_PROXY", profile.allProxy);
  setProxyEnvPair(env, "NO_PROXY", profile.noProxy);
  return env;
}

function setProxyEnvPair(env, key, value) {
  if (typeof value !== "string" || !value.trim()) {
    return;
  }
  env[key] = value.trim();
  env[key.toLowerCase()] = value.trim();
}

export function choiceParserShouldUseModel(screenText = "") {
  const text = trimChoiceScreen(screenText);
  if (!text || containsPendingUserInputRegion(text)) {
    return false;
  }
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const block = lastChoiceOptionBlock(lines);
  if (block?.count >= 2) {
    return true;
  }
  return lines.slice(-8).some((line) => isExplicitChoiceRequestLine(line));
}

function isExplicitChoiceRequestLine(line = "") {
  return /你现在可以|现在可以|可以选择|请选择|选择一个|选择操作|回复选项|which option|choose (?:one|an option)|select (?:one|an option)|pick (?:one|an option)|approve|approval|permission|allow|deny/i.test(line);
}

function trimChoiceScreen(screenText = "") {
  return screenText
    .split("\n")
    .slice(-80)
    .join("\n")
    .trim()
    .slice(-4000);
}

function buildChoiceContext(screenText = "") {
  const trimmed = trimChoiceScreen(screenText);
  if (!trimmed) {
    return null;
  }
  const sanitized = removePendingUserInputRegions(trimmed);
  if (!sanitized) {
    return null;
  }
  const lines = sanitized
    .split("\n")
    .map((line) => normalizeChoiceScreenLine(line))
    .filter((line) => line && !isNonChoiceStatusLine(line))
    .slice(-80);
  if (!lines.length) {
    return null;
  }

  const optionBlock = lastChoiceOptionBlock(lines);
  if (optionBlock && optionBlock.count >= 2) {
    return {
      text: lines.slice(Math.max(0, optionBlock.start - 4), Math.min(lines.length, optionBlock.end + 3)).join("\n"),
      source: "option-lines"
    };
  }

  const anchorIndex = findLastChoiceAnchorIndex(lines);
  if (anchorIndex < 0) {
    return null;
  }
  return {
    text: lines.slice(Math.max(0, anchorIndex - 8), Math.min(lines.length, anchorIndex + 12)).join("\n"),
    source: "anchor"
  };
}

function removePendingUserInputRegions(screenText = "") {
  const lines = screenText.split("\n");
  const cleaned = [];
  let droppingQueuedInputs = false;
  for (const line of lines) {
    const pendingIndex = pendingUserInputMarkerIndex(line);
    if (pendingIndex >= 0) {
      const prefix = line.slice(0, pendingIndex).trim();
      if (prefix) {
        cleaned.push(prefix);
      }
      droppingQueuedInputs = true;
      continue;
    }
    if (droppingQueuedInputs && isQueuedUserInputLine(line)) {
      continue;
    }
    droppingQueuedInputs = false;
    cleaned.push(line);
  }
  return cleaned
    .map((line) => stripQueuedUserInputFragments(line).trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function pendingUserInputMarkerIndex(line = "") {
  const compact = line.replace(/\s+/g, "").toLowerCase();
  const compactIndex = compact.indexOf("messagestobesubmittedafternexttoolcall");
  if (compactIndex >= 0) {
    const plainIndex = line.toLowerCase().search(/messages\s*to\s*be\s*submitted\s*after\s*next\s*tool\s*call/i);
    return plainIndex >= 0 ? plainIndex : Math.max(0, line.length - (compact.length - compactIndex));
  }
  return line.toLowerCase().search(/press\s+esc\s+to\s+interrupt\s+and\s+send\s+immediately/i);
}

function stripQueuedUserInputFragments(line = "") {
  const pendingIndex = pendingUserInputMarkerIndex(line);
  if (pendingIndex >= 0) {
    return line.slice(0, pendingIndex);
  }
  return line;
}

function isQueuedUserInputLine(line = "") {
  const text = line.trim();
  return /^[↳➜→]\s+/.test(text) || /^[-*]\s+\S/.test(text);
}

function normalizeChoiceScreenLine(line = "") {
  return line
    .replace(/\s+/g, " ")
    .replace(/([•└])(?=\S)/g, "$1 ")
    .replace(/([.!?。！？])(?=\S)/g, "$1 ")
    .trim();
}

function isNonChoiceStatusLine(line = "") {
  return /^worked for\b/i.test(line)
    || /^working\b/i.test(line)
    || /^•?\s*working\(/i.test(line)
    || /^•?\s*ran\b/i.test(line)
    || /^└\s*\d{4}-\d{2}-\d{2}\b/.test(line)
    || /^0;\[[^\]]+\]\s*action required/i.test(line);
}

function findLastChoiceAnchorIndex(lines = []) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isChoiceAnchorLine(lines[index])) {
      return index;
    }
  }
  return -1;
}

function isChoiceAnchorLine(line = "") {
  return /(\?|？|是否|选择|请选择|approve|allow|deny|cancel|continue|proceed|run command|permission|approval|\[[yn]\/[yn]\])/i.test(line)
    && !isNonChoiceStatusLine(line);
}

function parseChoiceStageWithRules(screenText = "") {
  const parsed = parseTerminalOptions(choiceOptionBlockText(screenText));
  if (parsed.options.length < 2) {
    return null;
  }
  return {
    prompt: inferChoicePrompt(screenText),
    options: parsed.options,
    selectedIndex: parsed.selectedIndex >= 0 ? parsed.selectedIndex : 0,
    confidence: 0.58,
    source: "rules"
  };
}

export async function parseChoiceStageWithConfiguredParser(screenText = "", settings = {}, session = null) {
  if (!settings || settings.provider === "disabled" || process.env.CORPTIE_DISABLE_LLM_CHOICE_PARSER === "1") {
    return null;
  }
  if (!choiceParserShouldUseModel(screenText)) {
    logChoiceParser("configured-skip", session, { provider: settings.provider, reason: "weak-choice-context" });
    return null;
  }
  if (settings.provider === "local-agent") {
    return parseChoiceStageWithLocalAgent(screenText, settings, session);
  }
  return parseChoiceStageWithOpenAi(screenText, settings, session);
}

export function configureChoiceParserRuntime(settings = {}) {
  localChoiceParserRuntime.configure(settings);
}

async function parseChoiceStageWithOpenAi(screenText = "", settings = {}, session = null) {
  const apiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY || process.env.CORPTIE_OPENAI_API_KEY;
  if (!apiKey) {
    logChoiceParser("openai-skip", session, { reason: "missing-api-key" });
    return null;
  }
  const model = settings.openaiModel || process.env.CORPTIE_CHOICE_PARSER_MODEL || "gpt-4o-mini";
  const endpoint = openAiCompatibleChatCompletionsURL(settings.openaiBaseURL || process.env.CORPTIE_CHOICE_PARSER_BASE_URL);
  const startedAt = Date.now();
  logChoiceParser("openai-request-start", session, { model, endpoint: redactURL(endpoint), chars: screenText.length });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You extract interactive terminal choice prompts for a desktop agent UI.",
            "Return only JSON with: kind, prompt, options, selectedIndex, confidence.",
            "options must be an array of {id,label,role}. role is one of approve, approve-always, deny, edit, other.",
            "Only extract options that are visibly present in the supplied candidate region.",
            "Never treat queued user messages, chat history, tool logs, or status text as options.",
            "If the screen is not asking the user to choose an option, return {\"kind\":\"none\",\"options\":[],\"selectedIndex\":-1,\"confidence\":0}."
          ].join(" ")
        },
        {
          role: "user",
          content: `Terminal candidate choice region:\n${screenText}`
        }
      ]
    })
  });
  const headersAt = Date.now();
  logChoiceParser("openai-response-headers", session, {
    ok: response.ok,
    status: response.status,
    durationMs: headersAt - startedAt,
    contentType: response.headers.get("content-type") ?? ""
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const errorMessage = choiceParserHttpErrorMessage(response.status, errorText);
    logChoiceParser("openai-response-error", session, {
      ok: false,
      status: response.status,
      durationMs: Date.now() - startedAt,
      bodyReadMs: Date.now() - headersAt,
      error: errorMessage
    });
    throw new Error(errorMessage);
  }
  const responseText = await response.text();
  const bodyAt = Date.now();
  logChoiceParser("openai-response-body", session, {
    durationMs: bodyAt - startedAt,
    bodyReadMs: bodyAt - headersAt,
    bytes: Buffer.byteLength(responseText)
  });
  const data = JSON.parse(responseText);
  const parsedAt = Date.now();
  logChoiceParser("openai-response-json", session, {
    durationMs: parsedAt - startedAt,
    parseMs: parsedAt - bodyAt
  });
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) {
    logChoiceParser("openai-response-final", session, { ok: true, durationMs: Date.now() - startedAt, reason: "empty-content" });
    return null;
  }
  const normalized = normalizeChoiceParserJson(JSON.parse(raw), screenText, "openai");
  const normalizedAt = Date.now();
  logChoiceParser("openai-response-final", session, {
    ok: true,
    durationMs: normalizedAt - startedAt,
    normalizeMs: normalizedAt - parsedAt,
    accepted: Boolean(normalized),
    options: normalized?.options?.length ?? 0,
    confidence: normalized?.confidence ?? 0
  });
  return normalized;
}

function openAiCompatibleChatCompletionsURL(baseURL) {
  const raw = typeof baseURL === "string" && baseURL.trim()
    ? baseURL.trim()
    : "https://api.openai.com/v1";
  const withoutTrailingSlash = raw.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(withoutTrailingSlash)) {
    return withoutTrailingSlash;
  }
  return `${withoutTrailingSlash}/chat/completions`;
}

function choiceParserHttpErrorMessage(status, body = "") {
  const fallback = `OpenAI-compatible parser request failed with HTTP ${status}.`;
  if (!body) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || parsed?.message || parsed?.error;
    if (message) {
      return `${fallback} ${String(message)}`;
    }
  } catch {
    // Fall back to a short body preview below.
  }
  return `${fallback} ${body.replace(/\s+/g, " ").trim().slice(0, 500)}`;
}

async function parseChoiceStageWithLocalAgent(screenText = "", settings = {}, session = null) {
  return localChoiceParserRuntime.parse(screenText, settings, session);
}

function localChoiceParserPrompt(screenText = "") {
  const compactScreenText = screenText.replace(/\s*\n\s*/g, " \\n ").trim();
  return [
    "Return JSON only. Detect whether this terminal text is asking the user to choose.",
    "Fields: kind, prompt, options, selectedIndex, confidence.",
    "options items: id, label, role. Roles: approve, approve-always, deny, edit, other.",
    "Use only visible option labels. If no choice: kind none, options empty, selectedIndex -1, confidence 0.",
    `Terminal candidate choice region: ${compactScreenText}`
  ].join(" ");
}

function localChoiceParserAppServerArgs(settings = {}) {
  const configuredArgs = splitShellArgs(settings.localArgs || "");
  return [
    "app-server",
    "--listen",
    "stdio://",
    "--disable",
    "hooks",
    "-c",
    "model_reasoning_effort=\"low\"",
    "-c",
    "mcp_servers={}",
    "-c",
    "features.rmcp_client=false",
    "-c",
    "web_search=\"disabled\"",
    ...configuredArgs
  ].filter(Boolean);
}

function localChoiceParserWorkspace() {
  return path.join(os.tmpdir(), "corptie-choice-parser-workspace");
}

function localChoiceParserSettingsSignature(settings = {}) {
  return JSON.stringify({
    command: settings.localCommand || defaultCodexCommand(),
    args: settings.localArgs || "",
    model: settings.localModel || "",
    proxy: settings.agentProxy?.choiceParser ?? null
  });
}

function redactLocalAgentArgs(args = []) {
  return args.map((arg) => {
    if (typeof arg !== "string") {
      return arg;
    }
    if (arg.length > 120 || arg.includes("\n")) {
      return `<prompt:${arg.length} chars>`;
    }
    return arg;
  });
}

function previewLogText(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function normalizeChoiceParserJson(parsed, screenText, source) {
  if (parsed.kind === "none" || !Array.isArray(parsed.options)) {
    return null;
  }
  const options = parsed.options
    .map((option, index) => normalizeParsedChoiceOption(option, index))
    .filter((option) => option.label);
  if (!choiceOptionsAreGrounded(options, screenText)) {
    return null;
  }
  return {
    prompt: String(parsed.prompt || inferChoicePrompt(screenText)).trim(),
    options,
    selectedIndex: Number.isInteger(parsed.selectedIndex) ? parsed.selectedIndex : 0,
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
    source
  };
}

function normalizeParsedChoiceOption(option, index) {
  if (typeof option === "string" || typeof option === "number") {
    return {
      id: `option-${index}`,
      label: String(option).trim(),
      role: "other"
    };
  }
  if (!option || typeof option !== "object") {
    return {
      id: `option-${index}`,
      label: "",
      role: "other"
    };
  }
  const role = typeof option.role === "string" && option.role.trim() ? option.role.trim() : "other";
  const label = option.label ?? option.text ?? option.title ?? option.name ?? option.value ?? "";
  return {
    id: String(option.id || `${role}-${index}`),
    label: String(label).trim(),
    role
  };
}

function choiceOptionsAreGrounded(options = [], screenText = "") {
  if (options.length < 2) {
    return false;
  }
  if (containsPendingUserInputRegion(screenText)) {
    return false;
  }
  const haystack = normalizeForChoiceGrounding(screenText);
  return options.every((option) => {
    const label = String(option.label || "").trim();
    if (!label || isLikelyQueuedUserMessageOption(label)) {
      return false;
    }
    const needle = normalizeForChoiceGrounding(label);
    return needle.length >= 2 && haystack.includes(needle);
  });
}

function containsPendingUserInputRegion(text = "") {
  return pendingUserInputMarkerIndex(text) >= 0 || /↳\s+\S/.test(text);
}

function isLikelyQueuedUserMessageOption(label = "") {
  return /^\/model\b/i.test(label)
    || /^\/\w+\b/.test(label)
    || /operation not permitted/i.test(label)
    || /为什么|刚刚|我刚|我现在|你没有|你为什么/.test(label);
}

function normalizeForChoiceGrounding(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[\s"'`*_~()[\]{}<>:：,，.。!！?？;；|\\/+-]/g, "")
    .trim();
}

function extractFirstJsonObject(text = "") {
  return extractJsonObjects(text)[0] ?? "";
}

function extractChoiceParserJsonObject(text = "") {
  for (const candidate of extractJsonObjects(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (Object.prototype.hasOwnProperty.call(parsed, "options")
            || Object.prototype.hasOwnProperty.call(parsed, "kind")
            || Object.prototype.hasOwnProperty.call(parsed, "prompt")) {
          return candidate;
        }
      }
    } catch {
      // Candidates are already parsed in extractJsonObjects, but keep this defensive.
    }
  }
  return "";
}

function extractJsonObjects(text = "") {
  const results = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = inString;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, index + 1);
          try {
            JSON.parse(candidate);
            results.push(candidate);
          } catch {
            // Keep scanning; terminal output often contains partial objects while streaming.
          }
          break;
        }
      }
    }
  }
  return results;
}

function splitShellArgs(value = "") {
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match;
  while ((match = pattern.exec(value))) {
    args.push(match[1] ?? match[2] ?? match[0]);
  }
  return args;
}

function inferChoicePrompt(screenText = "") {
  const lines = screenText
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (const line of lines.slice(-12).reverse()) {
    if (looksLikeChoiceLine(line)) {
      continue;
    }
    if (/[?？]$|approval|permission|allow|run|continue|是否|允许|选择|请选择/i.test(line)) {
      return line;
    }
  }
  return "The agent is waiting for a choice.";
}

function parseTerminalOptions(screenText = "") {
  const lines = screenText
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-80);
  const options = [];
  let selectedIndex = -1;
  for (const line of lines) {
    if (!looksLikeChoiceLine(line)) {
      continue;
    }
    const selected = /^[>›❯➜▶●◉]\s*/.test(line) || /\bselected\b/i.test(line);
    const label = normalizeChoiceLabel(line);
    if (!label || label.length > 80 || isCodexNoise(label)) {
      continue;
    }
    const role = approvalOptionRole(label);
    const id = `${role}-${options.length}`;
    const option = { id, label, role, index: options.length };
    options.push(option);
    if (selected) {
      selectedIndex = option.index;
    }
  }
  const deduped = [];
  const seen = new Set();
  for (const option of options) {
    const key = option.label.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({ ...option, index: deduped.length, id: `${option.role}-${deduped.length}` });
  }
  if (selectedIndex >= deduped.length) {
    selectedIndex = -1;
  }
  return { options: deduped.slice(-6), selectedIndex };
}

function choiceOptionBlockText(screenText = "") {
  const lines = screenText
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-80);
  const block = lastChoiceOptionBlock(lines);
  if (block) {
    return lines.slice(Math.max(0, block.start - 2), block.end + 1).join("\n");
  }
  return lines.some((line) => looksLikeChoiceLine(line)) ? "" : screenText;
}

function lastChoiceOptionBlock(lines = []) {
  const blocks = [];
  let current = null;
  for (const [index, line] of lines.entries()) {
    if (looksLikeChoiceLine(line)) {
      if (!current) {
        current = { start: index, end: index, count: 0 };
      }
      current.end = index;
      current.count += 1;
      continue;
    }
    if (current) {
      blocks.push(current);
      current = null;
    }
  }
  if (current) {
    blocks.push(current);
  }

  return blocks
    .filter((block) => block.count >= 2)
    .filter((block) => !isInventoryOnlyOptionBlock(lines, block))
    .at(-1) ?? null;
}

function isInventoryOnlyOptionBlock(lines = [], block) {
  const before = lines.slice(Math.max(0, block.start - 3), block.start).join(" ");
  const hasChoiceAnchor = lines
    .slice(Math.max(0, block.start - 4), block.start)
    .some((line) => isChoiceAnchorLine(line));
  if (hasChoiceAnchor) {
    return false;
  }
  return /里面有|物资|背包|清单|包括|inventory|contains/i.test(before);
}

function choiceOptionsFromAgentMessage(text = "") {
  if (!isAgentMessageChoicePrompt(text)) {
    return null;
  }
  const options = numberedChoiceOptionsFromLines(text);
  if (options.length < 2) {
    options.push(...numberedChoiceOptionsFromInlineText(text));
  }
  return options.length >= 2 ? options.slice(0, 8) : null;
}

function numberedChoiceOptionsFromLines(text = "") {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const options = [];
  for (const line of lines) {
    const match = line.match(/^(?:[-*]\s*)?(\d{1,2})[.)、]\s+(.+)$/);
    if (!match) {
      continue;
    }
    const label = cleanAgentChoiceLabel(match[2]);
    if (!label || label.length > 120 || isCodexNoise(label)) {
      continue;
    }
    options.push({
      id: `content-choice-${options.length}`,
      label,
      role: "message-choice",
      index: options.length,
      selected: false
    });
  }
  return options;
}

function numberedChoiceOptionsFromInlineText(text = "") {
  const normalized = text.replace(/\s+/g, " ").trim();
  const pattern = /(?:^|\s)(\d{1,2})[.)、]\s+(.+?)(?=\s+\d{1,2}[.)、]\s+|$)/g;
  const options = [];
  let match;
  while ((match = pattern.exec(normalized))) {
    const label = cleanAgentChoiceLabel(match[2]);
    if (!label || label.length > 180 || isCodexNoise(label)) {
      continue;
    }
    options.push({
      id: `content-choice-${options.length}`,
      label,
      role: "message-choice",
      index: options.length,
      selected: false
    });
  }
  return options;
}

function isAgentMessageChoicePrompt(text = "") {
  return /你可以选择|请选择|你选择几|你要做什么|你要怎么做|接下来做什么|选择哪|选哪|前方有.{0,12}方向|which do you choose|choose one|you can choose|pick one|what do you do/i.test(text);
}

function cleanAgentChoiceLabel(label = "") {
  return label
    .replace(/\s{2,}$/g, "")
    .replace(/^\*\*(.+)\*\*$/s, "$1")
    .replace(/\*\*/g, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
}

function looksLikeChoiceLine(line) {
  return /^[>›❯➜▶●◉○◌]\s+/.test(line)
    || /^\(?[0-9a-z]\)?[.)]\s+/.test(line)
    || /^\[[ xX✓✔-]\]\s+/.test(line)
    || /^(approve|allow|run|continue|yes|deny|reject|cancel|no)\b/i.test(line)
    || /\b(approve|allow|run command|continue|yes|deny|reject|cancel|no)\b/i.test(line);
}

function normalizeChoiceLabel(line) {
  return line
    .replace(/^[>›❯➜▶●◉○◌]\s*/, "")
    .replace(/^\(?[0-9a-z]\)?[.)]\s*/i, "")
    .replace(/^\[[ xX✓✔-]\]\s*/, "")
    .replace(/\bselected\b/ig, "")
    .trim();
}

function approvalOptionRole(label = "") {
  if (/\b(deny|reject|cancel|no|do not|don't)\b|拒绝|取消|不允许/i.test(label)) {
    return "deny";
  }
  if (/\b(always|forever|remember)\b|总是|永久|记住/i.test(label)) {
    return "approve-always";
  }
  return "approve";
}

function optionSelectionSequence(options, targetIndex) {
  if (!options.length || targetIndex < 0) {
    return "\r";
  }
  const selectedIndex = options.findIndex((option) => option.selected === true);
  if (selectedIndex < 0) {
    return `${"\x1b[A".repeat(options.length)}${"\x1b[B".repeat(targetIndex)}\r`;
  }
  const delta = targetIndex - selectedIndex;
  if (delta > 0) {
    return `${"\x1b[B".repeat(delta)}\r`;
  }
  if (delta < 0) {
    return `${"\x1b[A".repeat(Math.abs(delta))}\r`;
  }
  return "\r";
}

function firstLine(value = "") {
  return shorten(String(value).split("\n")[0].trim(), 72);
}

function shorten(value = "", limit = 60) {
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

function previewText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function logChoiceParser(event, session, details = {}) {
  const noisySkip = event === "skip" || event === "configured-skip";
  if (noisySkip && process.env.CORPTIE_CHOICE_PARSER_DEBUG !== "1") {
    return;
  }
  const sessionId = session?.id ?? "unknown";
  const safeDetails = Object.fromEntries(
    Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 220) : value])
  );
  console.log(`[choice-parser] event=${event} session=${sessionId} ${JSON.stringify(safeDetails)}`);
}

function redactURL(value = "") {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return String(value).replace(/\?.*$/, "");
  }
}

function defaultCodexCommand() {
  return resolveCodexCommand();
}
