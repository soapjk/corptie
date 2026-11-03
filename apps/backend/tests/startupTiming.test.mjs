import test from "node:test";
import assert from "node:assert/strict";
import { createStartupTiming, measureStartup } from "../src/utils/startupTiming.mjs";
import { SessionApplicationService } from "../src/agent-provider/sessionApplicationService.mjs";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";

test("startup spans correlate nested inclusive timings without paths, output or new hashes", async () => {
  const records = []; let clock = 0;
  const timing = createStartupTiming({ startupOperationId: "startup:1", taskId: "task:1", providerId: "neutral", attempt: 2 }, {
    emit: record => records.push(record), now: () => clock
  });
  const result = await timing.measure("startup.total", async child => {
    clock = 2;
    await child.measure("git.worktree-add", () => { clock = 9; return "/private/output-never-log"; });
    clock = 12;
    return { status: "ready", path: "/private/path-never-log" };
  });
  assert.equal(result.status, "ready");
  assert.equal(records.length, 4);
  assert.equal(records[1].parentSpanId, records[0].spanId);
  assert.equal(records[2].durationMs, 7);
  assert.equal(records[3].durationMs, 12);
  assert.equal(records[3].startupStatus, "ready");
  assert.ok(records.every(row => row.startupOperationId === "startup:1" && row.attempt === 2));
  assert.doesNotMatch(JSON.stringify(records), /private|path-never-log|output-never-log|[Hh]ash/);
});

test("failures are timed with safe codes and preserve the original error", async () => {
  const records = [];
  const timing = createStartupTiming({}, { emit: value => records.push(value) });
  const error = Object.assign(new Error("private path and command output"), { code: "START_TEST_FAILED" });
  await assert.rejects(timing.measure("test.failure", () => { throw error; }), value => value === error);
  assert.equal(records[1].outcome, "failed");
  assert.equal(records[1].errorCode, error.code);
  assert.doesNotMatch(JSON.stringify(records), /private|command output/);
  assert.equal(measureStartup(null, "disabled", () => 17), 17);
  const brokenLogger = createStartupTiming({}, { emit() { throw new Error("logger unavailable"); } });
  assert.equal(await brokenLogger.measure("test.logging", () => 8), 8);
});

test("startup diagnostics never leak into Provider or Store binding contexts", async () => {
  const records = [], contexts = [];
  const registry = new AgentProviderRegistry([new CallbackAgentProvider({ id: "neutral", displayName: "Neutral", transport: "test",
    capabilities: [AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE] }, {
    createSession: async (_input, context) => { contexts.push(context); return { id: "session:timed", sessionKind: "assistantChat" }; }
  })]);
  const service = new SessionApplicationService({ registry, resolveSessionReference: () => null,
    bindCreatedSession: async ({ context }) => { contexts.push(context); return null; } });
  await service.createSession("neutral", { title: "Timed" }, {
    startupTiming: createStartupTiming({ startupOperationId: "startup:2" }, { emit: value => records.push(value) })
  });
  assert.ok(contexts.every(context => !Object.hasOwn(context, "startupTiming")));
  assert.ok(records.some(row => row.stage === "session.provider.create" && row.event === "end"));
  assert.ok(records.some(row => row.stage === "session.store.bind" && row.event === "end"));
});
