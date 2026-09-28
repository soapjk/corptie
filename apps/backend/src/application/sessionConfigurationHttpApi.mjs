// Normalizers preserve the existing transport vocabulary; execution remains
// capability-based through the shared SessionApplicationService.
export function handleSessionConfigurationHttpRequest({
  request, response, url, sessionApplicationService, requireSessionReference,
  normalizeSandbox, normalizeApprovalPolicy, emitEvent,
  readJson, sendJson, unifiedErrorStatus
}) {
  const sessionModelMatch = url.pathname.match(/^\/sessions\/([^/]+)\/model$/);
  if (request.method === "POST" && sessionModelMatch) {
    const sessionId = decodeURIComponent(sessionModelMatch[1]);
    readJson(request)
      .then(async (input) => {
        const model = typeof input.model === "string" ? input.model.trim() : "";
        if (!model) {
          sendJson(response, 400, { error: "Model is required" });
          return;
        }
        const reference = requireSessionReference(sessionId);
        const session = await sessionApplicationService.switchModel(sessionId, model);
        emitEvent("SessionModelChanged", {
          sessionId: reference.sessionId,
          logicalSessionId: reference.logicalSessionId,
          model
        }, { sessionId: reference.sessionId });
        sendJson(response, 202, { session, model });
      })
      .catch((error) => {
        sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code });
      });
    return true;
  }

  const sessionReasoningMatch = url.pathname.match(/^\/sessions\/([^/]+)\/reasoning$/);
  if (request.method === "POST" && sessionReasoningMatch) {
    const sessionId = decodeURIComponent(sessionReasoningMatch[1]);
    readJson(request)
      .then(async (input) => {
        const reasoningLevel = typeof input.reasoningLevel === "string" ? input.reasoningLevel.trim() : "";
        if (!reasoningLevel) {
          sendJson(response, 400, { error: "Reasoning level is required" });
          return;
        }

        const reference = requireSessionReference(sessionId);
        const session = await sessionApplicationService.switchReasoning(sessionId, reasoningLevel);
        emitEvent("SessionReasoningChanged", {
          sessionId: reference.sessionId,
          logicalSessionId: reference.logicalSessionId,
          reasoningLevel
        }, { sessionId: reference.sessionId });
        sendJson(response, 202, { session, reasoningLevel });
      })
      .catch((error) => {
        sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code });
      });
    return true;
  }

  const sessionPermissionsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/permissions$/);
  if (request.method === "POST" && sessionPermissionsMatch) {
    const sessionId = decodeURIComponent(sessionPermissionsMatch[1]);
    readJson(request)
      .then(async (input) => {
        const sandbox = normalizeSandbox(input.sandbox, "");
        const approvalPolicy = normalizeApprovalPolicy(input.approvalPolicy, "");
        if (!["workspace-write", "danger-full-access", "read-only"].includes(input.sandbox)) {
          sendJson(response, 400, { error: "Unsupported sandbox mode" });
          return;
        }
        if (!["on-request", "ask-risky", "never", "on-failure"].includes(input.approvalPolicy)) {
          sendJson(response, 400, { error: "Unsupported approval policy" });
          return;
        }

        const reference = await sessionApplicationService.referenceFor(sessionId);
        const session = await sessionApplicationService.updatePermissions(
          sessionId,
          { sandbox, approvalPolicy },
          { source: { type: "desktop" } }
        );
        emitEvent("SessionPermissionsChanged", {
          sessionId: reference.sessionId,
          logicalSessionId: reference.logicalSessionId,
          sandbox,
          approvalPolicy
        }, { sessionId: reference.sessionId });
        sendJson(response, 202, { session, sandbox, approvalPolicy });
      })
      .catch((error) => {
        sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code ?? null });
      });
    return true;
  }

  return false;
}
