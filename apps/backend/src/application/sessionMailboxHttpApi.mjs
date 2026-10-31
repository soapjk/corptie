// Desktop mailbox access uses the same local-user boundary as Detail actions.
export function handleSessionMailboxHttp({ request, response, url, service, sendJson, readJson, preview = false }) {
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/mailbox(?:\/(settings|messages)(?:\/([^/]+)(?:\/(read|process|ignore))?)?)?$/);
  if (!match) return false;
  void Promise.resolve().then(async () => {
    if (request.headers.origin || request.headers["x-corptie-agent-id"]
      || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)) {
      throw Object.assign(new Error("LOCAL_USER_REQUIRED"), { statusCode: 403 });
    }
    const sessionId = decodeURIComponent(match[1]);
    if (request.method === "GET" && match[2] === "messages" && match[3]) return sendJson(response, 200, service.get(sessionId, decodeURIComponent(match[3])));
    if (request.method === "GET" && !match[2]) return sendJson(response, 200, { ...service.rows(sessionId, Object.fromEntries(url.searchParams)), writesAllowed: !preview });
    if (preview) throw Object.assign(new Error("DEVELOPMENT_PREVIEW_READ_ONLY"), { statusCode: 403 });
    if (request.method === "POST" && match[2] === "settings") {
      const input = await readJson(request);
      return sendJson(response, 200, service.setPaused(sessionId, input.paused));
    }
    if (request.method === "POST" && match[4]) return sendJson(response, 200, service.mutate(sessionId, decodeURIComponent(match[3]), match[4]));
    sendJson(response, 405, { code: "METHOD_NOT_ALLOWED" });
  }).catch(error => sendJson(response, error.statusCode ?? 400, { code: error.code ?? error.message, error: error.message }));
  return true;
}
