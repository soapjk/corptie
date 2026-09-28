import { ToolBootstrapBindingPreflight } from "../../application/toolBootstrapBindingPreflight.mjs";
import { EmptyProviderBindingPreflight } from "../../application/emptyProviderBindingPreflight.mjs";
import { codexAppliedToolProofIsCurrent } from "../../application/codexToolPlanConfirmation.mjs";
import { CODEX_TOOL_SCHEMA_CAPABILITIES } from "../providers/codexAppServerProvider.mjs";
import { sessionHasActiveRun } from "../../utils/sessionPresentation.mjs";

function isUnavailableEmptyBinding(error) {
  return error?.code === "PROVIDER_SESSION_UNAVAILABLE"
    || error?.code === "PROVIDER_EMPTY_THREAD_UNRECOVERABLE";
}

export function createProviderStartupPreflights({
  store, toolHostMaterializationCoordinator, sessionRecoveryCoordinator,
  requireSessionReference, sessionApplicationService
}) {
  const toolBootstrapBindingPreflight = new ToolBootstrapBindingPreflight({
    store,
    coordinator: toolHostMaterializationCoordinator,
    isSessionBusy: (session) => sessionHasActiveRun(session),
    isAppliedProofCurrent: ({ binding, record }) => codexAppliedToolProofIsCurrent(
      binding, record, CODEX_TOOL_SCHEMA_CAPABILITIES.capabilityRevision
    ),
    maxCandidates: 32,
    concurrency: 4
  });
  const emptyCodexBindingPreflight = new EmptyProviderBindingPreflight({
    store,
    providerId: "codex-app-server",
    concurrency: 4,
    onChanged: (candidate) => store.touchSessionProjectionDependency(candidate.sessionId),
    isUnavailable: isUnavailableEmptyBinding,
    recoverUnavailable: async (candidate, error) => {
      const attempt = await sessionRecoveryCoordinator.recover({
        logicalSessionId: candidate.logicalSessionId,
        providerId: candidate.providerId,
        idempotencyKey: `startup-empty-binding-recovery:${candidate.bindingId}`,
        triggerDeliveryId: null,
        reason: error?.code ?? "provider-empty-binding-unavailable"
      });
      const reference = requireSessionReference(candidate.sessionId);
      return {
        candidate: {
          sessionId: reference.sessionId,
          logicalSessionId: reference.logicalSessionId,
          bindingId: reference.bindingId,
          providerId: reference.providerId,
          providerSessionId: reference.providerSessionId,
          routingVersion: reference.routingVersion
        },
        attemptId: attempt.attemptId ?? null
      };
    },
    ensureUsable: async (candidate) => {
      const logical = store.getLogicalSession(candidate.logicalSessionId);
      const binding = logical?.activeBinding ?? null;
      if (!binding) {
        const error = new Error("Session has no active Provider binding during startup verification.");
        error.code = "SESSION_BINDING_NOT_FOUND";
        throw error;
      }
      if (binding.bindingId !== candidate.bindingId) {
        const error = new Error("Session Provider binding changed before startup verification.");
        error.code = "SESSION_BINDING_CHANGED";
        throw error;
      }
      await sessionApplicationService.probeBindingReadiness(candidate.sessionId, {
        purpose: "startup-binding-runtime-verification",
        logicalSessionId: logical.logicalSessionId,
        providerBindingId: binding.bindingId
      });
      return { bindingId: binding.bindingId };
    }
  });
  return { toolBootstrapBindingPreflight, emptyCodexBindingPreflight };
}
