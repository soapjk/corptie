// Explicitly opt-in, synthetic, loopback-only protocol inspection. No real login
// or product data is read. macOS Seatbelt prevents Internet access by the child.
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";
import { TASK_SUMMARY_OUTPUT_SCHEMA, validateTaskSummaryOutput } from "../src/application/taskSummaryContract.mjs";

const summary = { focus: "Synthetic task", progress: "Synthetic progress", intervention: "unknown",
  reason: "Synthetic context", nextAction: "", sourceRefs: ["synthetic:message"] };
const summaryText = JSON.stringify(summary);

const root = await mkdtemp(join(tmpdir(), "corptie-no-tools-probe-"));
const scratch = join(root, "workspace");
const runtime = join(root, "runtime");
await mkdir(scratch);
await mkdir(runtime);
const requests = [];
const cancellation = new AbortController();
const methods = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  let body;
  try { body = JSON.parse(raw); } catch { body = {}; }
  requests.push({ path: req.url, body });
  console.log(JSON.stringify({ path: req.url, keys: Object.keys(body), tools: body.tools,
    toolkits: body.toolkits, toolChoice: body.tool_choice }));
  if (process.env.CORPTIE_PROBE_CANCEL === "1") {
    cancellation.abort(Object.assign(new Error("Synthetic cancellation"), { code: "BACKGROUND_CANCELLED" }));
    return;
  }
  const tool = process.env.CORPTIE_PROBE_TOOL;
  const item = tool && requests.length === 1
    ? { id: "call_synthetic", type: "function_call", call_id: "call_synthetic", name: tool,
      arguments: JSON.stringify({ cmd: "pwd", command: "pwd", authority: { kind: "orchestrator" } }) }
    : { id: "msg_synthetic", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: summaryText, annotations: [] }] };
  if (requests.length > 1) console.log(JSON.stringify({ toolOutputs: body.input?.filter((item) => item.type?.includes("call_output")) }));
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: "resp_synthetic", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_synthetic", status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
// Only synthetic provider selection belongs to the test. The tool policy is
// supplied by the production runEphemeralPrompt path, not duplicated here.
const flags = ["-c", 'model_provider="offline_probe"', "-c", 'model="gpt-5.4"',
  "-c", `model_providers.offline_probe={name="Offline probe",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`];
if (process.env.CORPTIE_PROBE_INHERIT === "1") flags.push(
  "-c", "features.shell_tool=true", "-c", "tools.update_plan.enabled=true",
  "-c", "orchestrator.skills.enabled=true", "-c", "orchestrator.mcp.enabled=true",
  "-c", `mcp_servers.synthetic={url="http://127.0.0.1:${port}/mcp"}`
);
const client = new CodexAppServerClient({
  command: "/usr/bin/sandbox-exec",
  args: ["-p", '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))',
    process.env.CORPTIE_PROBE_CODEX ?? "codex",
    ...flags, "app-server", "--listen", "stdio://"],
  env: { PATH: process.env.PATH, TMPDIR: root, CODEX_HOME: runtime, RUST_LOG: "error" },
  requestTimeoutMs: 15_000
});
const rpc = client.request.bind(client);
client.request = async (...args) => {
  methods.push(args[0]);
  const response = await rpc(...args);
  if (args[0] === "initialize") console.log(JSON.stringify({ initialize: response }));
  return response;
};
try {
  await client.initialize();
  const originalConfig = (await client.request("config/read", { includeLayers: false })).config;
  const operation = client.runEphemeralPrompt({ cwd: scratch, executionPolicy: "no-tools",
    permissionProfile: "read-only", prompt: "Return synthetic JSON.", timeoutMs: 15_000,
    outputSchema: TASK_SUMMARY_OUTPUT_SCHEMA,
    signal: cancellation.signal, model: process.env.CORPTIE_PROBE_MODEL ?? "gpt-5.4" });
  if (process.env.CORPTIE_PROBE_CANCEL === "1") {
    await assert.rejects(operation, { code: "BACKGROUND_CANCELLED" });
    assert.ok(methods.includes("turn/interrupt"));
    assert.ok(methods.includes("thread/unsubscribe"));
    assert.equal(client.liveItemsByThread.size, 0);
    console.log(JSON.stringify({ passed: true, cancelled: true, threadStateReleased: true }));
  } else {
  const result = await operation;
  assert.equal(result.text, summaryText);
  assert.equal(validateTaskSummaryOutput(result.text, { allowedSources: new Set(["synthetic:message"]) }).focus, summary.focus);
  assert.ok(requests.length > 0);
  for (const { path, body } of requests) {
    assert.equal(path, "/v1/responses", "No inherited MCP may initialize");
    assert.deepEqual(body.tools ?? [], []);
    assert.deepEqual(body.toolkits ?? [], []);
    assert.deepEqual(body.text?.format?.schema, TASK_SUMMARY_OUTPUT_SCHEMA);
  }
  if (process.env.CORPTIE_PROBE_TOOL) {
    assert.ok(requests.some(({ body }) => body.input?.some((item) =>
      item.type === "function_call_output" && String(item.output).includes("unsupported call"))));
  }
  assert.equal(client.liveItemsByThread.has(result.threadId), false);
  if (process.env.CORPTIE_PROBE_INHERIT === "1") {
    const after = await client.request("config/read", { includeLayers: false });
    assert.deepEqual(after.config, originalConfig, "Temporary thread must not mutate shared config");
  }
  console.log(JSON.stringify({ passed: true, requestCount: requests.length, runtime: client.runtimeUserAgent,
    threadStateReleased: true }));
  }
} catch (error) {
  console.error(error.message);
  console.error(JSON.stringify(client.notifications.filter((event) => event.method === "stderr").slice(-8)));
  process.exitCode = 1;
} finally {
  await client.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
