export function handleCodeTaskObservabilityHttpRequest({ request, response, url, service }) {
  const context = requestContext(request);
  const executions = url.pathname.match(/^\/sessions\/([^/]+)\/turns\/([^/]+)\/executions$/);
  const summary = url.pathname.match(/^\/turn-executions\/([^/]+)\/summary$/);
  const timeline = url.pathname.match(/^\/turn-executions\/([^/]+)\/timeline$/);
  const spans = url.pathname.match(/^\/turn-executions\/([^/]+)\/spans$/);
  const correlations = url.pathname.match(/^\/turn-executions\/([^/]+)\/correlations$/);
  const exported = url.pathname.match(/^\/turn-executions\/([^/]+)\/export$/);
  const latest = url.pathname.match(/^\/sessions\/([^/]+)\/turn-observability\/latest$/);
  try {
    if (request.method === "GET" && executions) return send(response, 200, { executions: service.executions(
      decodeURIComponent(executions[1]), decodeURIComponent(executions[2]), context) });
    if (request.method === "GET" && summary) return send(response, 200, { summary: service.summary(decodeURIComponent(summary[1]), context) });
    if (request.method === "GET" && timeline) return send(response, 200, service.timeline(decodeURIComponent(timeline[1]), {
      cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit"), context }));
    if (request.method === "GET" && spans) return send(response, 200, service.spans(decodeURIComponent(spans[1]), {
      cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit"), context }));
    if (request.method === "GET" && correlations) return send(response, 200, service.correlations(decodeURIComponent(correlations[1]), context));
    if (request.method === "GET" && exported) return send(response, 200, service.export(decodeURIComponent(exported[1]),
      url.searchParams.get("format") ?? "corptie-json-v4", context));
    if (request.method === "GET" && latest) return send(response, 200, { summary: service.latestSummary(decodeURIComponent(latest[1]), context) });
  } catch (error) { return sendError(response, error); }
  return false;
}

function requestContext(request) {
  const logicalSessionId = boundedHeader(request, "x-corptie-session-id");
  if (!logicalSessionId) return { kind: "local_user" };
  return { kind: "session", logicalSessionId, taskId: boundedHeader(request, "x-corptie-task-id"),
    canReadRelatedObservability: boundedHeader(request, "x-corptie-observability-related") === "true",
    canReadRawObservability: boundedHeader(request, "x-corptie-observability-raw") === "true" };
}
function boundedHeader(request, name) { const value = request?.headers?.[name]; return typeof value === "string" && value.length <= 256 ? value.trim() : null; }
function send(response, status, body) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(body)); return true; }
function sendError(response, error) { return send(response, error.statusCode ?? 400, { error: error.message, code: error.code ?? "TURN_OBSERVABILITY_ERROR", details: error.details }); }
