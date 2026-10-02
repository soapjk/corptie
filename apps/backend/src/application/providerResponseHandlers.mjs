// Watchdog policy bridges timers to the same durable Provider event path used
// by normal execution. Terminal projection precedes best-effort interruption.
export function createProviderResponseHandlers({
  store, providerEventIngestion, sessionApplicationService,
  handleCommittedProviderTerminalLifecycle, now
}) {
  function providerResponseWatchdogEnvelope(entry, { type, error, items = undefined, willRetry = undefined }) {
    const timestamp = now();
    return {
      schemaVersion: 1,
      providerId: entry.providerId,
      providerSessionId: entry.providerSessionId,
      bindingId: entry.bindingId,
      logicalSessionId: entry.logicalSessionId,
      routingVersion: entry.routingVersion,
      providerEventId: `corptie:provider-response-watchdog:${type}:${entry.turnId}`,
      providerSequence: null,
      turnId: entry.turnId,
      type,
      occurredAt: timestamp,
      receivedAt: timestamp,
      payload: {
        nativeType: `corptie.provider_response_watchdog.${type}`,
        error,
        failureScope: "turn",
        ...(willRetry == null ? {} : { willRetry }),
        ...(items ? { items } : {})
      },
      rawPayload: { source: "provider_response_watchdog" }
    };
  }

  function handleProviderResponseDelayed(entry) {
    const turn = store.getSessionTurn(entry.sessionId, entry.bindingId, entry.turnId);
    if (!turn || !["running", "blocked"].includes(turn.execution_status)) return;
    providerEventIngestion.ingest(providerResponseWatchdogEnvelope(entry, {
      type: "provider.error",
      error: {
        code: "PROVIDER_RESPONSE_DELAYED",
        message: "模型服务暂未返回任何执行信息，仍在等待；如果持续无响应，本次执行会自动结束。",
        retryable: true
      },
      willRetry: true
    }));
  }

  async function handleProviderResponseTimeout(entry) {
    const turn = store.getSessionTurn(entry.sessionId, entry.bindingId, entry.turnId);
    if (!turn || !["running", "blocked"].includes(turn.execution_status)) return;
    const timestamp = now();
    const absolute = entry.timeoutKind === "absolute";
    const hadActivity = Boolean(entry.lastActivityAt);
    const code = absolute ? "PROVIDER_TURN_DEADLINE_EXCEEDED"
      : hadActivity ? "PROVIDER_STREAM_IDLE_TIMEOUT"
        : "PROVIDER_FIRST_ACTIVITY_TIMEOUT";
    const message = absolute
      ? "模型执行超过允许的最长时间，本次执行已自动结束；您可以重试或切换模型。"
      : hadActivity
        ? "模型流式连接长时间没有新数据，本次执行已自动结束；您可以重试或切换模型。"
        : "模型服务长时间未返回任何执行信息。本次执行已自动结束；您可以重试或切换模型。";
    const ingestion = providerEventIngestion.ingest(providerResponseWatchdogEnvelope(entry, {
      type: "turn.failed",
      error: { code, message, retryable: true },
      items: [{
        id: `provider-response-timeout:${entry.bindingId}:${entry.turnId}`,
        turnId: entry.turnId,
        turnStatus: "failed",
        type: "system",
        title: absolute ? "模型执行超时" : hadActivity ? "模型流中断" : "模型响应超时",
        text: message,
        status: "failed",
        createdAt: timestamp
      }]
    }));
    if (ingestion.status !== "applied") return;

    const logicalRoute = entry.logicalSessionId
      ? store.getLogicalSession(entry.logicalSessionId)
      : null;
    handleCommittedProviderTerminalLifecycle({
      event: ingestion.event,
      projection: ingestion.projection,
      logicalRoute
    });

    try {
      await sessionApplicationService.interrupt(entry.sessionId, {
        summary: {
          ...store.getSession(entry.sessionId),
          external: {
            ...(store.getSession(entry.sessionId)?.external ?? {}),
            activeTurnId: entry.turnId
          }
        },
        source: { type: "system", reason: "provider_response_timeout" }
      });
    } catch (error) {
      console.warn(`[provider-response-watchdog] Provider interrupt failed session=${entry.sessionId} turn=${entry.turnId} code=${error?.code ?? "UNKNOWN"}`);
    }
  }

  return { handleProviderResponseDelayed, handleProviderResponseTimeout };
}
