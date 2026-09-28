export function createSessionProviderAttachments({
  store, collaborationCore, ensureCollaborationAgentForSession,
  sessionToolMetadata, toolHostService, workChatContextService
}) {
  async function claudeRuntimeOptionsForSession(providerSessionId) {
    let agent = collaborationCore.getAgentForSession(providerSessionId);
    if (!agent) {
      agent = ensureCollaborationAgentForSession(store.getSession(providerSessionId));
    }
    const session = store.getSession(providerSessionId);
    const metadata = sessionToolMetadata(session);
    if (!agent) return {};
    return (await toolHostService.prepareSession("claude-sdk", {
      actorId: agent.agentId,
      ...metadata
    }))?.providerAttachment ?? {};
  }

  async function collaborationThreadOptionsForSession(sessionId, options = {}) {
    if (!sessionId) return {};
    const session = store.getSession(sessionId);
    const agent = collaborationCore.getAgentForSession(sessionId)
      ?? ensureCollaborationAgentForSession(session);
    if (!agent?.agentId) return {};
    const metadata = sessionToolMetadata(session);
    if (options.prospectiveBinding === true) {
      const logical = metadata.logicalSessionId
        ? store.getLogicalSession(metadata.logicalSessionId)
        : null;
      const current = logical?.activeBinding?.bindingId
        ? store.getSessionToolCatalogMaterialization(
            logical.logicalSessionId,
            logical.activeBinding.bindingId
          )
        : null;
      delete metadata.providerBindingId;
      metadata.purpose = options.purpose ?? "session-recovery";
      if (current) {
        metadata.desiredToolDomains = current.desiredDomains
          .map((domain) => domain?.domainId)
          .filter(Boolean);
      }
    }
    const prepared = await toolHostService.prepareSession("codex-app-server", {
      actorId: agent.agentId,
      ...metadata
    });
    const attachment = prepared?.providerAttachment ?? {};
    const receipt = prepared?.materialization?.record?.providerReceipt ?? null;
    if (!receipt?.providerRevision
      || !receipt?.providerDefinitionsHash
      || !Number.isSafeInteger(receipt?.providerDefinitionsCount)
      || !receipt?.providerObservationKind) return attachment;
    return {
      ...attachment,
      dynamicToolConfirmation: {
        providerRevision: receipt.providerRevision,
        providerDefinitionsHash: receipt.providerDefinitionsHash,
        providerContractHash: receipt.providerContractHash,
        providerDefinitionsCount: receipt.providerDefinitionsCount,
        providerObservationKind: receipt.providerObservationKind
      }
    };
  }

  function withPersistedCodexToolConfirmation(reference, attachment = {}) {
    const logicalSessionId = reference?.logicalSessionId
      ?? reference?.metadata?.session?.external?.logicalSessionId
      ?? null;
    const providerBindingId = reference?.bindingId ?? reference?.providerBindingId ?? null;
    if (!logicalSessionId || !providerBindingId) return attachment;
    const record = store.getSessionToolCatalogMaterialization(logicalSessionId, providerBindingId);
    const receipt = record?.providerReceipt ?? null;
    if (!receipt?.providerRevision
      || !receipt?.providerDefinitionsHash
      || !Number.isSafeInteger(receipt?.providerDefinitionsCount)
      || !receipt?.providerObservationKind) return attachment;
    return {
      ...attachment,
      dynamicToolConfirmation: {
        providerRevision: receipt.providerRevision,
        providerDefinitionsHash: receipt.providerDefinitionsHash,
        providerContractHash: receipt.providerContractHash,
        providerDefinitionsCount: receipt.providerDefinitionsCount,
        providerObservationKind: receipt.providerObservationKind
      }
    };
  }

  function workChatInstructions(metadata) {
    return metadata?.sessionKind === "workChat" && metadata?.workId
      ? workChatContextService.build(metadata.workId, metadata.sessionId ? store.getSession(metadata.sessionId) : null).prompt
      : "";
  }

  function withWorkChatCodexContext(options, metadata) {
    const context = workChatInstructions(metadata);
    if (!context) return options;
    return {
      ...options,
      developerInstructions: [options?.developerInstructions, context].filter(Boolean).join("\n\n")
    };
  }

  function withWorkChatClaudeContext(options, metadata) {
    const context = workChatInstructions(metadata);
    if (!context) return options;
    const systemPrompt = options?.systemPrompt ?? { type: "preset", preset: "claude_code", append: "" };
    return {
      ...options,
      systemPrompt: {
        ...systemPrompt,
        append: [systemPrompt.append, context].filter(Boolean).join("\n\n")
      }
    };
  }

  return Object.freeze({
    claudeRuntimeOptionsForSession, collaborationThreadOptionsForSession,
    withPersistedCodexToolConfirmation, withWorkChatCodexContext, withWorkChatClaudeContext
  });
}
