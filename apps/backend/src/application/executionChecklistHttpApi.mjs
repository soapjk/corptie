export function handleExecutionChecklistHttp({ request, response, url, service, sendJson, readJson, preview }) {
  const match = url.pathname.match(/^\/tasks\/([^/]+)\/execution-checklist$/);
  if (!match) return false;
  void Promise.resolve().then(async () => {
    if (request.headers.origin || request.headers["x-corptie-agent-id"]
      || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)) {
      throw Object.assign(new Error("LOCAL_USER_REQUIRED"), { statusCode: 403 });
    }
    const taskId = decodeURIComponent(match[1]);
    if (!service.store.getTask(taskId)) throw Object.assign(new Error("TASK_NOT_FOUND"), { statusCode: 404 });
    if (request.method === "GET") return sendJson(response, 200, { checklist: service.display(service.read(taskId)), writesAllowed: !preview });
    if (preview) throw Object.assign(new Error("DEVELOPMENT_PREVIEW_READ_ONLY"), { statusCode: 403 });
    if (request.method !== "POST") return sendJson(response, 405, { code: "METHOD_NOT_ALLOWED" });
    const result = service.mutate(taskId, await readJson(request));
    return sendJson(response, 200, { ...result, checklist: service.display(result.checklist) });
  }).catch(error => sendJson(response, error.statusCode ?? 400, { code: error.code ?? error.message, error: error.message }));
  return true;
}
