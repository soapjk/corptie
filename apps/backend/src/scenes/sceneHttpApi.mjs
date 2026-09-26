export function handleSceneHttpRequest({ request, response, url, service }) {
  if (url.pathname !== "/scene-templates" && !url.pathname.startsWith("/scenes")) return false;
  Promise.resolve().then(async () => {
    if (request.method === "GET" && url.pathname === "/scene-templates") {
      return sendJson(response, 200, { templates: service.listTemplates() });
    }
    if (request.method === "GET" && url.pathname === "/scenes") {
      return sendJson(response, 200, { scenes: service.listScenes() });
    }
    if (request.method === "POST" && url.pathname === "/scenes") {
      return sendJson(response, 201, { scene: service.createScene(await readJson(request)) });
    }
    const view = url.pathname.match(/^\/scenes\/([^/]+)\/views\/([^/]+)$/);
    if (request.method === "GET" && view) {
      return sendJson(response, 200, service.readView(decodeURIComponent(view[1]), decodeURIComponent(view[2]), {
        limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset")
      }));
    }
    const changes = url.pathname.match(/^\/scenes\/([^/]+)\/changes$/);
    if (request.method === "GET" && changes) {
      return sendJson(response, 200, { changes: service.changesAfter(
        decodeURIComponent(changes[1]), url.searchParams.get("afterRevision"), url.searchParams.get("limit")
      ) });
    }
    const preview = url.pathname.match(/^\/scenes\/([^/]+)\/commands\/preview$/);
    if (request.method === "POST" && preview) {
      const input = await readJson(request);
      return sendJson(response, 200, service.previewCommand({
        ...input, instanceId: decodeURIComponent(preview[1]), sourceKind: "manual"
      }));
    }
    const commit = url.pathname.match(/^\/scenes\/([^/]+)\/commands\/commit$/);
    if (request.method === "POST" && commit) {
      const input = await readJson(request);
      if (input.previewToken) return sendJson(response, 200, service.commitPreview(input.previewToken, {
        idempotencyKey: input.idempotencyKey
      }));
      return sendJson(response, 200, service.executeCommand({
        ...input, instanceId: decodeURIComponent(commit[1]), sourceKind: "manual"
      }));
    }
    const sessions = url.pathname.match(/^\/scenes\/([^/]+)\/sessions$/);
    if (request.method === "POST" && sessions) {
      const input = await readJson(request);
      return sendJson(response, 201, { binding: service.bindSession(
        decodeURIComponent(sessions[1]), input.sessionId, { makeDefault: input.makeDefault !== false }
      ) });
    }
    const scene = url.pathname.match(/^\/scenes\/([^/]+)$/);
    if (request.method === "GET" && scene) {
      const value = service.getScene(decodeURIComponent(scene[1]));
      if (!value) throw apiError("SCENE_NOT_FOUND", "Scene instance was not found.", 404);
      return sendJson(response, 200, { scene: value });
    }
    throw apiError("NOT_FOUND", "Not found", 404);
  }).catch((error) => sendJson(response, error.statusCode ?? 500, {
    error: error.message, code: error.code ?? "SCENE_REQUEST_FAILED", details: error.details
  }));
  return true;
}

function sendJson(response, statusCode, body) {
  if (response.writableEnded) return;
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw apiError("PAYLOAD_TOO_LARGE", "Request body is too large.", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw apiError("INVALID_JSON", "Request body must be valid JSON.", 400); }
}

function apiError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
