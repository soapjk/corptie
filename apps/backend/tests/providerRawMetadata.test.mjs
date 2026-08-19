import assert from "node:assert/strict";
import test from "node:test";
import { providerRawMetadataJSON } from "../src/utils/providerRawMetadata.mjs";

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
