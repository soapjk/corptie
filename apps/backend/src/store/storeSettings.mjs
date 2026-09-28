import { normalizeNewSessionDefaults } from "../utils/newSessionDefaults.mjs";
import { resolveDataRootLayout } from "../runtime/dataRootLayout.mjs";

const SETTINGS_FIELDS = new Set([
  "dataRoot", "choiceParser", "codexBackend", "codeDiff", "agentProxy", "newSessionDefaults", "gateway"
]);
export const DEPRECATED_PATH_FIELDS = new Set([
  "dataDir", "logDir", "dbPath", "configPath", "artifactDir", "runtimeDir", "backupDir"
]);

// Configuration access is live: data-root switching may replace Store.config.
// File persistence remains with the data-root lifecycle owner.
export class StoreSettings {
  constructor({ getConfiguration, getDataRoot, writeConfig, environmentName }) {
    this.getConfiguration = getConfiguration;
    this.getDataRoot = getDataRoot;
    this.writeConfig = writeConfig;
    this.environmentName = environmentName;
  }

  get config() { return this.getConfiguration(); }
  get dataRoot() { return this.getDataRoot(); }

  settings() {
    return {
      environment: this.environmentName,
      dataRoot: this.dataRoot,
      choiceParser: this.choiceParserSettings(),
      codexBackend: this.codexBackendSettings(),
      codeDiff: this.codeDiffSettings(),
      agentProxy: this.agentProxySettings(),
      newSessionDefaults: this.newSessionDefaults(),
      gateway: this.gatewaySettings()
    };
  }

  choiceParserSettings() {
    const configured = this.config.choiceParser ?? {};
    return normalizeChoiceParserSettings(configured);
  }

  codexBackendSettings() {
    return normalizeCodexBackendSettings(this.config.codexBackend ?? {});
  }

  codeDiffSettings() {
    return normalizeCodeDiffSettings(this.config.codeDiff ?? {});
  }

  agentProxySettings() {
    const configured = this.config.agentProxy ?? {};
    return normalizeAgentProxySettings(configured);
  }

  newSessionDefaults() {
    return normalizeNewSessionDefaults(this.config.newSessionDefaults ?? {});
  }

  gatewaySettings() {
    return normalizeGatewaySettings(this.config.gateway ?? {});
  }

  async updateSettings(input = {}) {
    assertSettingsFields(input);
    if (Object.hasOwn(input, "dataRoot")) {
      const requested = resolveDataRootLayout(input.dataRoot, this.environmentName).dataRoot;
      if (requested !== this.dataRoot) {
        const error = new Error("Data Root changes must be coordinated by the Backend migration service.");
        error.code = "DATA_ROOT_MIGRATION_COORDINATOR_REQUIRED";
        error.statusCode = 409;
        throw error;
      }
    }
    if (input.choiceParser && typeof input.choiceParser === "object") {
      this.config.choiceParser = normalizeChoiceParserSettings(input.choiceParser);
      await this.writeConfig();
    }
    if (input.codexBackend && typeof input.codexBackend === "object") {
      this.config.codexBackend = normalizeCodexBackendSettings(input.codexBackend);
      await this.writeConfig();
    }
    if (input.codeDiff && typeof input.codeDiff === "object") {
      this.config.codeDiff = normalizeCodeDiffSettings(input.codeDiff);
      await this.writeConfig();
    }
    if (input.agentProxy && typeof input.agentProxy === "object") {
      this.config.agentProxy = normalizeAgentProxySettings(input.agentProxy);
      await this.writeConfig();
    }
    if (input.newSessionDefaults && typeof input.newSessionDefaults === "object") {
      this.config.newSessionDefaults = normalizeNewSessionDefaults({
        ...(this.config.newSessionDefaults ?? {}),
        ...input.newSessionDefaults
      });
      await this.writeConfig();
    }
    if (input.gateway && typeof input.gateway === "object") {
      this.config.gateway = normalizeGatewaySettings(input.gateway);
      await this.writeConfig();
    }
    return this.settings();
  }
}

function normalizeChoiceParserSettings(input = {}) {
  const provider = ["disabled", "openai", "local-agent"].includes(input.provider) ? input.provider : "local-agent";
  return {
    provider,
    openaiBaseURL: normalizeOpenAiCompatibleBaseURL(input.openaiBaseURL),
    openaiApiKey: typeof input.openaiApiKey === "string" ? input.openaiApiKey : "",
    openaiModel: typeof input.openaiModel === "string" && input.openaiModel.trim() ? input.openaiModel.trim() : "gpt-4o-mini",
    localCommand: typeof input.localCommand === "string" && input.localCommand.trim() ? input.localCommand.trim() : "codex",
    localArgs: typeof input.localArgs === "string" ? input.localArgs : "",
    localModel: typeof input.localModel === "string" ? input.localModel : "",
    timeoutMs: Number.isFinite(Number(input.timeoutMs)) ? Math.max(1000, Math.min(60000, Number(input.timeoutMs))) : 12000
  };
}

function normalizeCodexBackendSettings(input = {}) {
  return { mode: "app-server" };
}

function normalizeCodeDiffSettings(input = {}) {
  const tools = new Set(["automatic", "git-difftool", "filemerge", "vscode", "kaleidoscope", "beyond-compare", "sublime-merge"]);
  return {
    tool: tools.has(input.tool) ? input.tool : "automatic"
  };
}

function normalizeOpenAiCompatibleBaseURL(value) {
  const raw = typeof value === "string" && value.trim()
    ? value.trim()
    : "https://api.openai.com/v1";
  return raw.replace(/\/+$/, "");
}

function normalizeAgentProxySettings(input = {}) {
  return {
    codex: normalizeProxyProfile(input.codex),
    choiceParser: normalizeProxyProfile(input.choiceParser)
  };
}

function normalizeGatewaySettings(input = {}) {
  const paths = Array.isArray(input.trustedWorkspaces) ? input.trustedWorkspaces : [];
  return {
    trustedWorkspaces: Array.from(new Set(paths
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim())))
  };
}

function normalizeProxyProfile(input = {}) {
  return {
    enabled: input.enabled === true,
    httpProxy: normalizeProxyValue(input.httpProxy),
    httpsProxy: normalizeProxyValue(input.httpsProxy),
    allProxy: normalizeProxyValue(input.allProxy),
    noProxy: normalizeNoProxyValue(input.noProxy)
  };
}

function normalizeProxyValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNoProxyValue(value) {
  const fallback = "localhost,127.0.0.1,::1,.local,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function assertSettingsFields(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Settings patch must be an object.");
  }
  for (const field of Object.keys(input)) {
    if (DEPRECATED_PATH_FIELDS.has(field)) {
      const error = new TypeError(`Settings field '${field}' is no longer supported; use 'dataRoot'.`);
      error.code = "DEPRECATED_SETTINGS_PATH_FIELD";
      throw error;
    }
    if (!SETTINGS_FIELDS.has(field)) {
      const error = new TypeError(`Unknown settings field: ${field}`);
      error.code = "UNKNOWN_SETTINGS_FIELD";
      throw error;
    }
  }
}
