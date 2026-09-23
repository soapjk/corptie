// Opt-in only: node apps/backend/tests/manual-codex-task-summary.mjs
// Requires macOS Seatbelt, node:sqlite, and an installed Codex version accepted
// by the production no-tools policy. CORPTIE_PROBE_CODEX can select its binary.
// Uses synthetic fixtures in a disposable Store, never the product database.
// The only model endpoint is this process's loopback Responses fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import { createCodexAppServerProvider, CODEX_APP_SERVER_PROVIDER_ID } from "../src/agent-provider/providers/codexAppServerProvider.mjs";
import { BackgroundAgentService } from "../src/application/backgroundAgentService.mjs";
import { TaskSummaryService, SUMMARY_INSTRUCTIONS } from "../src/application/taskSummaryService.mjs";
import { TASK_SUMMARY_OUTPUT_SCHEMA, presentTaskSummary } from "../src/application/taskSummaryContract.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

const taskID = "task:synthetic-summary";
const sessionID = "session:synthetic-summary";
const messageID = "message:synthetic-agent";
const model = "gpt-5.4";
const summary = {
  focus: "Synthetic summary integration",
  progress: "Synthetic fixture work is complete.",
  intervention: "attention",
  reason: "Synthetic result is ready to read.",
  nextAction: "",
  sourceRefs: [messageID],
  suggestedTitle: "",
  messageSummary: "合成任务已完成。",
  targetMessageId: messageID
};

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await delay(25);
  }
}

function conversationSnapshot(store) {
  return {
    sessions: store.selectAll("SELECT * FROM sessions ORDER BY id"),
    items: store.selectAll("SELECT * FROM session_items ORDER BY session_id, id")
  };
}

async function main() {
  assert.equal(process.platform, "darwin", "This smoke requires macOS Seatbelt; there is no unsandboxed fallback.");
  await access("/usr/bin/sandbox-exec", constants.X_OK);
  const root = await realpath(await mkdtemp(join(tmpdir(), "corptie-task-summary-smoke-")));
  const workspace = join(root, "workspace");
  const runtime = join(root, "codex-home");
  const home = join(root, "home");
  const storeOptions = {
    dataRoot: join(root, "store"),
    dbPath: join(root, "store", "corptie.sqlite"),
    configPath: join(root, "store", "config.json"),
    rootSelectionPath: join(root, "store", "data-root.json"),
    manageProcessEnvironment: false
  };
  const requests = [];
  const rpcCalls = [];
  const providerCalls = [];
  const operationEvents = [];
  const warnings = [];
  let server;
  let serverFailure;
  let client;
  let child;
  let childExited;
  let store;
  let background;
  let service;
  let heartbeat;
  let requestCount = 0;
  let connectionCount = 0;
  const startedAt = Date.now();
  const diagnose = (stage, details = {}) => console.log(JSON.stringify({
    stage, elapsedMs: Date.now() - startedAt, requestCount, connectionCount,
    childStatus: !child ? "not-started" : child.exitCode != null || child.signalCode != null ? "exited" : "running",
    ...details
  }));
  try {
    for (const directory of [workspace, runtime, home]) await mkdir(directory, { mode: 0o700 });
    server = createServer((req, res) => {
      requestCount += 1;
      diagnose("http-request");
      void (async () => {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          assert.ok(size <= 1_000_000, "Unexpectedly large synthetic request");
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push({ path: req.url, body });
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/v1/responses", "Inherited MCP or other endpoints must not be contacted");
        assert.ok(requests.length <= 4, "Unexpected Responses retry loop");
        assert.equal(req.headers.authorization, undefined, "No real credentials may reach the fixture");
        assert.deepEqual(body.tools ?? [], []);
        assert.deepEqual(body.toolkits ?? [], []);
        assert.deepEqual(body.text?.format?.schema, TASK_SUMMARY_OUTPUT_SCHEMA);
        const item = {
          id: "msg_synthetic_summary", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: JSON.stringify(summary), annotations: [] }]
        };
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id: "resp_synthetic_summary", status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: "resp_synthetic_summary", status: "completed", output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
        diagnose("http-response-completed");
      })().catch((error) => {
        serverFailure ??= error;
        diagnose("http-request-rejected", { errorCode: error.code ?? error.name });
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Synthetic fixture rejected request" } }));
      });
    });
    server.on("connection", () => { connectionCount += 1; diagnose("http-connection"); });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    diagnose("loopback-listening");
    // Same clean CODEX_HOME/allowlisted env/Seatbelt pattern as the no-tools
    // probe, with HOME and process cwd isolated too. No ambient API keys,
    // proxies, provider settings, or repository-local configuration are passed.
    // Deliberately enable inherited tools/MCP; production must remove them for
    // this ephemeral thread, without mutating the shared runtime configuration.
    const flags = [
      "-c", 'model_provider="offline_summary_probe"', "-c", `model="${model}"`,
      "-c", `model_providers.offline_summary_probe={name="Offline summary probe",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`,
      "-c", "features.shell_tool=true", "-c", "tools.update_plan.enabled=true",
      "-c", "orchestrator.skills.enabled=true", "-c", "orchestrator.mcp.enabled=true",
      "-c", `mcp_servers.synthetic={url="http://127.0.0.1:${port}/mcp"}`
    ];
    client = new CodexAppServerClient({
      command: "/usr/bin/sandbox-exec",
      // Match the proven probe's loopback-only boundary. Restricting this to
      // the Responses port prevents this runtime from reaching the fixture;
      // non-loopback traffic remains denied and production no-tools is intact.
      args: ["-p", '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))',
        process.env.CORPTIE_PROBE_CODEX ?? "codex", ...flags, "app-server", "--listen", "stdio://"],
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: root, CODEX_HOME: runtime, RUST_LOG: "error" },
      requestTimeoutMs: 15_000,
      onNotification: ({ method, params }) => {
        if (["thread/started", "turn/started", "turn/completed", "error"].includes(method)) {
          diagnose("provider-notification", { method });
        }
        if (method === "error") {
          // This child has only synthetic input and no credentials. Keep the
          // transport cause, not request/config payloads or runtime stderr.
          const redact = (value) => String(value ?? "")
            .replaceAll(root, "<fixture>")
            .replace(/https?:\/\/[^\s)"']+/g, (url) => url.startsWith(`http://127.0.0.1:${port}/`)
              ? "<fixture-url>" : "<redacted-url>")
            .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "<redacted-credential>")
            .slice(0, 1500);
          diagnose("provider-error-detail", { message: redact(params?.error?.message),
            detail: redact(params?.error?.additionalDetails), willRetry: params?.willRetry === true });
          if (process.env.CORPTIE_PROBE_DIAGNOSTIC === "1") {
            serverFailure ??= Object.assign(new Error("Stopped after provider diagnostic"), { code: "PROVIDER_DIAGNOSTIC" });
          }
        }
      },
      spawnProcess: (command, args, options) => {
        child = spawn(command, args, { ...options, cwd: workspace });
        child.once("spawn", () => diagnose("child-spawned"));
        child.once("exit", (exitCode, signal) => diagnose("child-exited", { exitCode, signal }));
        child.once("error", (error) => diagnose("child-error", { errorCode: error.code ?? error.name }));
        childExited = new Promise((resolve) => {
          child.once("exit", resolve);
          child.once("error", resolve);
        });
        return child;
      }
    });
    const request = client.request.bind(client);
    client.request = async (...args) => {
      rpcCalls.push({ method: args[0], params: args[1] });
      const rpcStartedAt = Date.now();
      diagnose("rpc-start", { method: args[0] });
      try {
        const response = await request(...args);
        if (args[0] === "config/read") {
          diagnose("fixture-config", {
            selectedFixtureProvider: response.config?.model_provider === "offline_summary_probe",
            selectedFixtureModel: response.config?.model === model,
            fixtureEndpoint: response.config?.model_providers?.offline_summary_probe?.base_url === `http://127.0.0.1:${port}/v1`,
            isolatedCwd: args[1]?.cwd?.startsWith(root + sep) === true
          });
        }
        if (args[0] === "thread/start") {
          diagnose("fixture-thread", { selectedFixtureProvider: response.modelProvider === "offline_summary_probe",
            selectedFixtureModel: response.model === model });
        }
        diagnose("rpc-completed", { method: args[0], durationMs: Date.now() - rpcStartedAt });
        return response;
      } catch (error) {
        diagnose("rpc-failed", { method: args[0], durationMs: Date.now() - rpcStartedAt,
          errorCode: error.code ?? error.name });
        throw error;
      }
    };
    heartbeat = setInterval(() => diagnose("heartbeat", {
      lastRpcMethod: rpcCalls.at(-1)?.method ?? null, providerNotificationCount: client.notifications.length
    }), 10_000);
    heartbeat.unref();
    await client.initialize();
    const originalConfig = (await client.request("config/read", { includeLayers: false, cwd: workspace })).config;

    store = new CorptieStore(storeOptions);
    await store.initialize();
    const agent = store.createAgent({ id: "agent:synthetic-summary", name: "SyntheticSummary", workDir: workspace });
    store.createWork({ id: "work:synthetic-summary", name: "SyntheticSummary", contributorAgentIds: [agent.agentId] });
    store.createTask({ id: taskID, workId: "work:synthetic-summary", mainAgentId: agent.agentId,
      title: "SyntheticSummary", description: "Synthetic summary integration fixture.",
      acceptanceCriteria: "Persist the synthetic summary.", verificationCriteria: "Reopen the isolated Store." });
    store.createSession({ id: sessionID, title: "SyntheticSummary", provider: CODEX_APP_SERVER_PROVIDER_ID,
      agentId: agent.agentId, workId: "work:synthetic-summary", taskId: taskID,
      // Match initialized Store metadata: startup fills null sort_order values.
      // A persistence comparison must not mistake that unrelated normalization
      // for a hidden background summary modifying the conversation.
      sessionKind: "worker", status: "completed", cwd: workspace, sortOrder: 0 });
    store.upsertTimelineItemProjection(sessionID, { id: "message:synthetic-user", type: "userMessage",
      text: "Complete the synthetic fixture work.", createdAt: "2026-01-01T00:00:00.000Z" });
    store.upsertTimelineItemProjection(sessionID, { id: messageID, type: "agentMessage",
      text: "Synthetic fixture work is complete.", createdAt: "2026-01-01T00:00:01.000Z" });
    const originalTask = store.getTask(taskID);
    const originalConversation = conversationSnapshot(store);
    diagnose("store-fixture-ready");

    // Test-only composition root mirrors server.mjs's background operation.
    // No provider responses, service methods, repository writes, or validators
    // are stubbed; only the upstream model HTTP response is synthetic.
    const provider = createCodexAppServerProvider({ runBackgroundPrompt: async (input) => {
      providerCalls.push(input);
      assert.equal(input.executionPolicy, "no-tools");
      assert.equal(input.permissionProfile, "read-only");
      assert.equal(input.historyPolicy, "hidden");
      assert.deepEqual(input.allowedRoots, []);
      assert.ok(input.cwd.startsWith(join(store.layout.runtimeDirectory, "task-summary") + sep));
      return client.runEphemeralPrompt({
        cwd: input.cwd, runtimeWorkspaceRoots: input.allowedRoots, prompt: input.prompt,
        model: input.model, reasoningEffort: input.reasoningEffort, timeoutMs: input.timeoutMs,
        signal: input.signal, executionPolicy: input.executionPolicy, outputSchema: input.outputSchema,
        permissionProfile: input.permissionProfile, developerInstructions: input.developerInstructions,
        threadSource: input.purpose
      });
    } }, { capabilities: [AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT],
      metadata: { backgroundPermissionProfiles: ["read-only"] } });
    background = new BackgroundAgentService({ registry: new AgentProviderRegistry([provider]),
      defaultProviderId: CODEX_APP_SERVER_PROVIDER_ID,
      onOperationEvent: (type, payload) => {
        operationEvents.push({ type, ...payload });
        diagnose("background-operation", { type });
      } });
    service = new TaskSummaryService({ store, backgroundAgent: background, isEnabled: () => true,
      logger: { warn: (message) => warnings.push(message) } });
    assert.equal(service.request(taskID), true);
    assert.equal(service.repository.get(taskID).status, "dirty");
    diagnose("summary-queued");
    await waitFor(() => {
      if (serverFailure) throw serverFailure;
      const job = service.repository.get(taskID);
      if (["failed", "blocked", "cancelled"].includes(job?.status)) {
        diagnose("summary-terminal-failure", { status: job.status, errorCode: job.error_code });
        throw Object.assign(new Error("Task summary did not become ready"), { code: job.error_code ?? "SUMMARY_NOT_READY" });
      }
      return job?.status === "ready" && service.running.size === 0;
    }, 75_000, "TaskSummaryService ready and generation cleanup");
    service.close();
    diagnose("summary-ready-assertions");

    assert.deepEqual(warnings, []);
    assert.equal(providerCalls.length, 1);
    const input = providerCalls[0];
    assert.equal(input.purpose, "task-summary");
    assert.equal(input.developerInstructions, SUMMARY_INSTRUCTIONS);
    assert.deepEqual(input.outputSchema, TASK_SUMMARY_OUTPUT_SCHEMA);
    const context = JSON.parse(input.prompt);
    assert.equal(context.latestAgentMessage.id, messageID);
    assert.equal(context.latestUserMessage.id, "message:synthetic-user");
    assert.equal(context.definition.id, `task-definition:${taskID}:${originalTask.revision}`);
    assert.ok(requests.length > 0, "The actual Codex child must call the loopback Responses server");
    for (const { body } of requests) {
      assert.equal(body.model, model);
      assert.ok(JSON.stringify(body.input).includes("Synthetic fixture work is complete."));
    }
    const starts = rpcCalls.filter(({ method }) => method === "thread/start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].params.ephemeral, true);
    assert.deepEqual(starts[0].params.dynamicTools, []);
    assert.ok(rpcCalls.some(({ method }) => method === "thread/unsubscribe"));
    assert.equal(client.liveItemsByThread.size, 0);
    assert.deepEqual((await client.request("config/read", { includeLayers: false, cwd: workspace })).config, originalConfig);
    assert.deepEqual(await readdir(join(store.layout.runtimeDirectory, "task-summary")), []);
    assert.equal(background.activeControllers.size, 0);
    assert.deepEqual(operationEvents.map(({ type }) => type), ["BackgroundAgentStarted", "BackgroundAgentCompleted"]);

    const job = service.repository.get(taskID);
    const projection = JSON.parse(store.getTask(taskID).user_summary_json);
    const versions = store.selectAll("SELECT * FROM task_summary_versions WHERE task_id=?", [taskID]);
    assert.equal(versions.length, 1);
    assert.equal(projection.state, "ready");
    for (const [key, value] of Object.entries(summary)) assert.deepEqual(projection.content[key], value);
    assert.equal(projection.content.schemaVersion, 1);
    assert.equal(projection.content.providerID, CODEX_APP_SERVER_PROVIDER_ID);
    assert.equal(projection.content.operationID, job.operation_id);
    assert.equal(projection.content.generation, job.generation);
    assert.equal(operationEvents[1].operationId, job.operation_id);
    assert.equal(projection.content.inputHash,
      createHash("sha256").update(SUMMARY_INSTRUCTIONS).update("\n").update(input.prompt).digest("hex"));
    assert.equal(versions[0].input_hash, projection.content.inputHash);
    assert.equal(versions[0].basis_hash, job.basis_hash);
    assert.equal(versions[0].operation_id, job.operation_id);
    assert.deepEqual(JSON.parse(versions[0].content_json), projection.content);
    assert.equal(versions[0].content_hash,
      createHash("sha256").update(versions[0].content_json).digest("hex"));
    assert.deepEqual(conversationSnapshot(store), originalConversation, "Hidden summary must not create or change product chat");
    for (const key of ["title", "description", "acceptance_criteria", "verification_criteria", "lifecycle_state", "updated_at", "revision", "current_session_id"]) {
      assert.deepEqual(store.getTask(taskID)[key], originalTask[key], `Summary changed ${key}`);
    }
    assert.deepEqual(presentTaskSummary(store.getTask(taskID)), projection);

    // A second real Store connection proves durable history and visible state,
    // not merely a mocked complete() call or in-memory projection.
    diagnose("store-reopen");
    await store.close();
    store = new CorptieStore(storeOptions);
    await store.initialize();
    assert.deepEqual(JSON.parse(store.getTask(taskID).user_summary_json), projection);
    assert.deepEqual(presentTaskSummary(store.getTask(taskID)), projection);
    assert.deepEqual(store.selectOne("SELECT * FROM task_summary_jobs WHERE task_id=?", [taskID]), job);
    assert.deepEqual(store.selectAll("SELECT * FROM task_summary_versions WHERE task_id=?", [taskID]), versions);
    assert.deepEqual(conversationSnapshot(store), originalConversation);
    console.log(JSON.stringify({ passed: true, localOnly: true, requestCount: requests.length,
      runtime: client.runtimeUserAgent, persistedSummary: true, hiddenHistoryUnchanged: true,
      threadStateReleased: true, scratchRemoved: true }));
  } finally {
    clearInterval(heartbeat);
    diagnose("cleanup-start");
    service?.close();
    background?.close();
    try {
      // Let cancellation finish before closing its Store or deleting scratch.
      if (service) await waitFor(() => service.running.size === 0, 35_000, "cancelled summary cleanup");
    } finally {
      try {
        await client?.close();
        if (childExited) {
          const killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
          try { await childExited; } finally { clearTimeout(killTimer); }
        }
      } finally {
        try {
          if (server?.listening) {
            server.closeAllConnections();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          }
        } finally {
          try { await store?.close(); }
          finally {
            await rm(root, { recursive: true, force: true });
            diagnose("cleanup-completed");
          }
        }
      }
    }
  }
}

main().catch((error) => {
  // Do not dump captured prompts, request bodies, config, or runtime stderr.
  // Preserve the failing source location without the assertion's actual and
  // expected values (which can contain full captured prompts/configuration).
  const location = String(error.stack ?? "").split("\n").slice(1)
    .map((line) => line.match(/manual-codex-task-summary\.mjs:\d+:\d+/)?.[0])
    .find(Boolean) ?? "unknown location";
  console.error(`Task summary smoke failed: ${error.code ?? error.name} at ${location}`);
  process.exitCode = 1;
});
