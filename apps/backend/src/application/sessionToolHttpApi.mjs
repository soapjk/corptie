import { logError } from "../utils/errorDiagnostics.mjs";

// Invoked after the server readiness, preview and maintenance gates.
export function handleSessionToolHttpRequest({
  request, response, url, toolHostService, readJson, sendJson, errorStatus
}) {
  const credentials = () => ({
    actorId: header(request, "x-corptie-agent-id"),
    evidence: {
      kind: "session-binding",
      sessionId: header(request, "x-corptie-session-id"),
      providerBindingId: header(request, "x-corptie-provider-binding-id")
    }
  });
  const failure = (stage, fallback, error) => {
    logError(stage, error);
    sendJson(response, errorStatus(error, 403), { error: error.message, code: error.code ?? fallback });
  };
  if (request.method === "POST" && ["/internal/session/tool", "/internal/work-chat/tool"].includes(url.pathname)) {
    const workChat = url.pathname === "/internal/work-chat/tool";
    readJson(request).then(async (input) => {
      const authentication = credentials();
      if (workChat) Object.assign(authentication.evidence, { sessionKind: "workChat", workId: input.workId });
      const result = await toolHostService.execute({
        ...authentication, tool: input.tool, arguments: input.arguments ?? {}
      });
      sendJson(response, 200, result);
    }).catch(error => failure(workChat ? "work-chat-tool-http.execute" : "session-tool-http.execute",
      workChat ? "WORK_CHAT_TOOL_FAILED" : "SESSION_TOOL_FAILED", error));
    return true;
  }
  if (request.method === "GET" && [
    "/internal/session/tool/catalog", "/internal/session/tool/catalog/revision"
  ].includes(url.pathname)) {
    const isToolsList = url.pathname === "/internal/session/tool/catalog";
    const observationId = (url.searchParams.get("observationId") ?? "").slice(0, 128);
    const record = (status, errorCode = null) => {
      if (isToolsList) console.info("[tool-host-catalog]", JSON.stringify({
        stage: "catalog-http", status, observationId, errorCode
      }));
    };
    record("received");
    try {
      const authentication = credentials();
      if (!isToolsList) {
        sendJson(response, 200, { revision: toolHostService.catalogRevision(authentication) });
        return true;
      }
      toolHostService.observeGeneratedMcpToolsList({
        ...authentication, desiredVersion: url.searchParams.get("desiredVersion") ?? undefined, observationId
      }).then(result => {
        record("catalog-returned");
        sendJson(response, 200, result);
      }).catch(error => {
        record("observation-rejected", error.code ?? "SESSION_TOOL_CATALOG_FAILED");
        failure("session-tool-http.catalog", "SESSION_TOOL_CATALOG_FAILED", error);
      });
    } catch (error) {
      record("authorization-rejected", error.code ?? "SESSION_TOOL_CATALOG_FAILED");
      failure("session-tool-http.authorize", "SESSION_TOOL_CATALOG_FAILED", error);
    }
    return true;
  }
  return false;
}

function header(request, name) {
  return typeof request.headers[name] === "string" ? request.headers[name].trim() : "";
}
