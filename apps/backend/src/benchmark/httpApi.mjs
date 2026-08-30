import { safeBenchmarkError } from "./canonical.mjs";

export function handleBenchmarkHttpRequest({ request, response, url, controlPlane }) {
  if (url.pathname !== "/benchmark" && !url.pathname.startsWith("/benchmark/")) return false;
  Promise.resolve().then(async () => {
    const sessionId = requiredSessionId(request);
    if (request.method === "GET" && url.pathname === "/benchmark/manifest") return send(response, 200, controlPlane.manifest());
    if (request.method === "GET" && url.pathname === "/benchmark/catalog") return send(response, 200, controlPlane.catalogList());
    const catalog = url.pathname.match(/^\/benchmark\/catalog\/(S[1-7])$/);
    if (request.method === "GET" && catalog) return send(response, 200, controlPlane.catalogGet(catalog[1]));
    if (request.method === "GET" && url.pathname === "/benchmark/experiments") return send(response, 200, { experiments: controlPlane.listExperiments(sessionId) });
    if (request.method === "POST" && url.pathname === "/benchmark/experiments") return send(response, 201, controlPlane.createExperiment(sessionId, await readJson(request)));
    const experiment = url.pathname.match(/^\/benchmark\/experiments\/([^/]+)$/);
    if (request.method === "GET" && experiment) return send(response, 200, controlPlane.getExperiment(sessionId, decodeURIComponent(experiment[1])));
    const run = url.pathname.match(/^\/benchmark\/experiments\/([^/]+)\/run$/);
    if (request.method === "POST" && run) return send(response, 200, await controlPlane.runExperiment(sessionId, decodeURIComponent(run[1])));
    const cancel = url.pathname.match(/^\/benchmark\/experiments\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancel) return send(response, 200, await controlPlane.cancelExperiment(sessionId, decodeURIComponent(cancel[1]), Number((await readJson(request)).resourceVersion)));
    const report = url.pathname.match(/^\/benchmark\/reports\/([^/]+)$/);
    if (request.method === "GET" && report) return send(response, 200, controlPlane.getReport(sessionId, decodeURIComponent(report[1])));
    const decision = url.pathname.match(/^\/benchmark\/gate-decisions\/([^/]+)$/);
    if (request.method === "GET" && decision) return send(response, 200, controlPlane.getDecision(sessionId, decodeURIComponent(decision[1])));
    return send(response, 404, { error: { code: "BENCHMARK_ROUTE_NOT_FOUND", safeMessage: "Benchmark route not found." } });
  }).catch((error) => send(response, error?.statusCode ?? 500, { error: safeBenchmarkError(error) }));
  return true;
}

function requiredSessionId(request) {
  const value = request.headers["x-corptie-logical-session-id"];
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error("Logical Session header is required.");
    error.code = "BENCHMARK_SESSION_REQUIRED";
    error.safeMessage = "x-corptie-logical-session-id is required.";
    error.statusCode = 401;
    throw error;
  }
  return value.trim();
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > 1024 * 1024) {
      const error = new Error("Request too large."); error.code = "BENCHMARK_REQUEST_TOO_LARGE"; error.safeMessage = "Benchmark request exceeds 1 MiB."; error.statusCode = 413; throw error;
    }
    chunks.push(chunk);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
  catch { const error = new Error("Invalid JSON."); error.code = "BENCHMARK_INVALID_JSON"; error.safeMessage = "Invalid JSON body."; error.statusCode = 400; throw error; }
}

function send(response, status, value) {
  if (response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
