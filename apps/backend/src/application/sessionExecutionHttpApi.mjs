export function handleSessionRecoveryHttpRequest({
  request, response, url, store, requireSessionReference, sessionRecoveryCoordinator,
  readJson, sendJson, errorStatus
}) {
  const sessionRecoveryMatch = url.pathname.match(/^\/sessions\/([^/]+)\/recovery$/);
  const sessionRecoveryCancelMatch = url.pathname.match(/^\/session-recovery\/([^/]+)\/cancel$/);
  if (request.method === "GET" && sessionRecoveryMatch) {
    try {
      const reference = requireSessionReference(decodeURIComponent(sessionRecoveryMatch[1]));
      if (!reference.logicalSessionId) throw Object.assign(new Error("Logical Session recovery is unavailable."), { code: "LOGICAL_SESSION_REQUIRED" });
      sendJson(response, 200, {
        attempts: store.listSessionRecoveryAttempts(reference.logicalSessionId),
        limitations: [
          "Provider hidden reasoning and KV cache are not recoverable.",
          "Provider-private compression and undisclosed state are not recoverable.",
          "Unpersisted events and uncertain in-flight operations are not recoverable.",
          "Provider-only attachments without a Corptie-local copy are not recoverable."
        ]
      });
    } catch (error) {
      sendJson(response, errorStatus(error, 409), { error: error.message, code: error.code ?? "SESSION_RECOVERY_READ_FAILED" });
    }
    return true;
  }
  if (request.method === "POST" && sessionRecoveryMatch) {
    readJson(request).then(async (input) => {
      const unknown = Object.keys(input).filter((field) => !["idempotencyKey", "reason"].includes(field));
      if (unknown.length > 0) throw Object.assign(new Error("Recovery request contains unknown fields."), { code: "RECOVERY_UNKNOWN_FIELD" });
      const reference = requireSessionReference(decodeURIComponent(sessionRecoveryMatch[1]));
      if (!reference.logicalSessionId) throw Object.assign(new Error("Logical Session recovery is unavailable."), { code: "LOGICAL_SESSION_REQUIRED" });
      return sessionRecoveryCoordinator.recover({
        logicalSessionId: reference.logicalSessionId,
        providerId: reference.providerId,
        idempotencyKey: String(input.idempotencyKey ?? "").trim(),
        reason: String(input.reason ?? "manual-provider-session-recovery").trim()
      });
    }).then((attempt) => sendJson(response, attempt.state === "committed" ? 200 : 409, { attempt }))
      .catch((error) => sendJson(response, errorStatus(error, 409), { error: error.message, code: error.code ?? "SESSION_RECOVERY_FAILED" }));
    return true;
  }
  if (request.method === "POST" && sessionRecoveryCancelMatch) {
    sessionRecoveryCoordinator.cancel(decodeURIComponent(sessionRecoveryCancelMatch[1]))
      .then((attempt) => sendJson(response, attempt ? 200 : 404, { attempt }))
      .catch((error) => sendJson(response, errorStatus(error, 409), { error: error.message, code: error.code ?? "SESSION_RECOVERY_CANCEL_FAILED" }));
    return true;
  }

  return false;
}

export function handleSessionExecutionHttpRequest({
  request, response, url, sessionApplicationService, sessionBindingReadinessProbe,
  sendJson, unifiedErrorStatus
}) {
  const sessionExecutionPreparationMatch = url.pathname.match(/^\/sessions\/([^/]+)\/actions\/prepare-execution$/);
  if (request.method === "POST" && sessionExecutionPreparationMatch) {
    const rawId = decodeURIComponent(sessionExecutionPreparationMatch[1]);
    sessionApplicationService.prepareExecution(rawId, { source: "http-session-selection" })
      .then((preparation) => sendJson(response, 200, { preparation }))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), {
        error: error.message,
        code: error.code ?? null
      }));
    return true;
  }

  const sessionBindingProbeMatch = url.pathname.match(/^\/sessions\/([^/]+)\/actions\/probe-binding$/);
  if (request.method === "POST" && sessionBindingProbeMatch) {
    const rawId = decodeURIComponent(sessionBindingProbeMatch[1]);
    sessionBindingReadinessProbe.verify(rawId)
      .then((verification) => sendJson(response, 200, { verification }))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), {
        error: error.message,
        code: error.code ?? null
      }));
    return true;
  }

  const sessionResumeMatch = url.pathname.match(/^\/sessions\/([^/]+)\/actions\/resume$/);
  if (request.method === "POST" && sessionResumeMatch) {
    const rawId = decodeURIComponent(sessionResumeMatch[1]);
    sessionApplicationService.resumeSession(rawId, { source: "http" })
      .then((session) => sendJson(response, 200, { session }))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code ?? null }));
    return true;
  }

  const ptyDisconnectMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)\/disconnect$/);
  if (request.method === "POST" && ptyDisconnectMatch) {
    const sessionId = decodeURIComponent(ptyDisconnectMatch[1]);
    sessionApplicationService.disconnectSession(sessionId, { source: "legacy-http" })
      .then((session) => sendJson(response, 200, { session }))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), {
        error: error.message,
        code: error.code ?? null
      }));
    return true;
  }

  const ptyReconnectMatch = url.pathname.match(/^\/pty\/sessions\/([^/]+)\/reconnect$/);
  if (request.method === "POST" && ptyReconnectMatch) {
    const sessionId = decodeURIComponent(ptyReconnectMatch[1]);
    sessionApplicationService.resumeSession(sessionId, { source: "legacy-http" })
      .then((session) => sendJson(response, 200, { session }))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), {
        error: error.message,
        code: error.code ?? null
      }));
    return true;
  }

  return false;
}
