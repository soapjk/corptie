import { deviceError } from "./clientDeviceAuthority.mjs";
import { parseDetailV2JSON } from "./detailV2JSON.mjs";
import { detailV2GetNegotiation } from "./detailV2Negotiation.mjs";

async function body(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) throw deviceError("JSON_REQUIRED", 415);
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw deviceError("DETAIL_ENCODING_UNSUPPORTED", 415);
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw deviceError("BODY_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  return parseDetailV2JSON(Buffer.concat(chunks));
}

/** Mount after the host's preview-write guard and store-readiness guard.
 * authenticate is supplied by desktop local-user or paired-device authority;
 * this adapter never fabricates an identity or bypasses the host's auth.
 */
export function handleDetailActionHttp({ request, response, url, service, authenticate, sendJson, route = "desktop", writesAllowed = false }) {
  const prefix = route === "pairedDevice" ? "/client/v1" : "";
  const match = new RegExp(`^${prefix}/sessions/([^/]+)/detail/(read|actions|receipts/([A-Za-z0-9_-]{8,128}))$`).exec(url.pathname);
  if (!match) return false;
  void (async () => {
    try {
      if (url.search || (match[3] ? request.method !== "GET" : request.method !== "POST")) throw deviceError("DETAIL_REQUEST_NOT_ALLOWED", 405);
      if (request.headers.accept !== "application/json; corptie-detail=native-v1") {
        const profile = detailV2GetNegotiation(request);
        if (!profile || typeof service.forProfile !== "function") throw deviceError("DETAIL_CATALOG_UNSUPPORTED", 409);
        service = service.forProfile(profile);
      }
      const identity = await authenticate(request);
      const sessionId = decodeURIComponent(match[1]);
      const revalidate = () => authenticate(request);
      if (match[3]) {
        if (typeof service.prepareReceipt === "function") {
          const prepared = await service.prepareReceipt(identity, sessionId, match[3], revalidate);
          prepared.revalidate();
          if (!response.destroyed) sendJson(response, 200, prepared.value);
        } else sendJson(response, 200, await service.receipt(identity, sessionId, match[3], revalidate));
        return;
      }
      if (match[2] === "actions" && !writesAllowed) throw deviceError("DETAIL_WRITES_UNAVAILABLE", 403);
      const input = await body(request);
      if (match[2] === "read" && typeof service.prepareRead === "function") {
        const prepared = await service.prepareRead(identity, sessionId, input, revalidate);
        // No await from this synchronous final scope/retirement guard to write.
        prepared.revalidate();
        if (!response.destroyed) sendJson(response, 200, prepared.value);
      } else {
        const value = await service[match[2] === "read" ? "read" : "command"](identity, sessionId, input, revalidate);
        if (match[2] === "actions" && typeof service.prepareReceipt === "function") {
          // Dispatch may have completed while credentials were revoked. Keep
          // the durable outcome, but never publish it to a retired HTTP scope.
          const prepared = await service.prepareReceipt(identity, sessionId, input.requestId, revalidate);
          prepared.revalidate();
          if (!response.destroyed) sendJson(response, 200, prepared.value);
        } else if (!response.destroyed) sendJson(response, 200, value);
      }
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.status ?? 400, { code: error.code ?? "DETAIL_ACTION_FAILED" });
      else response.destroy();
    }
  })();
  return true;
}
