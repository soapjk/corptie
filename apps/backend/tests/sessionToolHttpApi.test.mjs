import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { handleSessionToolHttpRequest } from "../src/application/sessionToolHttpApi.mjs";

function fixture() {
  const calls = [];
  const session = { id: "session", agentId: "agent", sessionKind: "workChat", workId: "work" };
  const metadata = { logicalSessionId: "logical", providerBindingId: "binding" };
  const dependencies = {
    store: { getSession: (id) => id === session.id ? session : null, listSessionsByAgent: () => [session] },
    collaborationCore: { getAgentForSession: () => ({ agentId: "agent" }) },
    toolHostService: {
      execute: async (input) => { calls.push(input); return { ok: true }; },
      catalogRevision: (input) => { calls.push(input); return "revision"; },
      observeGeneratedMcpToolsList: async (input) => { calls.push(input); return { tools: [] }; }
    },
    sessionToolMetadata: () => metadata,
    readJson: async (request) => {
      if (request.bodyError) throw request.bodyError;
      return request.body ?? {};
    },
    sendJson: (response, status, body) => response.resolve({ status, body }),
    errorStatus: (error, fallback) => Number.isInteger(error?.statusCode) ? error.statusCode : fallback
  };
  function dispatch(path, { method = "POST", headers = {}, body, bodyError } = {}) {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const handled = handleSessionToolHttpRequest({
      ...dependencies,
      request: { method, headers: {
        "x-corptie-agent-id": " agent ", "x-corptie-session-id": " session ",
        "x-corptie-provider-binding-id": " binding ", ...headers
      }, body, bodyError },
      response: { resolve }, url: new URL(path, "http://localhost")
    });
    return { handled, result };
  }
  return { calls, session, metadata, dependencies, dispatch };
}

test("Session tool dispatch keeps trimmed credentials and metadata", async () => {
  const f = fixture();
  const response = f.dispatch("/internal/session/tool", { body: { tool: "test.tool" } });
  assert.equal(response.handled, true);
  assert.deepEqual(await response.result, { status: 200, body: { ok: true } });
  assert.deepEqual(f.calls, [{ actorId: "agent", tool: "test.tool", arguments: {}, metadata: f.metadata }]);
});

test("Session tool requests reject stale bindings and untrusted header shapes before execution", async () => {
  for (const headers of [
    { "x-corptie-provider-binding-id": "stale" },
    { "x-corptie-agent-id": "other" },
    { "x-corptie-session-id": "missing" },
    { "x-corptie-agent-id": ["agent"] }
  ]) {
    for (const [path, method] of [["/internal/session/tool", "POST"], ["/internal/session/tool/catalog", "GET"]]) {
      const f = fixture();
      const result = await f.dispatch(path, { method, headers }).result;
      assert.equal(result.status, 403);
      assert.equal(result.body.code, "SESSION_TOOL_SCOPE_REQUIRED");
      assert.deepEqual(f.calls, []);
    }
  }
});

test("catalog revision and generated list preserve distinct response contracts", async () => {
  const f = fixture();
  assert.deepEqual(await f.dispatch("/internal/session/tool/catalog/revision", { method: "GET" }).result,
    { status: 200, body: { revision: "revision" } });
  assert.deepEqual(await f.dispatch("/internal/session/tool/catalog?desiredVersion=v2&observationId=probe", { method: "GET" }).result,
    { status: 200, body: { tools: [] } });
  assert.deepEqual(f.calls[1], { actorId: "agent", metadata: f.metadata, desiredVersion: "v2", observationId: "probe" });
});

test("tool body and execution failures preserve status and fallback error codes", async () => {
  const f = fixture();
  const invalid = await f.dispatch("/internal/session/tool", { bodyError: new SyntaxError("invalid JSON") }).result;
  assert.equal(invalid.status, 403);
  assert.equal(invalid.body.code, "SESSION_TOOL_FAILED");
  f.dependencies.toolHostService.execute = async () => { throw Object.assign(new Error("conflict"), { statusCode: 409, code: "CONFLICT" }); };
  assert.deepEqual(await f.dispatch("/internal/session/tool").result,
    { status: 409, body: { error: "conflict", code: "CONFLICT" } });
  f.dependencies.toolHostService.observeGeneratedMcpToolsList = async () => { throw new Error("catalog failed"); };
  assert.equal((await f.dispatch("/internal/session/tool/catalog", { method: "GET" }).result).body.code, "SESSION_TOOL_CATALOG_FAILED");
  f.dependencies.toolHostService.catalogRevision = () => { throw new Error("revision failed"); };
  assert.equal((await f.dispatch("/internal/session/tool/catalog/revision", { method: "GET" }).result).body.code, "SESSION_TOOL_CATALOG_FAILED");
});

test("Work Chat fallback resolves only a matching work and actor", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/internal/work-chat/tool", { body: { workId: "work", tool: "test.tool" } }).result).status, 200);
  assert.equal(f.calls.length, 1);
  for (const input of [
    { body: { workId: "other" } },
    { body: { workId: "work" }, headers: { "x-corptie-agent-id": "other" } }
  ]) {
    const result = await f.dispatch("/internal/work-chat/tool", input).result;
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "WORK_CHAT_SCOPE_REQUIRED");
  }
  assert.equal(f.calls.length, 1);
});

test("unmatched routes and methods fall through without response or execution", () => {
  const f = fixture();
  for (const [path, method] of [["/other", "POST"], ["/internal/session/tool", "GET"], ["/internal/session/tool/catalog", "DELETE"]]) {
    assert.equal(f.dispatch(path, { method }).handled, false);
  }
  assert.deepEqual(f.calls, []);
});

test("server mounts tool routes after the existing preview, readiness and maintenance guards", async () => {
  const source = await readFile(new URL("../src/application/backendHttpRouter.mjs", import.meta.url), "utf8");
  const route = source.slice(source.indexOf("function routeBackendHttpRequest(request, response, ports)"));
  const mount = route.indexOf("if (handleSessionToolHttpRequest({");
  assert.ok(mount > 0);
  for (const code of ["if (rejectDevelopmentPreviewWrite(", "if (rejectUnavailableStoreRequest("]) {
    assert.ok(route.indexOf(code) >= 0 && route.indexOf(code) < mount, code);
  }
});
