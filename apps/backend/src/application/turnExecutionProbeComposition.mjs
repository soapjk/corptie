import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";
import { TurnExecutionProbeScheduler } from "./turnExecutionProbeScheduler.mjs";

export function createTurnExecutionProbe({ store, registry, bindings, ingestion, onTerminal, onRunning = () => {}, now, enabled = true }) {
  const isCurrent = entry => {
    try {
      const reference = bindings.resolve(entry.sessionId);
      const turn = store.getSessionTurn(entry.sessionId, entry.bindingId, entry.turnId);
      const session = store.getSession(entry.sessionId);
      return reference?.bindingId === entry.bindingId && reference.routingVersion === entry.routingVersion
        && reference.providerSessionId === entry.providerSessionId
        && ["running", "blocked"].includes(turn?.execution_status)
        && session?.external?.activeTurnId === entry.turnId;
    } catch { return false; }
  };
  return new TurnExecutionProbeScheduler({
    supports: providerId => enabled && registry.get(providerId).descriptor.capabilities.includes(AGENT_PROVIDER_CAPABILITIES.TURN_EXECUTION_PROBE),
    isCurrent,
    probe: entry => registry.invoke(entry.providerId, AGENT_PROVIDER_CAPABILITIES.TURN_EXECUTION_PROBE,
      bindings.resolve(entry.sessionId), entry.turnId),
    onResult: (entry, result) => {
      if (!isCurrent(entry)) return;
      console.info(`[turn-probe] session=${entry.sessionId} binding=${entry.bindingId} turn=${entry.turnId} state=${result.state} code=${result.reasonCode} confirmed=${result.confirmed}`);
      if (result.state === "running") onRunning(entry);
      const terminal = result.state === "terminal" && ["completed", "failed", "cancelled"].includes(result.terminalStatus);
      const absent = result.state === "absent" && result.confirmed;
      if (!terminal && !absent) return;
      // Unknown outcome is never promoted to success or replayed automatically.
      const status = terminal ? result.terminalStatus : "failed";
      const timestamp = now();
      const event = { schemaVersion: 1, providerId: entry.providerId,
        providerSessionId: entry.providerSessionId, bindingId: entry.bindingId,
        logicalSessionId: entry.logicalSessionId, routingVersion: entry.routingVersion,
        providerEventId: `corptie:turn-probe:${entry.bindingId}:${entry.turnId}:${status}`,
        providerSequence: null, turnId: entry.turnId, type: `turn.${status}`,
        occurredAt: timestamp, receivedAt: timestamp,
        payload: { nativeType: "corptie.turn_execution_probe", status,
          executionProbe: { schemaVersion: 1, state: result.state, source: result.source,
            observedAt: result.observedAt ?? timestamp, reasonCode: result.reasonCode },
          suppressAutomaticContinuation: true,
          ...(status === "failed" ? { error: { code: absent ? "PROVIDER_EXECUTION_OUTCOME_UNKNOWN" : "PROVIDER_TURN_FAILED",
            message: absent ? "Provider 已确认无活动轮次；本轮原始结束结果未恢复。请先核对操作结果，不要直接重复执行。" : "Provider 查询确认本轮执行失败。" } } : {}) },
        rawPayload: { source: "turn_execution_probe" } };
      const receipt = ingestion.ingest(event);
      if (receipt.status === "applied") onTerminal({ event: receipt.event, projection: receipt.projection,
        logicalRoute: store.getLogicalSession(entry.logicalSessionId) });
    }
  });
}
