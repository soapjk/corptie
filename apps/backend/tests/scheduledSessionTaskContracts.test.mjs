import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import { handleScheduledSessionTaskHttpRequest } from "../src/application/scheduledSessionTaskHttpApi.mjs";
import {
  callScheduledSessionTaskDynamicTool,
  scheduledSessionTaskDynamicTools
} from "../src/application/scheduledSessionTaskDynamicTools.mjs";

test("Host Tool contract injects the runtime actor and never accepts an actor from model arguments", async () => {
  const calls = [];
  const service = {
    create(input, actor) { calls.push({ input, actor }); return { taskId: "task:one" }; }
  };
  const catalog = new HostToolCatalog([{
    id: "scheduled",
    tools: scheduledSessionTaskDynamicTools,
    authorize: ({ actorId, metadata }) => actorId === "agent:runtime" && metadata?.sessionId === "session:runtime",
    execute: (input) => callScheduledSessionTaskDynamicTool(service, input)
  }]);
  const definition = catalog.definitions({
    actorId: "agent:runtime",
    metadata: { sessionId: "session:runtime" }
  })[0];
  assert.equal(definition.name, "corptie_scheduled_session_tasks_manage");
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.equal(Object.hasOwn(definition.inputSchema.properties, "actor_id"), false);

  await catalog.execute({
    actorId: "agent:runtime",
    metadata: { sessionId: "session:runtime" },
    tool: definition.name,
    arguments: {
      action: "create",
      logical_session_id: "logical:target",
      message: "wake",
      schedule_type: "once",
      run_at: "2026-08-22T12:00:00Z"
    }
  });
  assert.deepEqual(calls[0].actor, { type: "agent", id: "agent:runtime" });
  assert.equal(calls[0].input.logicalSessionId, "logical:target");
  await assert.rejects(() => catalog.execute({
    actorId: "agent:forged",
    metadata: { sessionId: "session:runtime" },
    tool: definition.name,
    arguments: { action: "list" }
  }), (error) => error.code === "AGENT_TOOL_FORBIDDEN");
});

test("HTTP contract exposes create, list, detail, update, lifecycle actions, and run now", async () => {
  const calls = [];
  const service = {
    create(input, actor) { calls.push(["create", input, actor]); return { taskId: "task:one" }; },
    list(input, actor) { calls.push(["list", input, actor]); return [{ taskId: "task:one" }]; },
    get(id, actor) { calls.push(["get", id, actor]); return { taskId: id, runs: [], events: [] }; },
    update(id, input, actor) { calls.push(["update", id, input, actor]); return { taskId: id }; },
    pause(id, actor) { calls.push(["pause", id, actor]); return { taskId: id, status: "paused" }; },
    resume(id, actor) { calls.push(["resume", id, actor]); return { taskId: id, status: "active" }; },
    cancel(id, actor) { calls.push(["cancel", id, actor]); return { taskId: id, status: "cancelled" }; },
    async runNow(id, actor) { calls.push(["run", id, actor]); return { runId: "run:one" }; }
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (!handleScheduledSessionTaskHttpRequest({
      request,
      response,
      url,
      service,
      resolveActor: () => ({ type: "user", id: "user:trusted-runtime" })
    })) {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const create = await fetch(`${base}/scheduled-session-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logicalSessionId: "logical:one", scheduleType: "once", message: "wake" })
    });
    assert.equal(create.status, 201);
    assert.equal((await create.json()).task.taskId, "task:one");
    assert.equal((await fetch(`${base}/scheduled-session-tasks?logicalSessionId=logical%3Aone`)).status, 200);
    assert.equal((await fetch(`${base}/scheduled-session-tasks/task%3Aone`)).status, 200);
    assert.equal((await fetch(`${base}/scheduled-session-tasks/task%3Aone`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ timezone: "UTC" })
    })).status, 200);
    for (const action of ["pause", "resume", "cancel", "run"]) {
      assert.equal((await fetch(`${base}/scheduled-session-tasks/task%3Aone/${action}`, { method: "POST" })).status, 200);
    }
    assert.equal(calls.every((call) => call.at(-1).id === "user:trusted-runtime"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
