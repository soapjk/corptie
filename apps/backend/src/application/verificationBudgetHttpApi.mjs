export function handleVerificationBudgetHttp({ request, response, url, service, sendJson, readJson, preview }) {
  const match = url.pathname.match(/^\/tasks\/([^/]+)\/verification-budgets(?:\/([^/]+)\/(extend|stop))?$/);
  const defaults = url.pathname === "/settings/verification-budget";
  if (!match && !defaults) return false;
  void Promise.resolve().then(async () => {
    if (request.headers.origin || request.headers["x-corptie-agent-id"]
      || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)) {
      throw Object.assign(new Error("LOCAL_USER_REQUIRED"), { statusCode: 403 });
    }
    if (request.method === "GET") return sendJson(response, 200, defaults
      ? { limit: service.defaultLimit(), enforcement: "entry_only" } : { budgets: service.list(decodeURIComponent(match[1])) });
    if (request.method !== "POST") return sendJson(response, 405, { code: "METHOD_NOT_ALLOWED" });
    if (preview) throw Object.assign(new Error("DEVELOPMENT_PREVIEW_READ_ONLY"), { statusCode: 403 });
    const input = await readJson(request);
    if (defaults) return sendJson(response, 200, service.setDefault(input.limit));
    const taskId = decodeURIComponent(match[1]), id = decodeURIComponent(match[2] ?? "");
    if (!id || !match[3]) return sendJson(response, 400, { code: "VERIFICATION_ACTION_INVALID" });
    const budget = match[3] === "extend" ? service.extend(taskId, id, input) : service.stop(taskId, id);
    return sendJson(response, 200, { budget });
  }).catch(error => sendJson(response, error.statusCode ?? 500, { code: error.code ?? error.message, error: error.message }));
  return true;
}
