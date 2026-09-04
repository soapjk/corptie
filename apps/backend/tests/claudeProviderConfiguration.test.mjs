import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeConnectionTestOptions,
  claudeSdkResultError,
  normalizeClaudeProviderError,
  redactClaudeSecrets,
  validateClaudeProviderConfiguration
} from "../src/agent-provider/providers/claudeProviderConfiguration.mjs";
import { createClaudeAgentSdkProvider } from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";

test("Claude Provider declares the common configuration and connection-test capabilities", () => {
  const provider = createClaudeAgentSdkProvider({ testConnection: async () => ({ ok: true }) }, {
    environment: () => ({ ANTHROPIC_API_KEY: "sk-ant-environment-key-1234567890" })
  });

  assert.ok(provider.descriptor.capabilities.includes("configuration.validate"));
  assert.ok(provider.descriptor.capabilities.includes("connection.test"));
  assert.deepEqual(
    provider.descriptor.configuration.fields.map((field) => [field.id, field.type]),
    [
      ["apiKey", "secret"],
      ["model", "string"],
      ["timeoutMs", "integer"],
      ["maxTurns", "integer"],
      ["maxBudgetUsd", "number"]
    ]
  );
  assert.equal(provider.descriptor.configuration.fields[0].persisted, false);
  assert.equal(provider.validateConfiguration({}).configuration.apiKey.source, "environment");
});

test("Claude configuration validation accepts bounded request options without returning the API Key", () => {
  const apiKey = "sk-ant-request-key-12345678901234567890";
  const result = validateClaudeProviderConfiguration({
    apiKey,
    model: "claude-sonnet-4-6",
    timeoutMs: 8_000,
    maxTurns: 4,
    maxBudgetUsd: 2.5
  });

  assert.equal(result.valid, true);
  assert.equal(result.configuration.apiKey.configured, true);
  assert.equal(result.configuration.apiKey.source, "request");
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test("Claude configuration validation rejects malformed credentials and request bounds", () => {
  const result = validateClaudeProviderConfiguration({
    apiKey: "short key",
    model: "bad\nmodel",
    timeoutMs: 100,
    maxTurns: 0,
    maxBudgetUsd: -1
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.field), [
    "apiKey", "model", "timeoutMs", "maxTurns", "maxBudgetUsd"
  ]);
  assert.throws(
    () => claudeConnectionTestOptions({ timeoutMs: 100 }),
    (error) => error.code === "CLAUDE_CONFIGURATION_INVALID"
  );
});

test("Claude connection options pass the API Key only to the ephemeral SDK environment", () => {
  const apiKey = "sk-ant-ephemeral-key-12345678901234567890";
  const resolved = claudeConnectionTestOptions({ apiKey, model: "claude-opus-4-1" }, {
    environment: { PATH: "/usr/bin" }
  });

  assert.equal(resolved.queryOptions.env.ANTHROPIC_API_KEY, apiKey);
  assert.equal(resolved.queryOptions.model, "claude-opus-4-1");
  assert.equal(resolved.queryOptions.persistSession, false);
  assert.equal(resolved.queryOptions.maxTurns, 1);
  assert.equal(JSON.stringify(resolved.validation).includes(apiKey), false);
});

test("Claude errors classify authentication, permission, rate limits, timeout, network, and server failures", () => {
  const cases = [
    [{ status: 401, message: "unauthorized" }, "AUTHENTICATION_FAILED", false],
    [{ status: 403, message: "forbidden" }, "PERMISSION_DENIED", false],
    [{ status: 429, message: "too many requests" }, "RATE_LIMITED", true],
    [{ name: "AbortError", message: "request timed out" }, "REQUEST_TIMEOUT", true],
    [{ code: "ECONNRESET", message: "socket closed" }, "NETWORK_ERROR", true],
    [{ status: 503, message: "service unavailable" }, "PROVIDER_SERVICE_ERROR", true]
  ];
  for (const [input, code, retryable] of cases) {
    const error = normalizeClaudeProviderError(input);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
  }
});

test("Claude SDK error results are safe and secrets are redacted from arbitrary diagnostic text", () => {
  const apiKey = "sk-ant-secret-value-12345678901234567890";
  const error = claudeSdkResultError({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: [`401 invalid api key ${apiKey}`]
  }, { secretValues: [apiKey] });

  assert.equal(error.code, "AUTHENTICATION_FAILED");
  assert.equal(error.message.includes(apiKey), false);
  assert.equal(redactClaudeSecrets(`Authorization: Bearer ${apiKey}`, [apiKey]).includes(apiKey), false);
});
