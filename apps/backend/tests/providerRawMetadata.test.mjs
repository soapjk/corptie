import assert from "node:assert/strict";
import test from "node:test";
import { providerRawMetadataJSON, providerSafeToolText } from "../src/utils/providerRawMetadata.mjs";

test("provider raw metadata preserves diagnostic fields and redacts credentials", () => {
  const parsed = JSON.parse(providerRawMetadataJSON("provider-a", {
    id: "item-1",
    command: "npm test",
    cwd: "/repo",
    authorization: "Bearer secret",
    nested: { api_key: "secret", status: "running" }
  }));

  assert.equal(parsed.provider, "provider-a");
  assert.equal(parsed.source, "provider_item");
  assert.equal(parsed.payload.command, "npm test");
  assert.equal(parsed.payload.cwd, "/repo");
  assert.equal(parsed.payload.authorization, "[REDACTED]");
  assert.equal(parsed.payload.nested.api_key, "[REDACTED]");
  assert.equal(parsed.payload.nested.status, "running");
});

test("provider raw metadata marks oversized and circular values instead of failing", () => {
  const payload = { output: "x".repeat(8_100) };
  payload.self = payload;

  const parsed = JSON.parse(providerRawMetadataJSON("provider-a", payload));

  assert.match(parsed.payload.output, /truncated 100 characters/);
  assert.equal(parsed.payload.self, "[circular reference]");
});

test("tool text redacts credentials in JSON strings and inline assignments without hiding ordinary commands", () => {
  const json = '{"apiKey":"must-not-leak","nested":{"password":"also-secret"},"query":"safe"}';
  const preview = providerSafeToolText(json);
  assert.deepEqual(JSON.parse(preview), {
    apiKey: "[REDACTED]", nested: { password: "[REDACTED]" }, query: "safe"
  });
  assert.equal(providerSafeToolText("pwd"), "pwd");
  assert.equal(providerSafeToolText("API_KEY=must-not-leak npm test"), "API_KEY=[REDACTED] npm test");
  assert.equal(providerSafeToolText("Authorization: Bearer must-not-leak"), "authorization=[REDACTED]");
  const metadata = JSON.parse(providerRawMetadataJSON("provider-a", { resultPreview: json }));
  assert.doesNotMatch(metadata.payload.resultPreview, /must-not-leak|also-secret/);
});
