import { deviceError } from "./clientDeviceAuthority.mjs";
import { parseDetailV2JSON } from "./detailV2JSON.mjs";

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
      if (request.headers.accept !== "application/json; corptie-detail=native-v1") throw deviceError("DETAIL_CATALOG_UNSUPPORTED", 409);
      const identity = await authenticate(request);
      const sessionId = decodeURIComponent(match[1]);
      const revalidate = () => authenticate(request);
      if (match[3]) return sendJson(response, 200, await service.receipt(identity, sessionId, match[3], revalidate));
      if (match[2] === "actions" && !writesAllowed) throw deviceError("DETAIL_WRITES_UNAVAILABLE", 403);
      const input = await body(request);
      sendJson(response, 200, await service[match[2] === "read" ? "read" : "command"](identity, sessionId, input, revalidate));
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.status ?? 400, { code: error.code ?? "DETAIL_ACTION_FAILED" });
      else response.destroy();
    }
  })();
  return true;
}
