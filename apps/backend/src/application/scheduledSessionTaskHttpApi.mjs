export function handleScheduledSessionTaskHttpRequest({ request, response, url, service, resolveActor }) {
  const path = url.pathname;
  const basePath = path === "/scheduled-tasks" || path.startsWith("/scheduled-tasks/")
    ? "/scheduled-tasks"
    : path === "/scheduled-session-tasks" || path.startsWith("/scheduled-session-tasks/")
      ? "/scheduled-session-tasks"
      : null;
  if (!basePath) return false;

  Promise.resolve().then(async () => {
    const actor = resolveActor(request);
    if (request.method === "GET" && path === basePath) {
      return sendJson(response, 200, {
        tasks: service.list({
          logicalSessionId: url.searchParams.get("logicalSessionId") ?? undefined,
          status: url.searchParams.get("status") ?? undefined
        }, actor)
      });
    }
    if (request.method === "POST" && path === basePath) {
      const task = service.create(await readJson(request), actor);
      return sendJson(response, 201, { task });
    }

    const relativePath = path.slice(basePath.length);
    const actionMatch = relativePath.match(/^\/([^/]+)\/(pause|resume|cancel|run)$/);
    if (request.method === "POST" && actionMatch) {
      const taskId = decodeURIComponent(actionMatch[1]);
      const action = actionMatch[2];
      const result = action === "pause"
        ? service.pause(taskId, actor)
        : action === "resume"
          ? service.resume(taskId, actor)
          : action === "cancel"
            ? service.cancel(taskId, actor)
            : await service.runNow(taskId, actor);
      return sendJson(response, 200, action === "run" ? { run: result } : { task: result });
    }

    const itemMatch = relativePath.match(/^\/([^/]+)$/);
    if (itemMatch) {
      const taskId = decodeURIComponent(itemMatch[1]);
      if (request.method === "GET") return sendJson(response, 200, service.get(taskId, actor));
      if (request.method === "PATCH") {
        return sendJson(response, 200, { task: service.update(taskId, await readJson(request), actor) });
      }
    }
    return sendJson(response, 405, { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" });
  }).catch((error) => sendJson(response, statusFor(error), {
    error: error.message,
    code: error.code ?? "SCHEDULED_SESSION_TASK_FAILED",
    field: error.field ?? null
  }));
  return true;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) {
      const error = new Error("Request body is too large.");
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.code = "INVALID_JSON";
    throw error;
  }
}

function statusFor(error) {
  if (["ACTOR_REQUIRED", "AGENT_TOOL_FORBIDDEN", "AUTHORIZATION_REVOKED"].includes(error.code)) return 403;
  if (["SCHEDULED_TASK_NOT_FOUND", "SESSION_NOT_FOUND"].includes(error.code)) return 404;
  if (["RESOURCE_VERSION_CONFLICT", "TASK_NOT_MUTABLE", "TASK_NOT_RESUMABLE", "TASK_CANCELLED"].includes(error.code)) return 409;
  if (error.code === "REQUEST_TOO_LARGE") return 413;
  return 400;
}

function sendJson(response, status, body) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
