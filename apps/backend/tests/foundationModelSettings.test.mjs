import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FoundationModelSettings, validateFoundationSettings, invokeFoundationAPI } from "../src/application/foundationModelSettings.mjs";
import { BackgroundAgentService } from "../src/application/backgroundAgentService.mjs";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";

test("settings persist but keys never appear in public responses", () => {
  const root = mkdtempSync(join(tmpdir(), "corptie-foundation-"));
  try {
    const settings = new FoundationModelSettings(root);
    const result = settings.save({ mode: "api", baseURL: "https://example.invalid/v1", model: "synthetic", apiKey: "synthetic-key" });
    assert.equal(result.hasApiKey, true); assert.equal(result.apiKey, undefined);
    assert.equal(statSync(settings.path).mode & 0o777, 0o600);
    assert.equal(new FoundationModelSettings(root).value.apiKey, "synthetic-key");
    settings.save({ model: "other" }); assert.equal(settings.value.apiKey, "synthetic-key");
    settings.save({ baseURL: "https://other.invalid/v1" }); assert.equal(settings.value.apiKey, "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("API endpoint rejects cleartext remote URLs and credential URLs", () => {
  for (const baseURL of ["http://example.invalid", "file:///tmp/test", "https://secret@example.invalid", "https://example.invalid/?key=secret"]) {
    assert.throws(() => validateFoundationSettings({ mode: "api", baseURL, model: "synthetic" }));
  }
  assert.equal(validateFoundationSettings({ mode: "api", baseURL: "http://127.0.0.1:1234/v1", model: "synthetic" }).mode, "api");
});

test("API uses configured model/reasoning/schema with no tools and disallows redirects", async () => {
  const controller = new AbortController();
  const result = await invokeFoundationAPI({ baseURL: "https://example.invalid/v1/", model: "synthetic", reasoning: "high", apiKey: "test" },
    { prompt: "synthetic input", developerInstructions: "synthetic instruction", signal: controller.signal, outputSchema: { type: "object" } },
    async (url, options) => {
      assert.equal(url, "https://example.invalid/v1/chat/completions");
      assert.equal(options.redirect, "error"); assert.equal(options.signal, controller.signal);
      const body = JSON.parse(options.body);
      assert.equal(body.model, "synthetic"); assert.equal(body.reasoning_effort, "high");
      assert.equal(body.tools, undefined); assert.equal(body.response_format.type, "json_schema");
      return Response.json({ choices: [{ message: { content: "synthetic output" } }] });
    });
  assert.equal(result.text, "synthetic output");
});

test("API rejects tool calls, malformed responses and does not echo error bodies", async () => {
  const config = { baseURL: "https://example.invalid/v1", model: "synthetic" };
  await assert.rejects(invokeFoundationAPI(config, { prompt: "x" }, async () => new Response("secret body", { status: 401 })),
    error => error.message === "Background API HTTP 401");
  await assert.rejects(invokeFoundationAPI(config, { prompt: "x" }, async () => new Response("secret invalid JSON")),
    error => !error.message.includes("secret"));
  await assert.rejects(invokeFoundationAPI(config, { prompt: "x" }, async () => Response.json({ choices: [{ message: { content: "x", tool_calls: [{}] } }] })),
    { code: "BACKGROUND_API_INVALID_OUTPUT" });
});

test("API cancellation forwards to transport", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(invokeFoundationAPI({ baseURL: "https://example.invalid", model: "synthetic" },
    { prompt: "x", signal: controller.signal }, async (_url, options) => { options.signal.throwIfAborted(); }), { name: "AbortError" });
});

test("background capability settings override helper models but not recovery sessions", async () => {
  const calls = [];
  const registry = new AgentProviderRegistry(["one", "two"].map(id => new CallbackAgentProvider({
    id, displayName: id, transport: "fake", capabilities: ["background.prompt"],
    metadata: { backgroundExecutionPolicies: ["no-tools"] }
  }, { runBackgroundPrompt: async input => { calls.push({ id, input }); return { text: "ok" }; } })));
  const service = new BackgroundAgentService({ registry, defaultProviderId: "one",
    getModelSettings: () => ({ mode: "provider", providerId: "two", model: "chosen", reasoning: "high" }) });
  try {
    await service.run({ purpose: "task-summary", prompt: "x", cwd: "/synthetic", preferredModel: "old", preferredReasoning: "low", executionPolicy: "no-tools" });
    assert.equal(calls[0].id, "two"); assert.equal(calls[0].input.model, "chosen"); assert.equal(calls[0].input.reasoningEffort, "high");
    await service.run({ purpose: "session-recovery-handoff", prompt: "x", cwd: "/synthetic", preferredProviderId: "one", preferredModel: "original" });
    assert.equal(calls[1].id, "one"); assert.equal(calls[1].input.model, "original");
    assert.equal(service.defaultProviderId, "one"); assert.equal(service.capabilityProviderId(), "two");
  } finally { service.close(); }
});
