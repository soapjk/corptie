import { ClaudeAgentManager } from "../../adapters/claudeAgentManager.mjs";
import { createClaudeAgentSdkProvider } from "../providers/claudeAgentSdkProvider.mjs";

export function createClaudeProviderRuntime(options = {}) {
  if (!options.store) throw new TypeError("Claude Provider bootstrap requires a store.");
  const manager = new ClaudeAgentManager({
    store: options.store,
    onTurnSettled: options.onTurnSettled,
    onProviderEvent: options.onProviderEvent,
    resolveRuntimeOptions: options.resolveRuntimeOptions
  });
  const provider = createClaudeAgentSdkProvider(manager, {
    prepareSessionInput: options.prepareSessionInput,
    listModels: options.listModels,
    prepareWorkspaceTransition: options.prepareWorkspaceTransition,
    attachTools: options.attachTools
  });
  provider.manager = manager;
  return provider;
}
