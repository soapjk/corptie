import { assertSessionToolScope } from "./sessionToolScope.mjs";

// Invoked after the server readiness, preview and maintenance gates.
export function handleSessionToolHttpRequest({
  request, response, url, store, collaborationCore, toolHostService,
  sessionToolMetadata, readJson, sendJson, errorStatus
}) {
  if (request.method === "POST" && url.pathname === "/internal/session/tool") {
    readJson(request)
      .then(async (input) => {
        const actorId = typeof request.headers["x-corptie-agent-id"] === "string"
          ? request.headers["x-corptie-agent-id"].trim()
          : "";
        const sessionId = typeof request.headers["x-corptie-session-id"] === "string"
          ? request.headers["x-corptie-session-id"].trim()
          : "";
        const providerBindingId = typeof request.headers["x-corptie-provider-binding-id"] === "string"
          ? request.headers["x-corptie-provider-binding-id"].trim()
          : "";
        const session = sessionId ? store.getSession(sessionId) : null;
        const metadata = sessionToolMetadata(session);
        const boundAgent = session ? collaborationCore.getAgentForSession(session.id) : null;
        assertSessionToolScope({ actorId, providerBindingId, session, metadata, boundAgent });
        const result = await toolHostService.execute({
          actorId, tool: input.tool, arguments: input.arguments ?? {},
          metadata
        });
        sendJson(response, 200, result);
      })
      .catch((error) => sendJson(response, errorStatus(error, 403), {
        error: error.message, code: error.code ?? "SESSION_TOOL_FAILED"
      }));
    return true;
  }

  if (request.method === "GET" && [
    "/internal/session/tool/catalog",
    "/internal/session/tool/catalog/revision"
  ].includes(url.pathname)) {
    const isToolsList = url.pathname === "/internal/session/tool/catalog";
    const observation = {
      // Untrusted request correlation is length-bounded and JSON-escaped.
      observationId: (url.searchParams.get("observationId") ?? "").slice(0, 128)
    };
    const recordObservation = (status, errorCode = null) => {
      if (isToolsList) console.info("[tool-host-catalog]", JSON.stringify({
        stage: "catalog-http", status, ...observation, errorCode
      }));
    };
    recordObservation("received");
    try {
      const actorId = typeof request.headers["x-corptie-agent-id"] === "string"
        ? request.headers["x-corptie-agent-id"].trim() : "";
      const sessionId = typeof request.headers["x-corptie-session-id"] === "string"
        ? request.headers["x-corptie-session-id"].trim() : "";
      const providerBindingId = typeof request.headers["x-corptie-provider-binding-id"] === "string"
        ? request.headers["x-corptie-provider-binding-id"].trim() : "";
      const session = sessionId ? store.getSession(sessionId) : null;
      const boundAgent = session ? collaborationCore.getAgentForSession(session.id) : null;
      const metadata = sessionToolMetadata(session);
      assertSessionToolScope({ actorId, providerBindingId, session, metadata, boundAgent });
      Object.assign(observation, {
        logicalSessionId: metadata.logicalSessionId,
        providerBindingId: metadata.providerBindingId
      });
      recordObservation("authorized");
      if (url.pathname.endsWith("/revision")) {
        sendJson(response, 200, { revision: toolHostService.catalogRevision({ actorId, metadata }) });
        return true;
      }
      toolHostService.observeGeneratedMcpToolsList({
        actorId,
        metadata,
        desiredVersion: url.searchParams.get("desiredVersion") ?? undefined,
        observationId: url.searchParams.get("observationId") ?? ""
      }).then((result) => {
        recordObservation("catalog-returned");
        sendJson(response, 200, result);
      }).catch((error) => {
        recordObservation("observation-rejected", error.code ?? "SESSION_TOOL_CATALOG_FAILED");
        sendJson(response, errorStatus(error, 403), {
          error: error.message, code: error.code ?? "SESSION_TOOL_CATALOG_FAILED"
        });
      });
    } catch (error) {
      recordObservation("authorization-rejected", error.code ?? "SESSION_TOOL_CATALOG_FAILED");
      sendJson(response, errorStatus(error, 403), { error: error.message, code: error.code ?? "SESSION_TOOL_CATALOG_FAILED" });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/internal/work-chat/tool") {
    readJson(request)
      .then(async (input) => {
        const actorId = typeof request.headers["x-corptie-agent-id"] === "string"
          ? request.headers["x-corptie-agent-id"].trim()
          : "";
        const requestedSessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
        const session = (requestedSessionId ? store.getSession(requestedSessionId) : null)
          ?? store.listSessionsByAgent(actorId).find((candidate) =>
            candidate.sessionKind === "workChat" && candidate.workId === input.workId
          );
        const boundAgent = session ? collaborationCore.getAgentForSession(session.id) : null;
        if (!actorId || !session || session.sessionKind !== "workChat"
          || session.workId !== input.workId
          || (session.agentId !== actorId && boundAgent?.agentId !== actorId)) {
          const error = new Error("Work Chat tool scope is invalid or no longer active.");
          error.code = "WORK_CHAT_SCOPE_REQUIRED";
          throw error;
        }
        const result = await toolHostService.execute({
          actorId,
          tool: input.tool,
          arguments: input.arguments ?? {},
          metadata: sessionToolMetadata(session)
        });
        sendJson(response, 200, result);
      })
      .catch((error) => sendJson(response, errorStatus(error, 403), {
        error: error.message,
        code: error.code ?? "WORK_CHAT_TOOL_FAILED"
      }));
    return true;
  }

  return false;
}
