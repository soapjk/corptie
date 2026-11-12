import { readClaudeConnection, describeClaudeConnection, validateClaudeConnection, stageClaudeConnection, mergeClaudeConnectionContent, CLAUDE_CONNECTION_CONFLICT_ENV } from "./claudeConnectionSource.mjs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { jsonCredentialReader } from "../application/providerRuntimeSettings.mjs";
import { readCodexAuthenticationSource } from "../runtime/codexAuthenticationSource.mjs";

const hasText = value => typeof value === "string" && value.trim().length > 0;

function accountIdentity(value) {
  const direct = value.tokens?.account_id ?? value.accountId ?? value.claudeAiOauth?.accountUuid;
  if (typeof direct === "string" && direct) return direct;
  for (const token of [value.tokens?.id_token, value.tokens?.access_token, value.claudeAiOauth?.accessToken]) {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      const identity = payload["https://api.openai.com/auth"]?.chatgpt_account_id ?? payload.sub;
      if (identity) return String(identity);
    } catch { /* Opaque tokens do not prove an account identity. */ }
  }
  return null;
}

export function createProviderCredentialAdapters({ codexPaths, claudePaths, openClackyPaths, nativeCodexHome,
  readCodexSource = readCodexAuthenticationSource }) {
  const claudeSettingsPath = claudePaths.settingsPath ?? join(claudePaths.configDir, "settings.json");
  const codexFile = jsonCredentialReader({ fileName: "auth.json", identity: accountIdentity,
    validate: value => [value.OPENAI_API_KEY, value.personal_access_token, value.tokens?.access_token,
      value.tokens?.refresh_token, value.agent_identity?.agent_private_key, value.agent_identity].some(hasText) });
  return {
    "codex-app-server": {
      runtimeDirectory: codexPaths.codexHome, target: codexPaths.authPath,
      formatDescription: "支持 Codex 官方 auth.json 凭证，以及官方登录环境对应的系统钥匙串条目。",
      sourceKinds: ["directory", "file", "keychain"],
      candidates: [...new Set([nativeCodexHome, process.env.CODEX_HOME].filter(path => path && path !== codexPaths.codexHome))]
        .map(path => ({ kind: "directory", path })),
      read: async source => {
        if (source.kind === "file") return codexFile(source);
        const result = await readCodexSource(join(source.path, "auth.json"), { allowKeychainRead: source.kind === "keychain" });
        if (!result) return null;
        const identity = accountIdentity(JSON.parse(result.content));
        return { content: result.content, identity: identity ? createHash("sha256").update(identity).digest("hex") : null };
      }
    },
    "claude-sdk": {
      runtimeDirectory: claudePaths.configDir, target: claudePaths.credentialsPath,
      formatDescription: "支持本机账号，以及含 API Key、Bearer Token 或 apiKeyHelper 的模型连接配置。",
      sourceKinds: ["directory", "file", "settings", "connection"],
      candidates: [
        ...(claudePaths.sourceSettingsPath ? [{ kind: "settings", path: claudePaths.sourceSettingsPath, label: "本机模型配置" }] : []),
        { kind: "file", path: claudePaths.sourceCredentialsPath, label: "本机账号" }
      ],
      managedConnectionPath: claudeSettingsPath,
      sourceManagesConnection: source => ["settings", "connection"].includes(source?.kind),
      targetForSource: source => ["settings", "connection"].includes(source?.kind)
        ? claudeSettingsPath : claudePaths.credentialsPath,
      targetContent: (source, content, previous) => ["settings", "connection"].includes(source?.kind)
        ? mergeClaudeConnectionContent(content, previous) : content,
      validateConnection: validateClaudeConnection,
      stageConnection: (input, selected) => stageClaudeConnection(claudeSettingsPath, input, selected),
      executionEnvironment: value => {
        const current = describeClaudeConnection(value);
        if (!current) return {};
        const settings = JSON.parse(value.content);
        return { ...settings.env, ...(settings.model && !settings.env.ANTHROPIC_MODEL ? { ANTHROPIC_MODEL: settings.model } : {}) };
      },
      // Explicit SDK settings keep helper authentication available even for
      // no-tools operations with settingSources: []. Never import hooks/MCP.
      executionOptions: value => {
        if (!describeClaudeConnection(value)) return {};
        const settings = JSON.parse(value.content);
        return settings?.apiKeyHelper ? { settings: { apiKeyHelper: settings.apiKeyHelper } } : {};
      },
      describeConnection: value => ({
        managedSource: { kind: "connection", path: claudeSettingsPath },
        importKind: "settings",
        current: describeClaudeConnection(value)
      }),
      read: source => ["settings", "connection"].includes(source.kind) ? readClaudeConnection(source)
        : jsonCredentialReader({ fileName: ".credentials.json", identity: accountIdentity,
            validate: value => hasText(value.claudeAiOauth?.accessToken) })(source)
    },
    openclacky: {
      runtimeDirectory: openClackyPaths.runtimeRoot, sourceKinds: [], candidates: [],
      unsupportedReason: "此适配器使用独立运行目录中的 Provider 配置，目前不支持单独选择登录凭证来源。请使用官方工具配置该环境。"
    }
  };
}

// An explicitly selected credential source must not be shadowed by inherited account secrets.
export function selectedCredentialEnvironment(environment, providerId, selected) {
  if (!selected) return environment;
  const result = { ...environment };
  const keys = providerId === "claude-sdk"
    ? [...CLAUDE_CONNECTION_CONFLICT_ENV, "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"]
    : ["OPENAI_API_KEY", "CODEX_API_KEY"];
  for (const key of keys) delete result[key];
  return result;
}
