import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { handleScheduledSessionTaskHttpRequest } from "../src/application/scheduledSessionTaskHttpApi.mjs";

const delayMilliseconds = Math.max(0, Number(
  process.argv.find((argument) => argument.startsWith("--query-delay-ms="))?.split("=")[1] ?? 1_500
));
const taskCount = Math.max(1, Number(
  process.argv.find((argument) => argument.startsWith("--task-count="))?.split("=")[1] ?? 6
));
const tasks = Array.from({ length: taskCount }, (_, index) => ({
  taskId: `scheduled_task:${index + 1}`,
  logicalSessionId: "logical:benchmark",
  runs: [{ runId: `scheduled_run:${index + 1}` }]
}));
let listRequests = 0;
let detailRequests = 0;
const service = {
  list(options) {
    listRequests += 1;
    blockEventLoop(delayMilliseconds);
    return options.includeRuns ? tasks : tasks.map(({ runs: _runs, ...task }) => task);
  },
  get(taskId) {
    detailRequests += 1;
    blockEventLoop(delayMilliseconds);
    return tasks.find((task) => task.taskId === taskId);
  }
};
const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (!handleScheduledSessionTaskHttpRequest({
    request,
    response,
    url,
    service,
    resolveActor: () => ({ type: "user", id: "user:benchmark" })
  })) response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

try {
  const legacyStartedAt = performance.now();
  const legacySummaries = (await getJson(`${baseURL}/scheduled-session-tasks`)).tasks;
  const legacyTasks = await Promise.all(legacySummaries.map((task) =>
    getJson(`${baseURL}/scheduled-session-tasks/${encodeURIComponent(task.taskId)}`)
  ));
  const legacyMilliseconds = performance.now() - legacyStartedAt;
  const legacyRequestCount = listRequests + detailRequests;

  listRequests = 0;
  detailRequests = 0;
  const optimizedStartedAt = performance.now();
  const optimizedTasks = (await getJson(
    `${baseURL}/scheduled-session-tasks?logicalSessionId=logical%3Abenchmark&includeRuns=true`
  )).tasks;
  const optimizedMilliseconds = performance.now() - optimizedStartedAt;
  const optimizedRequestCount = listRequests + detailRequests;

  assert.deepEqual(optimizedTasks, legacyTasks);
  console.log(JSON.stringify({
    taskCount,
    simulatedSynchronousQueryDelayMs: delayMilliseconds,
    legacy: { requestCount: legacyRequestCount, totalMs: rounded(legacyMilliseconds) },
    optimized: { requestCount: optimizedRequestCount, totalMs: rounded(optimizedMilliseconds) },
    speedup: rounded(legacyMilliseconds / optimizedMilliseconds),
    payloadsEqual: true,
    optimizedUnderTwoSeconds: optimizedMilliseconds < 2_000
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

function blockEventLoop(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}
