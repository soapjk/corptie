import { startup as startClaudeRuntime } from "@anthropic-ai/claude-agent-sdk";

// Provider-specific discovery caches. The registry exposes their common model
// catalog contract; neither cache is shared with ordinary Session transcripts.
export function createProviderModelCatalogLoaders({
  store, codexAppServerCommand, corptieCodexRuntimePaths, environmentForCommand,
  execFileAsync, readCodexDefaultConfig, defaultWorkspacePath, claudeCommand,
  startup = startClaudeRuntime
}) {
  let codexModelsCache = null;
  let claudeModelsCache = null;

  async function loadCodexModels(options = {}) {
    const nowMs = Date.now();
    const refresh = options.refresh === true;
    if (!refresh && codexModelsCache && nowMs - codexModelsCache.loadedAt < 5 * 60 * 1000) {
      return codexModelsCache.payload;
    }

    const { stdout } = await execFileAsync(codexAppServerCommand(), ["debug", "models"], {
      env: { ...environmentForCommand(codexAppServerCommand()), CODEX_HOME: corptieCodexRuntimePaths.codexHome },
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
    codexModelsCache = { loadedAt: nowMs, payload };
    return payload;
  }

  async function loadClaudeModels(options = {}) {
    const nowMs = Date.now();
    const refresh = options.refresh === true;
    if (!refresh && claudeModelsCache && nowMs - claudeModelsCache.loadedAt < 5 * 60 * 1000) {
      return claudeModelsCache.payload;
    }

    const warm = await startup({
      options: {
        cwd: defaultWorkspacePath(),
        pathToClaudeCodeExecutable: claudeCommand()
      },
      initializeTimeoutMs: 15_000
    });

    try {
      const models = await warm.query((async function* () {})()).supportedModels();
      const activeSession = store.listSessions({ archived: false })
        .find((session) => session.external?.provider === "claude-sdk" && session.external?.currentModel);
      const payload = {
        currentModel: activeSession?.external?.currentModel ?? null,
        currentReasoningLevel: null,
        models: (Array.isArray(models) ? models : [])
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
          .filter((model) => model.id)
      };
      claudeModelsCache = { loadedAt: nowMs, payload };
      return payload;
    } finally {
      warm.close();
    }
  }

  return { loadCodexModels, loadClaudeModels };
}
