import { readFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { hasCodexSessionPermissions, withCodexSessionPermissions } from "../utils/codexPermissions.mjs";
import { hasCodexSessionRuntimeConfig, withCodexSessionRuntimeConfig } from "../utils/codexRuntimeConfig.mjs";
import { normalizeNewSessionDefaults, resolveNewCodexRuntimeConfig } from "../utils/newSessionDefaults.mjs";

export function codexAppServerSessionCapabilities(overrides = {}) {
  return {
    canSend: true,
    canSwitchModel: true,
    canSwitchReasoning: true,
    canInterrupt: true,
    canReconnect: false,
    canPrepareExecution: true,
    ...overrides
  };
}

export async function readCodexDefaultConfig() {
  const config = await readFile(join(os.homedir(), ".codex", "config.toml"), "utf8").catch(() => "");
  const modelMatch = config.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
  const reasoningMatch = config.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m);
  return {
    model: modelMatch?.[1] ?? null,
    reasoningLevel: reasoningMatch?.[1] ?? null
  };
}

export function createCodexSessionConfiguration({ store, upsertManagedCodexSession, loadCodexModels }) {
  async function ensureCodexSessionPermissions(session) {
    if (!session) return session;
    const needsPermissions = !hasCodexSessionPermissions(session);
    const needsRuntimeConfig = !hasCodexSessionRuntimeConfig(session);
    if (!needsPermissions && !needsRuntimeConfig) return session;

    // Complete missing product configuration from Corptie defaults only.
    const defaults = normalizeNewSessionDefaults(store.settings().newSessionDefaults);
    const withPermissions = needsPermissions
      ? withCodexSessionPermissions(session, defaults)
      : session;
    const next = needsRuntimeConfig
      ? withCodexSessionRuntimeConfig(withPermissions, {
          model: defaults.codexModel,
          reasoningLevel: defaults.codexReasoningLevel
        })
      : withPermissions;
    if (session.id) upsertManagedCodexSession(next);
    return next;
  }

  async function resolvedNewCodexRuntimeConfig(input = {}) {
    const [currentConfig, modelPayload] = await Promise.all([
      readCodexDefaultConfig(),
      loadCodexModels().catch(() => ({ models: [] }))
    ]);
    return resolveNewCodexRuntimeConfig({
      request: input,
      defaults: store.settings().newSessionDefaults,
      currentConfig,
      models: modelPayload.models
    });
  }

  return { ensureCodexSessionPermissions, resolvedNewCodexRuntimeConfig };
}
