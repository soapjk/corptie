import { OpenClackyManager, mergeOpenClackyRuntimeInstructions } from "../../adapters/openClackyManager.mjs";
import { collaborationRuntimeInstructions } from "../../application/collaborationRuntimeInstructions.mjs";
import { mapOpenClackyProviderChange } from "../../application/providerEventEnvelope.mjs";

export function createOpenClackyRuntimeManager({
  configuredOpenClackyBaseURL, managedOpenClackyRuntime,
  corptieOpenClackyRuntimePaths, store, executeToolCall,
  collaborationAgentContextInstructions, sessionStateDiagnostics,
  providerEventIngestion, handleCommittedProviderTerminalLifecycle, now
}) {
  return new OpenClackyManager({
    baseURL: configuredOpenClackyBaseURL ?? managedOpenClackyRuntime.baseURL,
    accessKey: process.env.OPENCLACKY_ACCESS_KEY,
    ensureRuntime: managedOpenClackyRuntime ? () => managedOpenClackyRuntime.ensureRunning() : null,
    stopRuntime: managedOpenClackyRuntime ? () => managedOpenClackyRuntime.stop() : null,
    runtimeDirectory: corptieOpenClackyRuntimePaths.runtimeRoot,
    resolveOwnedSessionIds: () => store.listActiveProviderSessionIds("openclacky"),
    featureFlags: {
      toolHostBridge: store.settings().openclackyBridge?.toolHostBridge !== false,
      workspaceTransition: store.settings().openclackyBridge?.workspaceTransition !== false
    },
    onToolCall: executeToolCall,
    resolveSessionBootstrap: async (input) => {
      const actorId = input.toolHost?.actorId ?? input.actorId ?? null;
      const metadata = input.toolHost?.metadata ?? input.metadata ?? null;
      const agentContext = actorId ? await collaborationAgentContextInstructions(actorId, metadata) : "";
      // Preserve the recovery ReplayManifest beside ordinary Session instructions.
      const runtimeInstructions = mergeOpenClackyRuntimeInstructions(
        actorId ? collaborationRuntimeInstructions(actorId, metadata) : null,
        input.runtimeInstructions
      );
      const systemPrompt = [agentContext].filter(Boolean).join("\n\n") || null;
      return {
        body: {
          runtime_directory: corptieOpenClackyRuntimePaths.runtimeRoot,
          ...(systemPrompt ? { system_prompt_append: systemPrompt } : {}),
          ...(runtimeInstructions ? { runtime_instructions: runtimeInstructions } : {}),
          ...(metadata ? { corptie_metadata: metadata } : {})
        },
        summary: {
          hasSystemPrompt: Boolean(systemPrompt),
          hasRuntimeInstructions: Boolean(runtimeInstructions),
          runtimeDirectory: corptieOpenClackyRuntimePaths.runtimeRoot,
          scope: metadata ?? null
        }
      };
    },
    onSessionChanged: (change) => {
      const sessionId = change.session?.id
        ?? (change.sessionId ? `openclacky:${String(change.sessionId).replace(/^openclacky:/, "")}` : null);
      const providerEvent = change.event ?? null;
      const providerEventType = String(providerEvent?.type ?? "");
      if (sessionId) {
        sessionStateDiagnostics.record(sessionId, "providerReceived", {
          providerId: "openclacky",
          turnId: providerEvent?.turn_id ?? null,
          eventName: providerEventType || change.type || "session-changed"
        });
      }
      try {
        const logical = sessionId ? store.getLogicalSessionByLegacySessionId(sessionId) : null;
        const physicalSessionId = String(providerEvent?.session_id ?? change.sessionId ?? sessionId ?? "")
          .replace(/^openclacky:/, "");
        const providerBinding = physicalSessionId
          ? store.getAgentSessionBindingByProviderSession("openclacky", physicalSessionId)
          : null;
        if (providerEvent) {
          const envelopeBinding = providerBinding ?? {
            bindingId: `unresolved:openclacky:${physicalSessionId || "unknown"}`,
            providerId: "openclacky",
            providerSessionId: physicalSessionId || "unknown",
            logicalSessionId: logical?.logicalSessionId ?? null,
            routingVersion: Number(logical?.routingVersion ?? 1)
          };
          const envelope = mapOpenClackyProviderChange({
            change, binding: envelopeBinding, receivedAt: now()
          });
          if (envelope) {
            const ingestion = providerEventIngestion.ingest(envelope);
            if (ingestion.status === "applied") {
              handleCommittedProviderTerminalLifecycle({
                event: ingestion.event,
                projection: ingestion.projection,
                logicalRoute: logical
              });
            }
            if (sessionId && providerEventType === "task_finished") {
              sessionStateDiagnostics.record(sessionId, "persisted", {
                status: store.getSession(sessionId)?.status ?? null,
                eventName: providerEventType
              });
            }
            if (ingestion.status === "quarantined" && sessionId) {
              sessionStateDiagnostics.record(sessionId, "providerEventQuarantined", {
                eventName: providerEventType,
                code: ingestion.code,
                bindingId: envelope.bindingId
              });
            }
            return;
          }
        }
        // Command-result callbacks are not product-state events. Only real-time
        // Provider events may project execution or Timeline state here.
        if (!providerEvent) return;
      } catch (error) {
        console.error(`[provider-notification] isolated failure provider=openclacky session=${sessionId ?? "unknown"} event=${providerEventType || change.type || "unknown"} code=${error?.code ?? "unknown"} error=${error?.message ?? error}`);
        if (sessionId) {
          sessionStateDiagnostics.record(sessionId, "providerError", {
            eventName: providerEventType || change.type || "unknown",
            code: error?.code ?? null,
            error: error?.message ?? String(error)
          });
          const physicalSessionId = String(providerEvent?.session_id ?? change.sessionId ?? sessionId)
            .replace(/^openclacky:/, "");
          const binding = store.getAgentSessionBindingByProviderSession("openclacky", physicalSessionId);
          if (binding) store.markProviderBindingCursorDegraded(binding, now());
        }
      }
    }
  });
}
