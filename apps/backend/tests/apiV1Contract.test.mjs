import assert from "node:assert/strict";
import test from "node:test";
import {
  API_V1_BASE_PATH,
  API_V1_VERSION,
  ApiV1ContractError,
  apiV1ActionRequestSchema,
  apiV1ActionResponseSchema,
  apiV1ErrorResponseSchema,
  apiV1EventSchema,
  apiV1JsonSchemas,
  apiV1OpenApiDocument,
  apiV1SessionSummarySchema,
  createApiV1Error,
  parseApiV1
} from "../src/http/apiV1Contract.mjs";

function sessionFixture(overrides = {}) {
  return {
    id: "codex:thread-1",
    title: "Implement API contract",
    agent: "Codex",
    status: "running",
    progress: 0.5,
    summary: "Working",
    activityStatus: "Running tests",
    updatedAt: "2026-07-26T12:00:00.000Z",
    accent: "cyan",
    capabilities: {
      canSend: true,
      canInterrupt: true
    },
    availableActions: [
      { id: "session.interrupt", enabled: true, risk: "medium" }
    ],
    external: {
      provider: "codex-app-server",
      threadId: "thread-1",
      cwd: "/workspace/corptie"
    },
    ...overrides
  };
}

test("session summary accepts the normalized Corptie model and preserves forward fields", () => {
  const parsed = parseApiV1(apiV1SessionSummarySchema, sessionFixture({
    futureField: "forward-compatible"
  }));

  assert.equal(parsed.id, "codex:thread-1");
  assert.equal(parsed.availableActions[0].id, "session.interrupt");
  assert.equal(parsed.futureField, "forward-compatible");
});

test("session summary rejects an invalid status and progress", () => {
  assert.throws(
    () => parseApiV1(apiV1SessionSummarySchema, sessionFixture({
      status: "waiting",
      progress: 2
    })),
    (error) => {
      assert.ok(error instanceof ApiV1ContractError);
      assert.equal(error.code, "API_V1_CONTRACT_INVALID");
      assert.ok(error.issues.length >= 2);
      return true;
    }
  );
});

test("action contract requires a supported action and accepts provider payload", () => {
  const action = parseApiV1(apiV1ActionRequestSchema, {
    action: "approval.respond",
    actionId: "approval-123",
    payload: {
      approved: true,
      optionId: "approve-once"
    }
  });

  assert.equal(action.action, "approval.respond");
  assert.equal(action.payload.optionId, "approve-once");
  assert.throws(() => parseApiV1(apiV1ActionRequestSchema, {
    action: "shell.execute",
    payload: {}
  }), ApiV1ContractError);
});

test("action response represents accepted and result-unknown operations", () => {
  for (const status of ["accepted", "result-unknown"]) {
    const response = parseApiV1(apiV1ActionResponseSchema, {
      apiVersion: API_V1_VERSION,
      operationId: `operation-${status}`,
      status,
      accepted: true,
      sessionRevision: 4,
      result: {}
    });
    assert.equal(response.status, status);
  }
});

test("SSE envelope requires a positive event id and stable schema version", () => {
  const event = parseApiV1(apiV1EventSchema, {
    schemaVersion: 1,
    eventId: 42,
    serverTime: "2026-07-26T12:00:00.000Z",
    type: "session.updated",
    sessionId: "codex:thread-1",
    sessionRevision: 3,
    payload: { status: "running" }
  });
  assert.equal(event.eventId, 42);

  assert.throws(() => parseApiV1(apiV1EventSchema, {
    schemaVersion: 2,
    eventId: 0,
    serverTime: "",
    type: "",
    payload: {}
  }), ApiV1ContractError);
});

test("versioned errors use stable HTTP mappings and do not expose Error objects", () => {
  const missing = createApiV1Error({
    code: "SESSION_NOT_FOUND",
    message: "Session not found.",
    requestId: "request-1",
    details: { sessionId: "codex:missing" }
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.error.code, "SESSION_NOT_FOUND");
  assert.equal(missing.body.error.retryable, false);
  assert.deepEqual(
    parseApiV1(apiV1ErrorResponseSchema, missing.body),
    missing.body
  );

  const unknown = createApiV1Error({
    code: "SOME_INTERNAL_EXCEPTION",
    message: ""
  });
  assert.equal(unknown.statusCode, 500);
  assert.equal(unknown.body.error.code, "INTERNAL_ERROR");
  assert.equal("stack" in unknown.body.error, false);
});

test("OpenAPI 3.1 document exposes generated JSON Schemas and versioned paths", () => {
  assert.equal(apiV1OpenApiDocument.openapi, "3.1.0");
  assert.equal(apiV1OpenApiDocument.info.version, API_V1_VERSION);
  assert.deepEqual(apiV1OpenApiDocument.servers, [{ url: API_V1_BASE_PATH }]);
  assert.ok(apiV1OpenApiDocument.paths["/sessions/{sessionId}/actions"]);

  for (const name of [
    "SessionSummary",
    "SessionDetail",
    "BootstrapResponse",
    "SessionsResponse",
    "SessionResponse",
    "ActionRequest",
    "ActionResponse",
    "Event",
    "ErrorResponse"
  ]) {
    assert.equal(apiV1JsonSchemas[name].$schema, "https://json-schema.org/draft/2020-12/schema");
  }
});
