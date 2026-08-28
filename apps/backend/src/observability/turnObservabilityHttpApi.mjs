export function handleTurnObservabilityHttpRequest({ request, response, url, service }) {
  const latest = url.pathname.match(/^\/sessions\/([^/]+)\/turn-observability\/latest$/);
  const turn = url.pathname.match(/^\/sessions\/([^/]+)\/turns\/([^/]+)\/observability$/);
  const raw = url.pathname.match(/^\/turn-runs\/([^/]+)\/trace$/);
  const exported = url.pathname.match(/^\/turn-runs\/([^/]+)\/export$/);
  const aggregate = url.pathname.match(/^\/(sessions|work-items|objectives)\/([^/]+)\/turn-time-summary$/);
  try {
    if (request.method === "GET" && latest) return send(response, 200, { summary: service.latestCompleted(decodeURIComponent(latest[1])) });
    if (request.method === "GET" && turn) return send(response, 200, { summary: service.turnSummary(decodeURIComponent(turn[1]), decodeURIComponent(turn[2])) });
    if (request.method === "GET" && raw) return send(response, 200, service.rawTrace(decodeURIComponent(raw[1])));
    if (request.method === "GET" && exported) return send(response, 200, service.export(decodeURIComponent(exported[1]), url.searchParams.get("format") ?? "json"));
    if (request.method === "GET" && aggregate) {
      const scope = aggregate[1] === "sessions" ? "session" : aggregate[1] === "work-items" ? "work-item" : "objective";
      return send(response, 200, service.aggregate(scope, decodeURIComponent(aggregate[2]), url.searchParams.get("limit")));
    }
    if (request.method === "POST" && url.pathname === "/telemetry/v1/traces") {
      readJson(request).then((body) => send(response, 202, { summary: service.ingestOTLP(body) }))
        .catch((error) => sendError(response, error));
      return true;
    }
  } catch (error) { return sendError(response, error); }
  return false;
}

function send(response, status, body) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(body)); return true; }
function sendError(response, error) { return send(response, error.statusCode ?? 400, { error: error.message, code: error.code ?? "TURN_OBSERVABILITY_ERROR" }); }
async function readJson(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = Buffer.concat(chunks).toString("utf8"); return body ? JSON.parse(body) : {}; }
