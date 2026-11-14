import assert from "node:assert/strict";
import test from "node:test";
import { handleMcpRegistryHttpRequest } from "../src/application/mcpRegistryHttpApi.mjs";

function response() {
  return { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
}

test("Computer Use discovery is explicit, local-only, and does not install or grant access", async () => {
  let checks = 0;
  const preset = { runtime: { status: "missing_native_service", errorCode: "COMPUTER_USE_NATIVE_SERVICE_MISSING" }, config: null };
  const options = { request: { method: "GET", headers: {} }, response: response(),
    url: new URL("http://localhost/mcp-servers/computer-use"),
    computerUsePreset: async () => { checks += 1; return preset; } };
  await handleMcpRegistryHttpRequest(options);
  assert.equal(checks, 1);
  assert.equal(options.response.status, 200);
  assert.deepEqual(options.response.body, preset);
  const blocked = { ...options, request: { method: "GET", headers: { origin: "https://untrusted.test" } }, response: response() };
  await handleMcpRegistryHttpRequest(blocked);
  assert.equal(checks, 1);
  assert.equal(blocked.response.status, 403);
});
