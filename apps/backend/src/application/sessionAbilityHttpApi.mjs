// Native user management surface. Not registered as an Agent/Tool Host tool.
export async function handleSessionAbilityHttp({ request, response, url, service, readJson, sendJson,
  writesAllowed, onChanged }) {
  const match = /^\/sessions\/([^/]+)\/abilities$/.exec(url.pathname);
  if (!match) return false;
  try {
    if (request.headers?.origin) {
      sendJson(response, 403, { code: "BROWSER_ORIGIN_FORBIDDEN" }); return true;
    }
    const reference = decodeURIComponent(match[1]);
    if (request.method === "GET") {
      sendJson(response, 200, { preferences: service.inspect(reference) }); return true;
    }
    if (request.method !== "PATCH") {
      sendJson(response, 405, { code: "METHOD_NOT_ALLOWED" }); return true;
    }
    if (!writesAllowed) {
      sendJson(response, 403, { code: "SESSION_ABILITY_WRITES_DISABLED" }); return true;
    }
    const result = service.update(reference, await readJson(request));
    if (!result.idempotentReplay) onChanged?.(result.preferences.logicalSessionId, result);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, error.statusCode ?? 500, { code: error.code ?? "SESSION_ABILITY_FAILED", error: error.message });
  }
  return true;
}
