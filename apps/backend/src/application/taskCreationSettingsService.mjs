import { AGENT_PROVIDER_CAPABILITIES as C } from "../agent-provider/contracts.mjs";
import { normalizeTaskCreationDefaults } from "../utils/newSessionDefaults.mjs";

/** Shared product settings. No native configuration, paths, credentials or Provider envelopes. */
export class TaskCreationSettingsService {
  constructor({ store, registry, sessions, readOnly = false }) { Object.assign(this, { store, registry, sessions, readOnly }); }

  async read(providerId = null) {
    const value = normalizeTaskCreationDefaults(this.store.settings().newSessionDefaults?.taskCreation);
    const providers = this.registry.descriptors().map(row => ({ id: row.id, name: row.displayName,
      available: [C.SESSION_CREATE, C.SESSION_RESUME, C.CONVERSATION_SEND]
        .every(capability => this.registry.supports(row.id, capability)),
      supportsModels: this.registry.supports(row.id, C.MODEL_LIST),
      supportsReasoning: this.registry.supports(row.id, C.REASONING_SWITCH) }));
    const selectedProviderId = providerId ?? value.providerId ?? this.registry.defaultProviderId;
    const selected = providers.find(row => row.id === selectedProviderId);
    let catalog = {}, modelError = null;
    if (!this.readOnly && selected?.available && selected.supportsModels) {
      try { catalog = await this.sessions.listModels(selectedProviderId); }
      catch { modelError = "MODEL_CATALOG_UNAVAILABLE"; }
    }
    return { schemaVersion: 1, value, readOnly: this.readOnly, defaultProviderId: this.registry.defaultProviderId,
      selectedProviderId, providers, modelError,
      models: (catalog.models ?? []).filter(row => typeof row.id === "string").map(row => ({
        id: row.id, name: typeof row.name === "string" ? row.name : row.id,
        reasoningLevels: Array.isArray(row.reasoningLevels) ? row.reasoningLevels.filter(level => typeof level === "string") : [],
        defaultReasoningLevel: typeof row.defaultReasoningLevel === "string" ? row.defaultReasoningLevel : null })),
      currentModel: catalog.currentModel ?? null, currentReasoningLevel: catalog.currentReasoningLevel ?? null };
  }

  async validate(input) {
    if (this.readOnly) throw Object.assign(invalid("DEVELOPMENT_PREVIEW_READ_ONLY"), { statusCode: 403, status: 403 });
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(key => !["providerId", "model", "reasoningLevel"].includes(key))
        || Object.values(input).some(value => value !== null && (typeof value !== "string" || value.length > 512))) {
      throw invalid("INVALID_TASK_DEFAULTS");
    }
    const value = normalizeTaskCreationDefaults(input);
    if (!value.providerId && (value.model || value.reasoningLevel)) throw invalid("PROVIDER_REQUIRED");
    const catalog = await this.read(value.providerId ?? this.registry.defaultProviderId);
    const provider = catalog.providers.find(row => row.id === catalog.selectedProviderId);
    if (!provider?.available) throw invalid("PROVIDER_CAPABILITY_UNAVAILABLE");
    if (value.model) {
      const model = catalog.models.find(row => row.id === value.model);
      if (!model) throw invalid(catalog.modelError ?? "MODEL_UNAVAILABLE");
      if (value.reasoningLevel && (!provider.supportsReasoning || !model.reasoningLevels.includes(value.reasoningLevel))) {
        throw invalid("REASONING_UNAVAILABLE");
      }
    } else if (value.reasoningLevel) throw invalid("MODEL_REQUIRED");
    return value;
  }

  async save(input, revalidate = null) {
    const value = await this.validate(input);
    revalidate?.();
    await this.store.updateSettings({ newSessionDefaults: { taskCreation: value } });
    return this.read(value.providerId);
  }
}

function invalid(code) { return Object.assign(new Error(code), { code, statusCode: 400, status: 400 }); }
