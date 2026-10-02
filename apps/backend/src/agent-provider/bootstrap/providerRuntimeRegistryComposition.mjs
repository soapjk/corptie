import { createAgentProviderRuntimeRegistry } from "./agentProviderBootstrap.mjs";
import { createOpenClackyProvider } from "../providers/openClackyProvider.mjs";
import { persistedProviderWorkspaceProof } from "../providerWorkspaceBindingService.mjs";
import { confirmOrRestoreCodexToolPlan } from "../../application/codexToolPlanConfirmation.mjs";
import { appliedToolMaterializationReceipt } from "../toolSchemaCapabilities.mjs";

export function createProviderRuntimeRegistryComposition({
  store, claudeProviderRuntime, codexRuntime, openClackyManager,
  openClackyToolHostAttachment, applyOpenClackyToolPlanAtTurnBoundary,
  switchOpenClackyProviderWorkspace, prepareCodexProviderSessionInput,
  createCodexProviderSession, forkCodexSession, resumeCodexProviderSession,
  probeCodexProviderBinding, prepareCodexProviderExecution,
  stabilizeCodexRecoverySession, deleteCodexProviderSession,
  restartCodexProviderSession, renameCodexProviderSession, loadCodexModels,
  sendCodexProviderMessage, clearCodexAppServerSession,
  interruptCodexProviderSession, respondCodexProviderApproval,
  respondCodexProviderUserInput, manageCodexTurnChanges,
  updateCodexProviderConfiguration, updateCodexProviderPermissions,
  readCodexProviderAccountUsage, readCodexProviderSessionUsage,
  switchCodexProviderWorkspace, codexToolHostAttachment,
  withWorkChatCodexContext, collaborationProviderRuntimeOptionsWithAgentContext
}) {
  const openClackyProvider = createOpenClackyProvider(openClackyManager, {
    attachTools: async (attachment) => openClackyToolHostAttachment(attachment),
    applyToolPlanAtTurnBoundary: applyOpenClackyToolPlanAtTurnBoundary,
    prepareWorkspaceTransition: (reference, input = {}) => switchOpenClackyProviderWorkspace(reference, input),
    readSessionUsage: async (reference) => store.getSessionContextUsage(reference.sessionId)?.context ?? null,
    bindWorkspace: (input) => persistedProviderWorkspaceProof(store, input),
    inspectWorkspaceBinding: (input) => persistedProviderWorkspaceProof(store, input)
  });
  return createAgentProviderRuntimeRegistry({
    claudeProvider: claudeProviderRuntime,
    codexOperations: {
      prepareSessionInput: prepareCodexProviderSessionInput,
      createSession: createCodexProviderSession,
      forkSession: forkCodexSession,
      resumeSession: resumeCodexProviderSession,
      probeBinding: probeCodexProviderBinding,
      prepareExecution: prepareCodexProviderExecution,
      stabilizeRecoverySession: stabilizeCodexRecoverySession,
      deleteSession: deleteCodexProviderSession,
      disconnectSession: (reference) => codexRuntime.archiveThread(reference.providerSessionId),
      restartSession: restartCodexProviderSession,
      renameSession: renameCodexProviderSession,
      listModels: loadCodexModels,
      send: sendCodexProviderMessage,
      executeCommand: (reference, command) => codexRuntime.executeCommand(reference.providerSessionId, command),
      clearConversation: (reference, context = {}) => clearCodexAppServerSession(
        reference.sessionId, reference.metadata.session, context.source
      ),
      interrupt: interruptCodexProviderSession,
      respondToApproval: respondCodexProviderApproval,
      respondToUserInput: respondCodexProviderUserInput,
      manageTurnChanges: manageCodexTurnChanges,
      switchModel: (reference, model) => updateCodexProviderConfiguration(reference, { currentModel: model }),
      switchReasoning: (reference, reasoningLevel) => updateCodexProviderConfiguration(reference, { currentReasoningLevel: reasoningLevel }),
      updatePermissions: updateCodexProviderPermissions,
      readAccountUsage: readCodexProviderAccountUsage,
      readSessionUsage: readCodexProviderSessionUsage,
      prepareWorkspaceTransition: switchCodexProviderWorkspace,
      bindWorkspace: (input) => persistedProviderWorkspaceProof(store, input),
      inspectWorkspaceBinding: (input) => persistedProviderWorkspaceProof(store, input),
      attachTools: async (attachment) => codexToolHostAttachment(
        attachment,
        withWorkChatCodexContext(
          await collaborationProviderRuntimeOptionsWithAgentContext(
            attachment.actorId, attachment.metadata
          ),
          attachment.metadata
        )
      ),
      applyToolPlanAtTurnBoundary: async (binding, plan, request) => {
        const confirmation = confirmOrRestoreCodexToolPlan({
          runtime: codexRuntime, store, binding, plan, request
        });
        return appliedToolMaterializationReceipt({
          providerBindingId: binding.providerBindingId,
          providerCapabilityRevision: request.capabilityRevision,
          requestedVersion: request.requestedVersion,
          appliedCatalogVersion: request.catalogVersion,
          appliedDomains: request.appliedDomains,
          appliedExposurePlanHash: plan.exposurePlanHash,
          providerDefinitionsHash: confirmation.providerDefinitionsHash,
          providerContractHash: confirmation.providerContractHash ?? plan.providerContractHash,
          providerDefinitionsCount: confirmation.providerDefinitionsCount,
          providerObservationKind: confirmation.providerObservationKind,
          refreshMode: plan.refreshMode,
          providerRevision: confirmation.providerRevision,
          receiptId: `codex-tool-confirmation:${binding.providerBindingId}:${request.requestedVersion}`
        });
      },
      runBackgroundPrompt: (input) => codexRuntime.runEphemeralPrompt({
        cwd: input.cwd,
        runtimeWorkspaceRoots: input.allowedRoots,
        prompt: input.prompt,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        executionPolicy: input.executionPolicy,
        outputSchema: input.outputSchema,
        permissionProfile: input.permissionProfile,
        developerInstructions: input.developerInstructions,
        threadSource: input.purpose
      })
    },
    codexMetadata: { backgroundPermissionProfiles: ["read-only", "workspace-write"] },
    additionalProviders: [openClackyProvider]
  });
}
