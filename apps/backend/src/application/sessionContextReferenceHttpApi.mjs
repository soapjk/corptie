export function handleSessionContextReferenceHttpRequest({ request, response, url, service }) {
  const collectionMatch = url.pathname.match(/^\/sessions\/([^/]+)\/context-references$/);
  const memberMatch = url.pathname.match(/^\/sessions\/([^/]+)\/context-references\/([^/]+)$/);
  const refreshMatch = url.pathname.match(/^\/sessions\/([^/]+)\/context-references\/([^/]+)\/refresh$/);
  if (!collectionMatch && !memberMatch && !refreshMatch) return false;

  Promise.resolve().then(async () => {
    if (collectionMatch) {
      const sessionId = decodeURIComponent(collectionMatch[1]);
      if (request.method === "GET") {
        return sendJson(response, 200, { references: service.list(sessionId) });
      }
      if (request.method === "POST") {
        const reference = await service.create(sessionId, await readJson(request));
        return sendJson(response, 201, { reference });
      }
    }

    if (refreshMatch && request.method === "POST") {
      const reference = await service.refresh(
        decodeURIComponent(refreshMatch[1]),
        decodeURIComponent(refreshMatch[2])
      );
      return sendJson(response, 200, { reference });
    }

    if (memberMatch) {
      const sessionId = decodeURIComponent(memberMatch[1]);
      const referenceId = decodeURIComponent(memberMatch[2]);
      if (request.method === "PATCH") {
        return sendJson(response, 200, { reference: service.update(sessionId, referenceId, await readJson(request)) });
      }
      if (request.method === "DELETE") {
        service.delete(sessionId, referenceId);
        return sendJson(response, 200, { ok: true });
      }
    }
    return sendJson(response, 405, { error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" });
  }).catch((error) => {
    sendJson(response, Number(error?.statusCode) || 500, {
      error: error?.message ?? "Context reference request failed.",
      code: error?.code ?? "CONTEXT_REFERENCE_ERROR"
    });
  });
  return true;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { const error = new Error("Invalid JSON body."); error.code = "INVALID_JSON"; error.statusCode = 400; throw error; }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
