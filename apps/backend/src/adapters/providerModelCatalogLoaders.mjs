import { startup as startClaudeRuntime } from "@anthropic-ai/claude-agent-sdk";

// Provider-specific discovery caches. The registry exposes their common model
// catalog contract; neither cache is shared with ordinary Session transcripts.
export function createProviderModelCatalogLoaders({
  store, codexAppServerCommand, corptieCodexRuntimePaths, environmentForCommand,
  execFileAsync, readCodexDefaultConfig, defaultWorkspacePath, claudeCommand,
  startup = startClaudeRuntime,
  codexHome = () => corptieCodexRuntimePaths.codexHome,
  claudeConnection = () => null, claudeEnvironment = () => process.env
}) {
  let codexModelsCache = null;
  let claudeModelsCache = null;

  async function loadCodexModels(options = {}) {
    const nowMs = Date.now();
    const refresh = options.refresh === true;
    const home = codexHome();
    if (!refresh && codexModelsCache?.home === home && nowMs - codexModelsCache.loadedAt < 5 * 60 * 1000) {
      return codexModelsCache.payload;
    }

    const { stdout } = await execFileAsync(codexAppServerCommand(), ["debug", "models"], {
      env: { ...environmentForCommand(codexAppServerCommand()), CODEX_HOME: home },
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024
    });
    const parsed = JSON.parse(stdout);
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    const currentConfig = await readCodexDefaultConfig();
    const payload = {
      currentModel: currentConfig.model,
      currentReasoningLevel: currentConfig.reasoningLevel,
      models: models
        .filter((model) => model?.visibility === "list" && !String(model.slug ?? "").includes("auto-review"))
        .sort((a, b) => {
          if (a.slug === currentConfig.model) {
            return -1;
          }
          if (b.slug === currentConfig.model) {
            return 1;
          }
          return Number(b.priority ?? 0) - Number(a.priority ?? 0);
        })
        .map((model) => ({
          id: model.slug,
          name: model.display_name || model.slug,
          description: model.description || "",
          defaultReasoningLevel: model.default_reasoning_level || null,
          reasoningLevels: Array.isArray(model.supported_reasoning_levels)
            ? model.supported_reasoning_levels.map((level) => level.effort).filter(Boolean)
            : [],
          serviceTiers: Array.isArray(model.service_tiers)
            ? model.service_tiers.map((tier) => ({ id: tier.id, name: tier.name || tier.id }))
            : []
        }))
        .filter((model) => model.id)
    };
    codexModelsCache = { loadedAt: nowMs, home, payload };
    return payload;
  }

  async function loadClaudeModels(options = {}) {
    const configured = claudeConnection();
    const nowMs = Date.now();
    const refresh = options.refresh === true;
    if (!refresh && claudeModelsCache && nowMs - claudeModelsCache.loadedAt < 5 * 60 * 1000) {
      return claudeModelsCache.payload;
    }

    const warm = await startup({
      options: {
        cwd: defaultWorkspacePath(),
        pathToClaudeCodeExecutable: claudeCommand(),
        env: claudeEnvironment(), settingSources: ["user"],
        tools: [], mcpServers: {}, strictMcpConfig: true, plugins: []
      },
      initializeTimeoutMs: 15_000
    });

    try {
      const models = await warm.query((async function* () {})()).supportedModels();
      const normalized = (Array.isArray(models) ? models : [])
        .map((model) => ({
          id: model.value || model.id,
          name: model.displayName || model.display_name || model.value || model.id,
          description: model.description || "",
          defaultReasoningLevel: null,
          reasoningLevels: Array.isArray(model.supportedEffortLevels)
            ? model.supportedEffortLevels.filter(Boolean)
            : [],
          serviceTiers: []
        }))
        .filter((model) => model.id);
      // A custom gateway advertises its own catalog through Claude Code discovery.
      // Discovery also prepends built-in aliases and one "Custom model" entry derived
      // from ANTHROPIC_MODEL; those are not switchable gateway ids. Keep the whole
      // list for an unconfigured provider, and never publish an empty catalog if a
      // future SDK changes the gateway marker.
      const usesCustomGateway = Boolean(configured?.endpoint)
        && configured.endpoint !== "https://api.anthropic.com";
      const advertised = usesCustomGateway
        ? normalized.filter((model) => /gateway/i.test(model.description))
        : normalized;
      const available = advertised.length ? advertised : normalized;
      const activeSession = store.listSessions({ archived: false })
        .find((session) => session.external?.provider === "claude-sdk" && session.external?.currentModel);
      // configured.model and stored session models may hold a gateway display name
      // instead of the id that setModel() accepts (e.g. "WorkBuddy Local/hy4free"
      // vs. "anthropic/claude-ccr-…"). Resolve against discovery and fail closed:
      // never publish a current model which the discovered catalog cannot resolve.
      const resolveModelId = candidate => {
        if (!candidate) return null;
        return available.find((model) => model.id === candidate)?.id
          ?? available.find((model) => model.name === candidate)?.id
          ?? null;
      };
      const payload = {
        currentModel: resolveModelId(activeSession?.external?.currentModel)
          ?? resolveModelId(configured?.model),
        currentReasoningLevel: null,
        models: available
      };
      claudeModelsCache = { loadedAt: nowMs, payload };
      return payload;
    } finally {
      warm.close();
    }
  }

  return { loadCodexModels, loadClaudeModels,
    invalidateProviderModels: id => {
      if (id === "claude-sdk") claudeModelsCache = null;
      if (id === "codex-app-server") codexModelsCache = null;
    }
  };
}
