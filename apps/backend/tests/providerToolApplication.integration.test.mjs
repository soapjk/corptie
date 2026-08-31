import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";
import { schemaHash } from "../src/application/hostToolCatalog.mjs";
import { OpenClackyManager } from "../src/adapters/openClackyManager.mjs";

const toolDefinitions = [{
  name: "corptie_tool_call",
  description: "Restricted Tool Host gateway",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
}];

test("Codex materialization confirmation is impossible before a successful real thread/start receipt", async () => {
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  assert.throws(() => client.confirmThreadToolPlan("thread:not-started", toolDefinitions), {
    code: "PROVIDER_TOOL_APPLICATION_UNCONFIRMED"
  });

  let request;
  client.request = async (method, params) => {
    request = { method, params };
    return { thread: { id: "thread:confirmed", createdAt: "2026-08-30T00:00:00.000Z" } };
  };
  await client.startThread({ dynamicTools: toolDefinitions, cwd: "/tmp/corptie-provider-test" });
  assert.equal(request.method, "thread/start");
  assert.deepEqual(request.params.dynamicTools, toolDefinitions);
  const confirmation = client.confirmThreadToolPlan("thread:confirmed", toolDefinitions);
  assert.match(confirmation.providerRevision, /^thread-start:thread:confirmed:/);
  assert.throws(() => client.confirmThreadToolPlan("thread:confirmed", []), {
    code: "PROVIDER_TOOL_APPLICATION_UNCONFIRMED"
  });
});

test("Codex restores an exact persisted Tool confirmation after app-server restart", () => {
  const client = new CodexAppServerClient();
  const restored = client.restoreThreadToolPlanConfirmation("thread:restored", toolDefinitions, {
    providerRevision: "thread-start:thread:restored:2026-08-30T00:00:00.000Z",
    allowLegacyRestrictedGateway: true
  });
  assert.equal(restored.restored, true);
  assert.deepEqual(client.confirmThreadToolPlan("thread:restored", toolDefinitions), restored);
  assert.throws(() => client.restoreThreadToolPlanConfirmation("thread:other", toolDefinitions, {
    providerRevision: restored.providerRevision,
    allowLegacyRestrictedGateway: true
  }), { code: "PROVIDER_TOOL_APPLICATION_UNCONFIRMED" });
  assert.throws(() => client.restoreThreadToolPlanConfirmation("thread:restored", [], {
    providerRevision: restored.providerRevision,
    providerDefinitionsHash: restored.providerDefinitionsHash
  }), { code: "PROVIDER_TOOL_APPLICATION_UNCONFIRMED" });
});

test("Codex accepts an exact durable Tool-definition hash without the legacy exception", () => {
  const client = new CodexAppServerClient();
  const confirmation = client.restoreThreadToolPlanConfirmation("thread:hashed", toolDefinitions, {
    providerRevision: "thread-start:thread:hashed:confirmed",
    providerDefinitionsHash: schemaHash(toolDefinitions)
  });
  assert.equal(confirmation.restored, true);
  assert.equal(confirmation.providerDefinitionsHash, schemaHash(toolDefinitions));
});

test("OpenClacky gateway requires an explicit applied generation from the bridge", async () => {
  const requests = [];
  const manager = new OpenClackyManager({
    baseURL: "http://127.0.0.1:7070",
    ensureRuntime: async () => {},
    issueToolHostToken: async () => ({ token: "bound-session-token" }),
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        tool_host_receipt: { applied: true, generation: 7, receipt_id: "bridge-receipt:7" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const confirmation = await manager.applyConfirmedToolHost("provider-session", {
    actorId: "agent:one",
    metadata: { logicalSessionId: "logical:one", providerBindingId: "binding:one" },
    providerAttachment: { kind: "corptie_call", tools: toolDefinitions }
  });
  assert.deepEqual(confirmation, { providerRevision: "7", receiptId: "bridge-receipt:7" });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/sessions\/provider-session\/corptie\/tool-host$/);
  assert.equal(JSON.parse(requests[0].init.body).token, "bound-session-token");
});

test("OpenClacky gateway fails closed when the bridge only acknowledges registration", async () => {
  const manager = new OpenClackyManager({
    issueToolHostToken: async () => "bound-session-token",
    fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  });
  await assert.rejects(() => manager.applyConfirmedToolHost("provider-session", {
    actorId: "agent:one",
    metadata: { logicalSessionId: "logical:one", providerBindingId: "binding:one" },
    providerAttachment: { kind: "corptie_call", tools: toolDefinitions }
  }), { code: "PROVIDER_TOOL_APPLICATION_UNCONFIRMED" });
  assert.equal(manager.toolHosts.has("provider-session"), false);
});
