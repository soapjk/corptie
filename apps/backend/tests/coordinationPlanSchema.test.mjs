import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { COORDINATION_PLAN_SCHEMA } from "../src/application/coordinationTurnService.mjs";

test("coordination output satisfies strict required-fields contract at every object", () => {
  function visit(schema, path = "$") {
    if (!schema || typeof schema !== "object") return;
    if (schema.properties) {
      assert.equal(schema.additionalProperties, false, path);
      assert.deepEqual([...schema.required ?? []].sort(), Object.keys(schema.properties).sort(), path);
      for (const [key, child] of Object.entries(schema.properties)) visit(child, `${path}.${key}`);
    }
    if (schema.items) visit(schema.items, `${path}[]`);
    for (const keyword of ["anyOf", "oneOf", "allOf"]) schema[keyword]?.forEach((child, i) => visit(child, `${path}.${keyword}[${i}]`));
  }
  visit(COORDINATION_PLAN_SCHEMA);
});

test("strict coordination output permits unused fields without inventing evidence or deletion choices", () => {
  const validate = new Ajv({ strict: false }).compile(COORDINATION_PLAN_SCHEMA);
  const base = { kind: "discussion", reply: "回答", decisionReportId: null, requestRelation: null, batchId: null,
    presentation: "message", progressUpdates: [], focus: "", decision: "", items: [], queries: [] };
  assert.ok(validate(base), JSON.stringify(validate.errors));
  const query = { tool: "list_children", taskId: null, sessionId: null, query: null, cursor: null,
    messageId: null, offset: 0, limit: 6, targetType: null, targetId: null, section: null };
  assert.ok(validate({ ...base, kind: "read", queries: [query] }), JSON.stringify(validate.errors));
  const item = { action: "create", taskId: null, title: "测试", text: "执行", agentId: "role:test", evidence: null, deletion: null };
  assert.ok(validate({ ...base, kind: "dispatch", items: [item] }), JSON.stringify(validate.errors));
  const deletion = { artifactDisposition: null, stopRunning: null, cancelStartup: null, deleteAssociatedTasks: null, cancelIntegration: null };
  assert.ok(validate({ ...base, kind: "cleanup", items: [{ ...item, action: "delete", taskId: "task:child", deletion }] }), JSON.stringify(validate.errors));
  assert.ok(validate({ ...base, kind: "deliver", items: [{ ...item, action: "deliver", taskId: "task:child", evidence: ["message:final"] }] }), JSON.stringify(validate.errors));
  assert.ok(validate({ ...base, kind: "shadow_reply", decisionReportId: "report:question" }), JSON.stringify(validate.errors));
  const missing = structuredClone(base);
  delete missing.decisionReportId;
  assert.equal(validate(missing), false);
  assert.equal(validate({ ...base, items: [{ ...item, evidence: 123 }] }), false);
  assert.equal(validate({ ...base, items: [{ ...item, deletion: { ...deletion, stopRunning: "yes" } }] }), false);
});
