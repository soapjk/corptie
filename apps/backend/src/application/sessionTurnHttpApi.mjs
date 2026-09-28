import { randomUUID } from "node:crypto";

export function handleSessionTurnHttpRequest({ request, response, url, sessionApplicationService, readJson, sendJson, errorStatus, unifiedErrorStatus }) {
  const sessionRestartMatch = url.pathname.match(/^\/sessions\/([^/]+)\/restart$/);
  if (request.method === "POST" && sessionRestartMatch) {
    const sessionId = decodeURIComponent(sessionRestartMatch[1]);
    readJson(request)
      .then(async (input) => {
        const unknown = Object.keys(input).filter((field) => field !== "idempotencyKey");
        if (unknown.length > 0) {
          const error = new Error("Session restart request contains unknown fields.");
          error.code = "SESSION_RESTART_UNKNOWN_FIELD";
          throw error;
        }
        const result = await sessionApplicationService.restartSession(sessionId, {
          source: "compatibility-route",
          idempotencyKey: String(input.idempotencyKey ?? `restart:${randomUUID()}`).trim()
        });
        sendJson(response, result.status === "waitingForTurn" ? 202 : 200, result);
      })
      .catch((error) => {
        sendJson(response, errorStatus(error, 400), {
          error: error.message,
          code: error.code
        });
      });
    return true;
  }

  const sessionTurnChangesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/turns\/([^/]+)\/changes\/(review|undo)$/);
  if (request.method === "POST" && sessionTurnChangesMatch) {
    const sessionId = decodeURIComponent(sessionTurnChangesMatch[1]);
    const turnId = decodeURIComponent(sessionTurnChangesMatch[2]);
    const action = sessionTurnChangesMatch[3];
    sessionApplicationService.manageTurnChanges(sessionId, turnId, action, { source: "http" })
      .then((payload) => sendJson(response, 200, payload))
      .catch((error) => {
        sendJson(response, unifiedErrorStatus(error), { error: error.stderr || error.message, code: error.code ?? null });
      });
    return true;
  }

  return false;
}
