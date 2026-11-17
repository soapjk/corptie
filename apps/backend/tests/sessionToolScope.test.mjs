import assert from "node:assert/strict";
import test from "node:test";
import { createSessionToolContextResolver } from "../src/application/sessionToolScope.mjs";

function fixture(providerId = "claude-sdk") {
  const session = { id: "session", agentId: "agent", sessionKind: "worker", workId: "work", taskId: "task" };
  const activeBinding = { bindingId: "binding", providerId, providerSessionId: "native", providerThreadId: "thread", state: "active" };
  const logical = { logicalSessionId: "logical", legacySessionId: session.id, activeThreadId: "thread", activeBinding };
  const binding = { providerBindingId: "binding", providerId, providerSessionId: "native", state: "active",
    isCurrent: true, taskSessionAuthorization: "current" };
  const store = {
    getSession: id => id === session.id ? session : null,
    getLogicalSessionByLegacySessionId: id => id === session.id ? logical : null,
    getLogicalSessionByProviderThreadId: id => id === "thread" ? logical : null,
    getLogicalSessionByProviderSessionId: (provider, id) => provider === providerId && id === "native" ? logical : null
  };
  const resolve = createSessionToolContextResolver({ store,
    collaborationCore: { getAgentForSession: () => ({ agentId: "agent" }) },
    resolveToolHostBinding: () => ({ ...binding, isCurrent: binding.isCurrent && logical.activeThreadId === activeBinding.providerThreadId }) });
  const input = { actorId: "agent", evidence: { kind: "session-binding", sessionId: "session", providerBindingId: "binding" } };
  return { session, logical, binding, store, resolve, input };
}

for (const provider of ["codex-app-server", "claude-sdk", "openclacky"]) {
  test(`common authority resolves immutable context, not caller metadata (${provider})`, () => {
    const f = fixture(provider);
    const result = f.resolve({ ...f.input, metadata: { taskId: "foreign" }, context: { binding: "forged" } });
    assert.equal(result.metadata.taskId, "task");
    assert.equal(result.metadata.providerId, provider);
    assert.equal(Object.isFrozen(result.context), true);
    assert.equal(Object.isFrozen(result.metadata), true);
    f.binding.state = "retired";
    assert.throws(() => result.context.revalidate(), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
  });
}

test("all evidence surfaces reject wrong actor, stale route and missing scope", () => {
  const f = fixture("codex-app-server");
  const thread = { kind: "provider-thread", providerId: "codex-app-server", threadId: "thread" };
  const native = { kind: "provider-session", providerId: "codex-app-server", providerSessionId: "native" };
  for (const evidence of [f.input.evidence, thread, native]) {
    assert.equal(f.resolve({ ...f.input, evidence }).metadata.sessionId, "session");
    assert.throws(() => f.resolve({ ...f.input, actorId: "other", evidence }), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
  }
  for (const evidence of [undefined, {}, { ...thread, threadId: "old" }, { ...native, providerId: "other" },
    { ...f.input.evidence, providerBindingId: "old" }]) {
    assert.throws(() => f.resolve({ ...f.input, evidence }), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
  }
  f.logical.activeThreadId = "new";
  assert.throws(() => f.resolve(f.input), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
});

test("reauthorization retains the original transport credentials", () => {
  const f = fixture();
  const result = f.resolve(f.input);
  f.input.actorId = "other";
  f.input.evidence.providerBindingId = "forged";
  assert.equal(result.context.revalidate().actorId, "agent");
  f.binding.state = "retired";
  assert.throws(() => result.context.revalidate(), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
});

test("an in-flight native invocation cannot adopt a replacement binding", () => {
  const f = fixture("openclacky");
  const result = f.resolve({ actorId: "agent", evidence: {
    kind: "provider-session", providerId: "openclacky", providerSessionId: "native"
  } });
  f.logical.activeBinding.bindingId = "replacement";
  f.binding.providerBindingId = "replacement";
  assert.throws(() => result.context.revalidate(), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
});

test("Worker eligibility is common; non-Worker Sessions do not require a Task lease", () => {
  const f = fixture();
  f.binding.taskSessionAuthorization = null;
  assert.throws(() => f.resolve(f.input), { code: "SESSION_TOOL_EXECUTION_FORBIDDEN" });
  f.session.sessionKind = "assistantChat";
  assert.equal(f.resolve(f.input).metadata.sessionKind, "assistantChat");
  f.session.deletedAt = "now";
  assert.throws(() => f.resolve(f.input), { code: "SESSION_TOOL_SCOPE_REQUIRED" });
});
