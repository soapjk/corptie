import { randomUUID } from "node:crypto";
import { logSessionMessageLatency, logSessionMessageFailure, sessionMessageLatencyTraceFromHeaders } from "../utils/sessionMessageLatency.mjs";

export function handleSessionInteractionHttpRequest({
  request, response, url, sendUnifiedSessionMessage, userMessageCommandSource,
  chatResourceService, requireSessionReference, interruptUnifiedSession, cancelQueuedUserMessage,
  respondUnifiedSessionApproval, respondUnifiedSessionUserInput,
  readJson, sendJson, unifiedErrorStatus
}) {
  const sessionMessagesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
  if (request.method === "POST" && sessionMessagesMatch) {
    const sessionId = decodeURIComponent(sessionMessagesMatch[1]);
    const latencyTrace = sessionMessageLatencyTraceFromHeaders(request.headers, {
      traceId: `message:${randomUUID()}`,
      sessionId,
      serverReceivedAtMs: Date.now()
    });
    logSessionMessageLatency(latencyTrace, "server_request_received");
    let failureStage = "request_parse";
    readJson(request)
      .then((input) => {
        failureStage = "message_dispatch";
        logSessionMessageLatency(latencyTrace, "server_request_parsed");
        return sendUnifiedSessionMessage(
          sessionId,
          input,
          userMessageCommandSource(input),
          { ...input, latencyTrace }
        );
      })
      .then((result) => sendJson(response, 202, result))
      .catch((error) => {
        const status = unifiedErrorStatus(error);
        logSessionMessageFailure(latencyTrace, error, status, failureStage);
        sendJson(response, status, {
          error: error.message,
          code: error.code,
          traceId: latencyTrace?.traceId,
          ...(error.details && typeof error.details === "object" ? { details: error.details } : {})
        });
      });
    return true;
  }

  const queuedMessageCancelMatch = url.pathname.match(/^\/sessions\/([^/]+)\/queued-messages\/([^/]+)\/cancel$/);
  if (request.method === "POST" && queuedMessageCancelMatch) {
    Promise.resolve()
      .then(() => cancelQueuedUserMessage(
        decodeURIComponent(queuedMessageCancelMatch[1]), decodeURIComponent(queuedMessageCancelMatch[2])
      ))
      .then((task) => sendJson(response, 200, { task }))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code }));
    return true;
  }

  const sessionImagesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/images$/);
  if (sessionImagesMatch) {
    const sessionId = decodeURIComponent(sessionImagesMatch[1]);
    if (request.method === "POST") {
      readJson(request)
        .then((input) => chatResourceService.importImage(requireSessionReference(sessionId), input))
        .then((image) => sendJson(response, 201, { image }))
        .catch((error) => sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code }));
      return true;
    }
    if (request.method === "GET") {
      Promise.resolve()
        .then(() => chatResourceService.readImage(
          requireSessionReference(sessionId),
          url.searchParams.get("path")
        ))
        .then((image) => {
          response.writeHead(200, {
            "content-type": image.mimeType,
            "content-length": image.byteLength,
            "cache-control": "private, max-age=31536000, immutable"
          });
          response.end(image.data);
        })
        .catch((error) => sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code }));
      return true;
    }
    if (request.method === "DELETE") {
      readJson(request)
        .then((input) => chatResourceService.removeUnsentImage(
          requireSessionReference(sessionId),
          input.managedPath
        ))
        .then((result) => sendJson(response, 200, result))
        .catch((error) => sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code }));
      return true;
    }
  }

  const sessionInterruptMatch = url.pathname.match(/^\/sessions\/([^/]+)\/interrupt$/);
  if (request.method === "POST" && sessionInterruptMatch) {
    const sessionId = decodeURIComponent(sessionInterruptMatch[1]);
    readJson(request)
      .catch(() => ({}))
      .then((input) => interruptUnifiedSession(
        sessionId,
        input.source && typeof input.source === "object" ? input.source : { type: "desktop" }
      ))
      .then((session) => sendJson(response, 200, { session }))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), { error: error.message, code: error.code }));
    return true;
  }

  const sessionApprovalMatch = url.pathname.match(/^\/sessions\/([^/]+)\/actions\/approve$/);
  if (request.method === "POST" && sessionApprovalMatch) {
    const sessionId = decodeURIComponent(sessionApprovalMatch[1]);
    readJson(request)
      .then((input) => respondUnifiedSessionApproval(
        sessionId,
        input,
        input.source && typeof input.source === "object" ? input.source : { type: "desktop" }
      ))
      .then((session) => sendJson(response, 200, { session }))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), {
        error: error.message,
        code: error.code ?? null
      }));
    return true;
  }

  const sessionUserInputMatch = url.pathname.match(/^\/sessions\/([^/]+)\/actions\/user-input$/);
  if (request.method === "POST" && sessionUserInputMatch) {
    const sessionId = decodeURIComponent(sessionUserInputMatch[1]);
    readJson(request)
      .then((input) => respondUnifiedSessionUserInput(sessionId, input, { type: "desktop" }))
      .then((session) => sendJson(response, 200, { session }))
      .catch((error) => sendJson(response, unifiedErrorStatus(error), {
        error: error.message, code: error.code ?? null
      }));
    return true;
  }

  return false;
}
