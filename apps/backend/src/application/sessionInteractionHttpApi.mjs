import { randomUUID } from "node:crypto";
import { logSessionMessageLatency, logSessionMessageFailure, sessionMessageLatencyTraceFromHeaders } from "../utils/sessionMessageLatency.mjs";

export function handleSessionInteractionHttpRequest({
  request, response, url, sendUnifiedSessionMessage, userMessageCommandSource,
  chatResourceService, requireSessionReference, interruptUnifiedSession, cancelQueuedUserMessage, deleteUserMessage,
  respondUnifiedSessionApproval, respondUnifiedSessionUserInput,
  readJson, sendJson, unifiedErrorStatus
}) {
  const sessionMessagesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
  const resourceMatch = url.pathname.match(/^\/sessions\/([^/]+)\/resources$/);
  if (request.method === "GET" && resourceMatch) {
    Promise.resolve().then(() => chatResourceService.readMessageResource(
      requireSessionReference(decodeURIComponent(resourceMatch[1])),
      url.searchParams.get("itemId"), url.searchParams.get("path")))
      .then(resource => {
        response.writeHead(200, { "content-type": resource.mimeType, "content-length": resource.byteLength,
          "cache-control": "no-store", "x-content-type-options": "nosniff",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(resource.fileName)}` });
        response.end(resource.data);
      })
      .catch(error => sendJson(response, error.statusCode ?? 500, { code: error.code ?? "RESOURCE_UNAVAILABLE" }));
    return true;
  }
  const deletion = url.pathname.match(/^\/sessions\/([^/]+)\/messages\/([^/]+)$/);
  if (request.method === "DELETE" && deletion) {
    Promise.resolve().then(() => deleteUserMessage(decodeURIComponent(deletion[1]), decodeURIComponent(deletion[2])))
      .then(result => sendJson(response, 200, result))
      .catch(error => sendJson(response, error.status ?? unifiedErrorStatus(error), { error: error.message, code: error.code }));
    return true;
  }
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
        .catch((error) => sendChatImageFailure(response, sendJson, error));
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
        .catch((error) => sendChatImageFailure(response, sendJson, error));
      return true;
    }
    if (request.method === "DELETE") {
      readJson(request)
        .then((input) => chatResourceService.removeUnsentImage(
          requireSessionReference(sessionId),
          input.managedPath
        ))
        .then((result) => sendJson(response, 200, result))
        .catch((error) => sendChatImageFailure(response, sendJson, error));
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

// Image-specific mapping: leave message/session/global error semantics alone.
function sendChatImageFailure(response, sendJson, error) {
  const failures = {
    CHAT_IMAGE_ACCESS_DENIED: [403, "The system denied access while importing the image."],
    CHAT_IMAGE_FORBIDDEN: [403, "This image does not belong to this session."],
    CHAT_IMAGE_SOURCE_MISSING: [404, "The source image is no longer available."],
    CHAT_IMAGE_MISSING: [404, "The image is no longer available."],
    CHAT_IMAGE_SIZE_INVALID: [413, "The image exceeds the attachment size limit."],
    CHAT_IMAGE_FORMAT_UNSUPPORTED: [415, "The image format is not supported."],
    CHAT_IMAGE_PATH_INVALID: [400, "The image path is invalid."],
    CHAT_IMAGE_NOT_FILE: [400, "The source is not an image file."],
    CHAT_IMAGE_IMPORT_FAILED: [500, "The image could not be imported."],
    SESSION_NOT_FOUND: [404, "The session is not available."]
  };
  const code = typeof error?.code === "string" && Object.hasOwn(failures, error.code)
    ? error.code : error instanceof SyntaxError ? "INVALID_REQUEST" : "CHAT_IMAGE_REQUEST_FAILED";
  const [status, message] = failures[code]
    ?? (code === "INVALID_REQUEST" ? [400, "The request is invalid."] : [500, "The image request could not be completed."]);
  sendJson(response, status, { code, error: message });
}
