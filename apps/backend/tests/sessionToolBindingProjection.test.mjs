import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionToolBindingProjection, desiredToolDomainIds, appliedToolDomainIds
} from "../src/application/sessionToolBindingProjection.mjs";

function fixture() {
  const session = { id: "session:1", agentId: "agent:1", sessionKind: "worker", taskId: "task:1" };
  const task = { current_session_id: session.id, resource_version: 4 };
  const binding = {
    bindingId: "binding:1", providerId: "provider:test", providerSessionId: "native:1",
    providerThreadId: "thread:1", routingVersion: 2, state: "active"
  };
  const logical = {
    logicalSessionId: "logical:1", legacySessionId: session.id,
    activeThreadId: binding.providerThreadId, activeBinding: binding, routingVersion: 2
  };
  const queries = [], preparations = [];
  const store = {
    getSession: () => session,
    getTask: () => task,
    getLogicalSession: () => logical,
    getLogicalSessionByLegacySessionId: () => logical,
    getLogicalSessionByProviderThreadId: () => logical,
    getSessionToolCatalogMaterialization: () => ({
      desiredDomains: ["work-item-acceptance"], appliedDomains: [{ domainId: "git" }]
    }),
    selectOne: (sql, args) => { queries.push({ sql, args }); return null; }
  };
  const projection = createSessionToolBindingProjection({
    store,
    prepareDesiredReplacement: (input) => { preparations.push(input); return input; }
  });
  return { projection, store, session, task, logical, binding, queries, preparations };
}

test("current binding identity is read afresh and stale binding IDs are rejected", () => {
  const f = fixture();
  assert.equal(f.projection.resolveToolHostBinding("logical:1", "stale"), null);
  const current = f.projection.resolveToolHostBinding("logical:1", "binding:1");
  assert.equal(current.taskSessionAuthorization, "current");
  assert.equal(current.authorizationRevision, 4);
  assert.equal(current.isCurrent, true);
  assert.equal(f.queries.length, 0);
  f.logical.activeThreadId = "thread:new";
  f.session.deletedAt = "now";
  const changed = f.projection.resolveToolHostBinding("logical:1", "binding:1");
  assert.equal(changed.isCurrent, false);
  assert.equal(changed.tombstoned, true);
});

test("startup authorization checks managed execution fallback without granting current ownership", () => {
  const f = fixture();
  f.task.current_session_id = "session:previous";
  f.store.selectOne = (sql, args) => {
    f.queries.push({ sql, args });
    return sql.includes("FROM execution_spaces")
      ? { startup_operation_id: "execution:1", resource_version: 7 } : null;
  };
  const result = f.projection.resolveToolHostBinding("logical:1", "binding:1");
  assert.equal(result.taskSessionAuthorization, "startup");
  assert.equal(result.startupOperationId, "execution:1");
  assert.equal(result.currentTaskSessionId, "session:previous");
  assert.equal(result.authorizationRevision, 7);
  assert.equal(f.queries.length, 2);
  assert.deepEqual(f.queries[0].args, ["task:1", "session:1", "logical:1", "provider:test", "native:1"]);
  assert.match(f.queries[0].sql, /startup.state IN \('session_bound','provider_bound'\)/);
  assert.match(f.queries[1].sql, /execution.strategy='managedSandbox'/);
});

test("an unowned Worker without startup evidence remains unauthorized", () => {
  const f = fixture();
  f.task.current_session_id = "session:previous";
  const result = f.projection.resolveToolHostBinding("logical:1", "binding:1");
  assert.equal(result.taskSessionAuthorization, null);
  assert.equal(result.startupOperationId, null);
});

test("replacement preserves desired and applied domains with legacy acceptance alias normalization", async () => {
  const f = fixture();
  await f.projection.prepareDesiredWorkspaceToolMaterialization({
    logicalSessionId: "logical:1", sessionId: "session:1",
    sourceBinding: f.binding,
    binding: { ...f.binding, bindingId: "binding:new", routingVersion: 5 }
  });
  const prepared = f.preparations[0];
  assert.deepEqual(prepared.desiredDomains, ["git", "task-acceptance"]);
  assert.equal(prepared.binding.providerBindingId, "binding:new");
  assert.equal(prepared.binding.authorizationRevision, 5);
  assert.equal(prepared.binding.sessionId, "session:1");
});

test("applied domains require a matching applied revision and metadata favors the authoritative route", () => {
  assert.deepEqual(desiredToolDomainIds({ desiredDomains: ["git", "git", null] }), ["git"]);
  assert.deepEqual(appliedToolDomainIds({
    status: "applied", appliedVersion: 1, desiredVersion: 2, appliedDomains: ["git"]
  }), []);
  assert.deepEqual(appliedToolDomainIds({
    status: "applied", appliedVersion: 2, desiredVersion: 2, appliedDomains: [{ domainId: "git" }, "git"]
  }), ["git"]);
  const f = fixture();
  const metadata = f.projection.resolveDynamicToolCallMetadata({
    threadId: "thread:1", metadata: { logicalSessionId: "untrusted" }
  });
  assert.equal(metadata.logicalSessionId, "logical:1");
  assert.equal(metadata.providerBindingId, "binding:1");
  f.store.getLogicalSessionByProviderThreadId = () => null;
  assert.deepEqual(f.projection.resolveDynamicToolCallMetadata({ metadata: { purpose: "background" } }),
    { purpose: "background" });
});
