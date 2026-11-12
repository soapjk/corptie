import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Import connection settings only. Hooks, permissions, plugins and MCP remain Corptie-owned.
export const CLAUDE_CONNECTION_ENV = Object.freeze([
  "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"
]);
export const CLAUDE_CONNECTION_CONFLICT_ENV = Object.freeze([
  ...CLAUDE_CONNECTION_ENV, "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_DEFAULT_MODEL"
]);
const text = value => typeof value === "string" ? value.trim() : "";
const invalid = message => Object.assign(new Error(message), { code: "PROVIDER_CONNECTION_INVALID" });

function endpointValue(value) {
  let url;
  try { url = new URL(text(value)); } catch { throw invalid("请输入有效的服务地址。"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw invalid("服务地址仅支持 HTTP 或 HTTPS，且不能包含凭证、查询参数或片段。");
  }
  return url.href.replace(/\/$/, "");
}

async function jsonFile(path) {
  const info = await stat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.size > 256 * 1024) throw invalid("连接配置文件过大或格式无效。");
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw invalid("无法读取连接配置，请检查 JSON 格式。"); }
}

export function connectionSettings(value) {
  const env = Object.fromEntries(CLAUDE_CONNECTION_ENV.flatMap(key => text(value?.env?.[key])
    ? [[key, text(value.env[key])]] : []));
  const apiKeyHelper = text(value?.apiKeyHelper);
  if (apiKeyHelper.length > 8192 || apiKeyHelper.includes("\0")) throw invalid("密钥获取配置无效。");
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN && !apiKeyHelper) return null;
  if (env.ANTHROPIC_AUTH_TOKEN) delete env.ANTHROPIC_API_KEY;
  const model = text(value?.model);
  if (env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = endpointValue(env.ANTHROPIC_BASE_URL);
  if (model.length > 200 || /[\r\n\0]/.test(model)) throw invalid("请输入有效的模型名称。");
  return { env, ...(model ? { model } : {}), ...(apiKeyHelper ? { apiKeyHelper } : {}) };
}

export async function readClaudeConnection(source) {
  const settings = connectionSettings(await jsonFile(source.path));
  return settings ? { content: `${JSON.stringify(settings)}\n`, identity: null } : null;
}

export function describeClaudeConnection(value) {
  if (!value) return null;
  const settings = connectionSettings(JSON.parse(value.content));
  if (!settings) return null;
  return {
    endpoint: settings.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    model: settings.env.ANTHROPIC_MODEL || settings.model || "",
    authType: settings.env.ANTHROPIC_AUTH_TOKEN ? "authToken" : settings.env.ANTHROPIC_API_KEY ? "apiKey" : "helper",
    credentialConfigured: true
  };
}

export function validateClaudeConnection(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("模型来源配置无效。");
  const endpoint = text(input.endpoint), model = text(input.model);
  const url = endpointValue(endpoint);
  if (!model || model.length > 200 || /[\r\n\0]/.test(model)) throw invalid("请输入有效的模型名称。");
  if (!["apiKey", "authToken"].includes(input.authType)) throw invalid("请选择 API Key 或 Bearer Token 认证。");
  const credential = input.credential == null ? null : text(input.credential);
  if (credential !== null && (!credential || credential.length > 8192 || /[\r\n\0]/.test(credential))) {
    throw invalid("请输入有效的密钥。");
  }
  return { endpoint: url, model, authType: input.authType, credential };
}

// The managed settings file is the existing isolated runtime's settings.json.
// A failed source commit restores the exact previous bytes.
export async function stageClaudeConnection(path, input, selected) {
  const config = validateClaudeConnection(input);
  const previous = await readFile(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const current = await jsonFile(path) ?? {};
  const key = config.authType === "authToken" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
  const credential = config.credential ?? (selected?.kind === "connection" ? text(current.env?.[key]) : "");
  if (!credential) throw invalid("请填写此模型来源的密钥。");
  const env = { ...(current.env ?? {}) };
  for (const name of CLAUDE_CONNECTION_CONFLICT_ENV) delete env[name];
  Object.assign(env, { ANTHROPIC_BASE_URL: config.endpoint, [key]: credential });
  const settings = { ...current, env, model: config.model };
  delete settings.apiKeyHelper;
  const atomic = async content => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.connection-${process.pid}`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  };
  return {
    source: { kind: "connection", path },
    write: () => atomic(`${JSON.stringify(settings, null, 2)}\n`),
    restore: () => previous === null ? unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; }) : atomic(previous)
  };
}


// Preserve Corptie-owned settings while replacing only the connection surface.
export function mergeClaudeConnectionContent(content, previous) {
  let current = {};
  try { current = previous ? JSON.parse(previous) : {}; }
  catch { throw invalid("独立运行配置格式无效。"); }
  const connection = JSON.parse(content);
  const env = { ...(current.env ?? {}) };
  for (const key of CLAUDE_CONNECTION_CONFLICT_ENV) delete env[key];
  Object.assign(env, connection.env);
  const merged = { ...current, env };
  delete merged.model;
  delete merged.apiKeyHelper;
  if (connection.model) merged.model = connection.model;
  if (connection.apiKeyHelper) merged.apiKeyHelper = connection.apiKeyHelper;
  return `${JSON.stringify(merged, null, 2)}\n`;
}
