import { z } from "zod";

export const API_V1_VERSION = "1";
export const API_V1_BASE_PATH = "/api/v1";

const nonEmptyString = z.string().trim().min(1);
const nullableString = z.string().nullable().optional();
const jsonObject = z.record(z.string(), z.unknown());

export const apiV1TaskStatusSchema = z.enum([
  "running",
  "blocked",
  "complete",
  "failed",
  "cancelled"
]);

export const apiV1RiskSchema = z.enum(["low", "medium", "high"]);

export const apiV1CapabilitySchema = z.object({
  canSend: z.boolean().optional(),
  canSwitchModel: z.boolean().optional(),
  canSwitchReasoning: z.boolean().optional(),
  canInterrupt: z.boolean().optional(),
  canReconnect: z.boolean().optional()
}).passthrough();

export const apiV1AvailableActionSchema = z.object({
  id: nonEmptyString,
  enabled: z.boolean(),
  risk: apiV1RiskSchema,
  reason: nullableString
}).passthrough();

export const apiV1ApprovalOptionSchema = z.object({
  id: nonEmptyString,
  label: nonEmptyString,
  role: nullableString,
  index: z.number().int().nullable().optional(),
  selected: z.boolean().nullable().optional()
}).passthrough();

export const apiV1SessionExternalSchema = z.object({
  provider: nonEmptyString,
  threadId: nullableString,
  sessionId: nullableString,
  agentSessionId: nullableString,
  connectionStatus: nullableString,
  currentModel: nullableString,
  currentReasoningLevel: nullableString,
  cwd: nullableString,
  sandbox: nullableString,
  approvalPolicy: nullableString,
  source: nullableString
}).passthrough();

export const apiV1SessionSummarySchema = z.object({
  id: nonEmptyString,
  title: nonEmptyString,
  agent: nonEmptyString,
  status: apiV1TaskStatusSchema,
  progress: z.number().min(0).max(1),
  summary: z.string(),
  suggestedOptions: z.array(apiV1ApprovalOptionSchema).nullable().optional(),
  suggestedPrompt: nullableString,
  activityStatus: nullableString,
  updatedAt: nonEmptyString,
  accent: z.enum(["cyan", "mint", "violet", "amber"]),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  sortOrder: z.number().nullable().optional(),
  avatarUrl: nullableString,
  capabilities: apiV1CapabilitySchema.nullable().optional(),
  availableActions: z.array(apiV1AvailableActionSchema).default([]),
  external: apiV1SessionExternalSchema.nullable().optional()
}).passthrough();

export const apiV1FileChangeSchema = z.object({
  path: nonEmptyString,
  kind: nonEmptyString
}).passthrough();

export const apiV1ThreadItemSchema = z.object({
  id: nonEmptyString,
  turnId: z.string(),
  turnStatus: z.string(),
  type: nonEmptyString,
  title: z.string(),
  text: z.string(),
  options: z.array(apiV1ApprovalOptionSchema).nullable().optional(),
  status: nullableString,
  createdAt: nullableString,
  sourceType: nullableString,
  localVisibility: nullableString,
  workItemId: nullableString,
  collaborationTaskId: nullableString,
  presentationRole: nullableString,
  presentationText: nullableString,
  collaborationDirection: nullableString,
  collaborationSenderAgentId: nullableString,
  collaborationSenderName: nullableString,
  collaborationRecipientAgentId: nullableString,
  collaborationRecipientName: nullableString,
  collaborationTaskTitle: nullableString,
  collaborationMessageKind: nullableString,
  collaborationProcessingStatus: nullableString,
  collaborationConfirmationId: nullableString,
  collaborationConfirmationStatus: nullableString,
  collaborationAcceptanceCriteria: z.array(z.string()).nullable().optional(),
  fileChanges: z.array(apiV1FileChangeSchema).nullable().optional(),
  turnDiff: nullableString
}).passthrough();

export const apiV1SessionDetailSchema = z.object({
  id: nonEmptyString,
  title: nonEmptyString,
  status: apiV1TaskStatusSchema,
  source: nullableString,
  connectionStatus: nullableString,
  currentModel: nullableString,
  currentReasoningLevel: nullableString,
  activityStatus: nullableString,
  cwd: nullableString,
  createdAt: nonEmptyString,
  updatedAt: nonEmptyString,
  canSend: z.boolean().optional(),
  sendUnavailableReason: nullableString,
  capabilities: apiV1CapabilitySchema.nullable().optional(),
  availableActions: z.array(apiV1AvailableActionSchema).default([]),
  turnCount: z.number().int().nonnegative(),
  items: z.array(apiV1ThreadItemSchema)
}).passthrough();

export const apiV1DeviceSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  permission: z.enum(["read-only", "reply", "full-control"]),
  createdAt: nonEmptyString,
  lastSeenAt: nullableString
}).passthrough();

export const apiV1FeatureFlagsSchema = z.object({
  attention: z.boolean(),
  collaboration: z.boolean(),
  diff: z.boolean(),
  pwa: z.boolean(),
  notifications: z.boolean()
}).passthrough();

export const apiV1BootstrapResponseSchema = z.object({
  apiVersion: z.literal(API_V1_VERSION),
  environment: z.enum(["development", "production"]),
  serverTime: nonEmptyString,
  eventCursor: z.number().int().nonnegative(),
  csrfToken: nonEmptyString,
  device: apiV1DeviceSchema,
  features: apiV1FeatureFlagsSchema,
  preferences: z.object({
    language: z.enum(["en", "zh-Hans"]).optional(),
    theme: z.enum(["system", "light", "dark"]).optional()
  }).passthrough(),
  creation: z.object({
    workspaces: z.array(z.object({ path: nonEmptyString, name: nonEmptyString })),
    agents: z.array(z.enum(["codex", "claude"])),
    models: z.object({
      codex: z.array(z.object({ id: nonEmptyString, name: nonEmptyString })),
      claude: z.array(z.object({ id: nonEmptyString, name: nonEmptyString }))
    }),
    defaults: z.object({
      agent: z.enum(["codex", "claude"]),
      workspace: nullableString,
      codexModel: nullableString,
      claudeModel: nullableString,
      reasoningLevel: nullableString,
      sandbox: z.enum(["workspace-write", "danger-full-access", "read-only"]),
      approvalPolicy: z.enum(["on-request", "ask-risky", "never", "on-failure"])
    })
  })
}).passthrough();

export const apiV1SessionsResponseSchema = z.object({
  apiVersion: z.literal(API_V1_VERSION),
  eventCursor: z.number().int().nonnegative(),
  sessions: z.array(apiV1SessionSummarySchema)
});

export const apiV1AttentionKindSchema = z.enum([
  "high-risk-approval",
  "collaboration-confirmation",
  "input-required",
  "failure",
  "disconnected",
  "approval",
  "completed-unread"
]);

export const apiV1AttentionItemSchema = z.object({
  id: nonEmptyString,
  kind: apiV1AttentionKindSchema,
  priority: z.number().int().min(1).max(6),
  sessionId: nonEmptyString,
  sessionTitle: nonEmptyString,
  agent: nonEmptyString,
  summary: z.string(),
  updatedAt: nonEmptyString,
  contextItemId: nullableString,
  actionContext: jsonObject.optional(),
  availableActions: z.array(apiV1AvailableActionSchema).default([])
});

export const apiV1AttentionResponseSchema = z.object({
  apiVersion: z.literal(API_V1_VERSION),
  eventCursor: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  runningCount: z.number().int().nonnegative(),
  items: z.array(apiV1AttentionItemSchema)
});

export const apiV1SessionResponseSchema = z.object({
  apiVersion: z.literal(API_V1_VERSION),
  eventCursor: z.number().int().nonnegative(),
  session: apiV1SessionDetailSchema
});

export const apiV1CreateSessionRequestSchema = z.object({
  workspace: nonEmptyString,
  agent: z.enum(["codex", "claude"]),
  model: nonEmptyString.optional(),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  sandbox: z.enum(["workspace-write", "danger-full-access", "read-only"]),
  approvalPolicy: z.enum(["on-request", "ask-risky", "never", "on-failure"]),
  prompt: nonEmptyString.max(100_000),
  title: z.string().trim().max(200).optional()
});

export const apiV1ActionNameSchema = z.enum([
  "message.send",
  "session.interrupt",
  "session.reconnect",
  "session.archive",
  "session.unarchive",
  "session.pin",
  "session.rename",
  "session.delete",
  "session.model.set",
  "session.reasoning.set",
  "session.permissions.set",
  "choice.respond",
  "approval.respond",
  "collaboration.confirm",
  "collaboration.reject",
  "turn.diff.open-on-mac",
  "turn.diff.undo"
]);

export const apiV1ActionRequestSchema = z.object({
  action: apiV1ActionNameSchema,
  actionId: nonEmptyString.optional(),
  payload: jsonObject.default({})
});

export const apiV1OperationStatusSchema = z.enum([
  "accepted",
  "succeeded",
  "failed",
  "result-unknown"
]);

export const apiV1ActionResponseSchema = z.object({
  apiVersion: z.literal(API_V1_VERSION),
  operationId: nonEmptyString,
  status: apiV1OperationStatusSchema,
  accepted: z.boolean(),
  sessionRevision: z.number().int().nonnegative().nullable(),
  result: jsonObject.default({})
});

export const apiV1EventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.number().int().positive(),
  serverTime: nonEmptyString,
  type: nonEmptyString,
  sessionId: nullableString,
  sessionRevision: z.number().int().nonnegative().nullable().optional(),
  payload: jsonObject
});

export const apiV1ErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "AUTHENTICATION_REQUIRED",
  "AUTHENTICATION_EXPIRED",
  "DEVICE_REVOKED",
  "PAIRING_CODE_INVALID",
  "PAIRING_CODE_EXPIRED",
  "CSRF_INVALID",
  "ORIGIN_NOT_ALLOWED",
  "SESSION_NOT_FOUND",
  "SESSION_BUSY",
  "ACTION_NOT_AVAILABLE",
  "ACTION_EXPIRED",
  "IDEMPOTENCY_CONFLICT",
  "RESYNC_REQUIRED",
  "RATE_LIMITED",
  "INTERNAL_ERROR"
]);

export const apiV1ErrorResponseSchema = z.object({
  apiVersion: z.literal(API_V1_VERSION),
  error: z.object({
    code: apiV1ErrorCodeSchema,
    message: nonEmptyString,
    requestId: nullableString,
    retryable: z.boolean(),
    details: jsonObject.optional()
  })
});

export const API_V1_ERROR_STATUS_BY_CODE = Object.freeze({
  INVALID_REQUEST: 400,
  AUTHENTICATION_REQUIRED: 401,
  AUTHENTICATION_EXPIRED: 401,
  DEVICE_REVOKED: 401,
  PAIRING_CODE_INVALID: 401,
  PAIRING_CODE_EXPIRED: 401,
  CSRF_INVALID: 403,
  ORIGIN_NOT_ALLOWED: 403,
  SESSION_NOT_FOUND: 404,
  SESSION_BUSY: 409,
  ACTION_NOT_AVAILABLE: 409,
  ACTION_EXPIRED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RESYNC_REQUIRED: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500
});

export class ApiV1ContractError extends Error {
  constructor(message, issues) {
    super(message);
    this.name = "ApiV1ContractError";
    this.code = "API_V1_CONTRACT_INVALID";
    this.issues = issues;
  }
}

export function parseApiV1(schema, value, label = "API v1 payload") {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiV1ContractError(`${label} does not match the API v1 contract.`, parsed.error.issues);
  }
  return parsed.data;
}

export function createApiV1Error({
  code = "INTERNAL_ERROR",
  message,
  requestId = null,
  retryable = false,
  details
} = {}) {
  const normalizedCode = apiV1ErrorCodeSchema.safeParse(code).success ? code : "INTERNAL_ERROR";
  const payload = {
    apiVersion: API_V1_VERSION,
    error: {
      code: normalizedCode,
      message: typeof message === "string" && message.trim()
        ? message.trim()
        : "The request could not be completed.",
      requestId,
      retryable: retryable === true
    }
  };
  if (details && typeof details === "object" && !Array.isArray(details)) {
    payload.error.details = details;
  }
  return {
    statusCode: API_V1_ERROR_STATUS_BY_CODE[normalizedCode],
    body: parseApiV1(apiV1ErrorResponseSchema, payload, "API v1 error")
  };
}

const schemasForOpenApi = {
  SessionSummary: apiV1SessionSummarySchema,
  SessionDetail: apiV1SessionDetailSchema,
  AttentionResponse: apiV1AttentionResponseSchema,
  BootstrapResponse: apiV1BootstrapResponseSchema,
  SessionsResponse: apiV1SessionsResponseSchema,
  SessionResponse: apiV1SessionResponseSchema,
  ActionRequest: apiV1ActionRequestSchema,
  ActionResponse: apiV1ActionResponseSchema,
  Event: apiV1EventSchema,
  ErrorResponse: apiV1ErrorResponseSchema
};

export const apiV1JsonSchemas = Object.freeze(Object.fromEntries(
  Object.entries(schemasForOpenApi).map(([name, schema]) => [
    name,
    z.toJSONSchema(schema, {
      target: "draft-2020-12",
      unrepresentable: "any",
      cycles: "ref"
    })
  ])
));

export const apiV1OpenApiDocument = Object.freeze({
  openapi: "3.1.0",
  info: {
    title: "Corptie LAN Web API",
    version: API_V1_VERSION
  },
  servers: [{ url: API_V1_BASE_PATH }],
  paths: {
    "/bootstrap": {
      get: {
        operationId: "getBootstrap",
        responses: {
          200: { description: "Web client bootstrap", content: { "application/json": { schema: { $ref: "#/components/schemas/BootstrapResponse" } } } },
          default: { $ref: "#/components/responses/Error" }
        }
      }
    },
    "/sessions": {
      get: {
        operationId: "listSessions",
        responses: {
          200: { description: "Session snapshot", content: { "application/json": { schema: { $ref: "#/components/schemas/SessionsResponse" } } } },
          default: { $ref: "#/components/responses/Error" }
        }
      }
    },
    "/attention": {
      get: {
        operationId: "getAttentionQueue",
        responses: {
          200: { description: "Device attention queue", content: { "application/json": { schema: { $ref: "#/components/schemas/AttentionResponse" } } } },
          default: { $ref: "#/components/responses/Error" }
        }
      }
    },
    "/sessions/{sessionId}": {
      get: {
        operationId: "getSession",
        parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Session detail", content: { "application/json": { schema: { $ref: "#/components/schemas/SessionResponse" } } } },
          default: { $ref: "#/components/responses/Error" }
        }
      }
    },
    "/operations/{operationId}": {
      get: {
        operationId: "getOperation",
        parameters: [{ name: "operationId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Operation result", content: { "application/json": { schema: { $ref: "#/components/schemas/ActionResponse" } } } },
          default: { $ref: "#/components/responses/Error" }
        }
      }
    },
    "/sessions/{sessionId}/actions": {
      post: {
        operationId: "performSessionAction",
        parameters: [
          { name: "sessionId", in: "path", required: true, schema: { type: "string" } },
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 1 } },
          { name: "X-CSRF-Token", in: "header", required: true, schema: { type: "string", minLength: 1 } }
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ActionRequest" } } }
        },
        responses: {
          202: { description: "Action accepted", content: { "application/json": { schema: { $ref: "#/components/schemas/ActionResponse" } } } },
          default: { $ref: "#/components/responses/Error" }
        }
      }
    },
    "/events": {
      get: {
        operationId: "streamEvents",
        parameters: [{ name: "cursor", in: "query", required: false, schema: { type: "integer", minimum: 0 } }],
        responses: {
          200: { description: "SSE stream using the Event schema" },
          default: { $ref: "#/components/responses/Error" }
        }
      }
    }
  },
  components: {
    schemas: apiV1JsonSchemas,
    responses: {
      Error: {
        description: "Versioned API error",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } }
      }
    }
  }
});
