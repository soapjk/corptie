import { createHash } from "node:crypto";
import Ajv from "ajv";
import { taskHierarchySummarySchema, worktreeHierarchySchema } from "../domain/taskHierarchyContract.mjs";
export const DETAIL_NATIVE_BUSINESS_PROFILE = "native-business-v1";
export const nativeBusinessHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const string = (maxLength = 65536) => ({ type: "string", maxLength });
const nullable = schema => ({ anyOf: [schema, { type: "null" }] });
const boolean = { type: "boolean" }, integer = nullable({ type: "integer", minimum: 0 });
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const extended = (required, optional) => ({ ...object({ ...required, ...optional }), required: Object.keys(required) });
const array = (items, maxItems = 20) => ({ type: "array", items, maxItems });
const list = row => object({ items: array(object(row)), hasMore: boolean });
const metric = { type: "object", maxProperties: 20, patternProperties: { "^[A-Za-z0-9_.]{1,64}$": string(64) }, additionalProperties: false };
const summary = object({ state: string(64), focus: string(), progress: string(), intervention: string(64), reason: string(), nextAction: string(), current: boolean });
const focusSummary = object({ state: string(64), focus: string(), progress: string(), current: boolean, messageSummary: string(), intervention: string(64), reason: string(), nextAction: string(), generatedAt: nullable(string(64)) });
const memory = { memoryId: string(512), kind: string(64), content: string(), unavailable: boolean, snapshotAtRecall: boolean, updatedAt: nullable(string(64)), resourceVersion: integer };
const schemas = {
  sessionInfo: object({ sessionId: string(512), workName: string() }),
  chatSummary: object({ text: string() }),
  workOverview: object({ workId: string(512), name: string(), description: string() }),
  taskInfo: extended({ taskId: string(512), title: string(), status: string(64), description: string(), acceptanceCriteria: string(), verificationCriteria: string(), resourceRevision: string(512), summary }, { parentTaskId: nullable(string(512)), parentSessionId: nullable(string(512)), hierarchy: nullable(taskHierarchySummarySchema) }),
  artifacts: list({ artifactId: string(512), title: string(512), summary: string(), version: integer, contentHash: string(64), readAvailable: boolean }),
  focusTasks: list({ taskId: string(512), title: string(512), sessionId: nullable(string(512)), summary: focusSummary }),
  contextReferences: list({ referenceId: string(512), title: string(512), targetType: string(64), status: string(64), enabled: boolean }),
  memoryResources: list(memory), memoryHits: list(memory),
  schedules: list({ scheduleId: string(512), name: string(512), scheduleType: string(64), status: string(64), runAt: nullable(string(64)), nextRunAt: nullable(string(64)), timezone: string(128), resourceRevision: string(512) }),
  provider: object({ providerId: string(512), name: string(512), model: string(512), reasoning: string(128), switching: boolean, providers: array(object({ providerId: string(512), name: string(512), available: boolean })) }),
  worktree: extended({ attached: boolean, worktreeId: nullable(string(512)), mainBranch: string(512), blockedReason: string(128),
    tree: nullable(object({ branchName: string(512), isMain: boolean, dirty: nullable(boolean), availability: string(64), aheadOfMain: integer, behindMain: integer, changedFileCount: integer, operationState: string(64) })),
    autoFollow: object({ enabled: boolean, status: string(64), reason: string(128) }), job: nullable(object({ jobId: string(512), status: string(64), phase: string(64) })) }, { hierarchy: nullable(worktreeHierarchySchema) }),
  turnMetrics: object({ turnId: nullable(string(512)), completeness: string(64), wall: metric, wallPartition: metric, inclusive: metric })
};
const ajv = new Ajv({ strict: true, allErrors: false });
const validate = Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => [kind, ajv.compile(schema)]));
const action = ajv.compile({ ...object({ id: string(128), kind: { enum: ["navigation", "read", "command"] }, operation: string(128), label: object({ fallback: string(512) }), available: boolean,
  target: object({ resourceType: string(64), id: string(512) }), expectedResourceRevision: string(512), confirmation: { enum: ["none", "required", "destructive"] } }),
  required: ["id", "kind", "operation", "label", "available", "target"] });
const fail = () => { throw Object.assign(new Error("Invalid native business document"), { code: "DETAIL_BUSINESS_INVALID", status: 500 }); };
export function validateNativeBusinessDocument(document) {
  if (!document || document.protocolVersion !== 1 || document.catalog !== DETAIL_NATIVE_BUSINESS_PROFILE
    || Object.keys(document).some(key => !["protocolVersion", "catalog", "documentId", "sessionId", "generation", "revision", "cards", "order"].includes(key))) fail();
  for (const key of ["documentId", "sessionId", "generation", "revision"]) if (typeof document[key] !== "string" || !document[key].length || document[key].length > 512) fail();
  if (!Array.isArray(document.cards) || document.cards.length > 16 || !Array.isArray(document.order)) fail();
  const ids = new Set();
  for (const card of document.cards) {
    if (!card || Object.keys(card).some(key => !["id", "kind", "version", "revision", "loadState", "data", "actions", "nextCursor"].includes(key))
      || typeof card.id !== "string" || !card.id.length || card.id.length > 128 || ids.has(card.id) || card.version !== 1
      || typeof card.revision !== "string" || !["ready", "empty", "error"].includes(card.loadState)
      || !validate[card.kind]?.(card.data) || card.nextCursor !== null && (typeof card.nextCursor !== "string" || card.nextCursor.length > 512)
      || !Array.isArray(card.actions) || card.actions.length > 64) fail();
    ids.add(card.id);
    if (card.data.items && new Set(card.data.items.map(row => row.artifactId ?? row.taskId ?? row.referenceId ?? row.memoryId ?? row.scheduleId)).size !== card.data.items.length) fail();
    if (card.kind === "artifacts" && card.data.items.some(row => row.readAvailable && (!row.version || !/^[a-f0-9]{64}$/.test(row.contentHash)))) fail();
    const actionIDs = new Set();
    for (const value of card.actions) {
      if (!action(value) || actionIDs.has(value.id)) fail(); actionIDs.add(value.id);
      if (value.kind === "navigation" && !["resource.open", "editor.open"].includes(value.operation)
        || value.kind === "read" && !["detail.collection.page", "artifact.content"].includes(value.operation)
        || value.kind === "command" && !["memory.update", "memory.delete", "reference.add", "reference.remove", "schedule.cancel"].includes(value.operation)) fail();
    }
  }
  if (document.order.length !== ids.size || new Set(document.order).size !== ids.size || document.order.some(id => !ids.has(id))
    || Buffer.byteLength(JSON.stringify(document)) > 256 * 1024) fail();
  return document;
}
