import { ClaudeAgentManager } from "../../adapters/claudeAgentManager.mjs";
import { createClaudeAgentSdkProvider } from "../providers/claudeAgentSdkProvider.mjs";

export function createClaudeProviderRuntime(options = {}) {
  if (!options.store) throw new TypeError("Claude Provider bootstrap requires a store.");
  const manager = new ClaudeAgentManager({ store: options.store });
  return createClaudeAgentSdkProvider(manager, { listModels: options.listModels });
}
