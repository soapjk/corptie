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
  assert.equal(definition.name, "corptie_scheduled_tasks_manage");
  assert.match(definition.description, /计划任务/);
  assert.deepEqual(definition.inputSchema.properties.schedule_type.enum, [
    "at", "after", "interval", "processExit", "condition", "once"
  ]);
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.equal(definition.inputSchema.allOf[0].then.oneOf.length, 2);
  assert.deepEqual(definition.inputSchema.allOf[0].then.required, ["name"]);
  assert.equal(Object.hasOwn(definition.inputSchema.properties, "actor_id"), false);

  await catalog.execute({
    actorId: "agent:runtime",
    metadata: { sessionId: "session:runtime" },
    tool: definition.name,
    arguments: {
      action: "create",
      name: "Wake up",
      logical_session_id: "logical:target",
      message: "wake",
      schedule_type: "once",
      run_at: "2026-08-22T12:00:00Z",
      expires_at: "2026-08-23T12:00:00Z"
    }
  });
  assert.deepEqual(calls[0].actor, { type: "agent", id: "agent:runtime" });
  assert.equal(calls[0].input.logicalSessionId, "logical:target");
  await catalog.execute({
    actorId: "agent:runtime",
    metadata: { sessionId: "session:runtime" },
    tool: definition.name,
    arguments: {
      action: "create",
      name: "Wait for ready flag",
      logical_session_id: "logical:target",
      message: "wake when ready",
      schedule_type: "condition",
      expires_after_seconds: 3600,
      condition: {
        script: "test -f ready.flag",
        check_interval_seconds: 7,
        timeout_seconds: 9,
        working_directory: "/tmp"
      }
    }
  });
  assert.deepEqual(calls[1].input.condition, {
    script: "test -f ready.flag",
    checkIntervalSeconds: 7,
    timeoutSeconds: 9,
    workingDirectory: "/tmp"
  });
  await assert.rejects(() => catalog.execute({
    actorId: "agent:runtime",
    metadata: { sessionId: "session:runtime" },
    tool: definition.name,
    arguments: {
      action: "create", name: "Missing expiration", schedule_type: "after",
      delay_seconds: 10, message: "missing expiration"
    }
  }), (error) => error.code === "INVALID_INPUT" && /requires exactly one/.test(error.message));
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
      resolveActor: () => ({ type: "user", id: "user:trusted-runtime" }),
      resolveCurrentLogicalSessionId: () => "logical:current"
    })) {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const create = await fetch(`${base}/scheduled-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logicalSessionId: "logical:one", scheduleType: "once", message: "wake" })
    });
    assert.equal(create.status, 201);
    assert.equal((await create.json()).task.taskId, "task:one");
    assert.equal((await fetch(`${base}/scheduled-tasks?logicalSessionId=logical%3Aone`)).status, 200);
    assert.equal((await fetch(`${base}/scheduled-tasks/task%3Aone`)).status, 200);
    assert.equal((await fetch(`${base}/scheduled-tasks/task%3Aone`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ timezone: "UTC" })
    })).status, 200);
    for (const action of ["pause", "resume", "cancel", "run"]) {
      assert.equal((await fetch(`${base}/scheduled-tasks/task%3Aone/${action}`, { method: "POST" })).status, 200);
    }
    assert.equal((await fetch(`${base}/scheduled-session-tasks`)).status, 200);
    assert.equal((await fetch(`${base}/automations`)).status, 200);
    const currentCreate = await fetch(`${base}/automations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-corptie-session-id": "session:current" },
      body: JSON.stringify({ scheduleType: "after", delaySeconds: 10, message: "current" })
    });
    assert.equal(currentCreate.status, 201);
    assert.equal(calls.at(-1)[1].logicalSessionId, "logical:current");
    const currentList = await fetch(`${base}/automations?currentSession=true`, {
      headers: { "x-corptie-session-id": "session:current" }
    });
    assert.equal(currentList.status, 200);
    assert.equal(calls.at(-1)[1].logicalSessionId, "logical:current");
    assert.equal(calls.every((call) => call.at(-1).id === "user:trusted-runtime"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
