import assert from "node:assert/strict";
import test from "node:test";
import { SessionContextDelivery } from "../src/application/sessionContextDelivery.mjs";
import { SessionApplicationService } from "../src/agent-provider/sessionApplicationService.mjs";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { AGENT_PROVIDER_CAPABILITIES as C } from "../src/agent-provider/contracts.mjs";
import { createCodexAppServerProvider } from "../src/agent-provider/providers/codexAppServerProvider.mjs";
import { createClaudeAgentSdkProvider } from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";
import { createOpenClackyProvider } from "../src/agent-provider/providers/openClackyProvider.mjs";
import { mapCodexProviderNotification, mapClaudeProviderEvent } from "../src/application/providerEventEnvelope.mjs";
import { mergeWorkerSessionContexts } from "../src/application/workSessionContext.mjs";

const reference = { sessionId: "s", requestedSessionId: "s", logicalSessionId: "logical:s", bindingId: "b",
  providerSessionId: "thread:s", providerId: "provider", routingVersion: 1 };
const policy = { mode: "append", maxDeltaTurns: 32 };
function context({ artifact = "ARTIFACT_ONE", evidence = "CURRENT_USER_ONE", binding = "BINDING_RULE ".repeat(300) } = {}) {
  const contextSections = [
    { id: "session-binding", prompt: binding, reusable: true },
    { id: "artifact-index", prompt: artifact, reusable: true },
    { id: "evidence", prompt: evidence, reusable: false },
    { id: "memory-recall", prompt: "MEMORY_UNCHANGED", reusable: false }
  ];
  return { prompt: contextSections.filter(s => s.prompt).map(s => s.prompt).join("\n\n"), contextSections };
}

test("unchanged accepted sections are omitted while current evidence and memory still arrive", () => {
  const cache = new SessionContextDelivery();
  const first = cache.prepare(reference, context(), policy);
  assert.equal(first.context.contextDelivery.mode, "full");
  first.commit();
  const next = cache.prepare(reference, context({ evidence: "CURRENT_USER_TWO" }), policy);
  assert.doesNotMatch(next.context.prompt, /BINDING_RULE|ARTIFACT_ONE|CURRENT_USER_ONE/);
  assert.match(next.context.prompt, /CURRENT_USER_TWO/);
  assert.match(next.context.prompt, /MEMORY_UNCHANGED/);
  assert.ok(next.context.contextDelivery.savedUtf8Bytes > 3_000);
  assert.equal(next.context.contextSections, undefined);
  next.commit();
  const changed = cache.prepare(reference, context({ artifact: "ARTIFACT_TWO" }), policy);
  assert.match(changed.context.prompt, /ARTIFACT_TWO/);
  assert.match(changed.context.prompt, /supersede/);
  assert.doesNotMatch(changed.context.prompt, /BINDING_RULE|ARTIFACT_ONE/);
});

test("unacknowledged or failed sends never justify omitting context", () => {
  const cache = new SessionContextDelivery();
  const first = cache.prepare(reference, context(), policy);
  const pending = cache.prepare(reference, context(), policy);
  assert.equal(pending.context.contextDelivery.mode, "full");
  first.commit();
  pending.reject();
  assert.equal(cache.prepare(reference, context(), policy).context.contextDelivery.mode, "full");
});

test("binding changes, invalidation during dispatch, TTL and refresh cadence require a baseline", () => {
  let now = 0;
  const cache = new SessionContextDelivery({ clock: () => now, ttlMs: 50 });
  const first = cache.prepare(reference, context(), policy); first.commit();
  assert.equal(cache.prepare({ ...reference, bindingId: "new" }, context(), policy).context.contextDelivery.mode, "full");
  const inflight = cache.prepare(reference, context(), policy);
  cache.invalidate("logical:s"); inflight.commit();
  const reset = cache.prepare(reference, context(), { ...policy, maxDeltaTurns: 2 }); reset.commit();
  const delta = cache.prepare(reference, context(), { ...policy, maxDeltaTurns: 2 }); delta.commit();
  assert.equal(cache.prepare(reference, context(), { ...policy, maxDeltaTurns: 2 }).context.contextDelivery.mode, "full");
  now = 60;
  assert.equal(cache.prepare(reference, context(), policy).context.contextDelivery.mode, "full");
});

test("removals are explicit and receipt storage stays bounded", () => {
  const cache = new SessionContextDelivery({ maxSessions: 1, maxBytes: 20_000 });
  const first = cache.prepare(reference, context(), policy); first.commit();
  const removed = cache.prepare(reference, context({ artifact: "" }), policy);
  assert.match(removed.context.prompt, /corptie_context_removed section="artifact-index"/);
  removed.commit();
  const other = cache.prepare({ ...reference, sessionId: "other", logicalSessionId: "other" }, context(), policy);
  other.commit();
  assert.equal(cache.entries.size, 1);
  assert.ok(cache.bytes <= 20_000);
  assert.equal(cache.prepare(reference, context(), policy).context.contextDelivery.mode, "full");
});

for (const kind of ["codex", "claude", "openclacky"]) {
  test(`${kind}: the shared send boundary applies reuse through the real adapter contract`, async () => {
    const captured = [];
    let reject = false;
    const send = async (_reference, _message, options) => {
      if (reject) throw new Error("Provider rejected context");
      captured.push(options.contextPrompt ?? options.sessionContext?.prompt ?? "");
      return { accepted: true };
    };
    const provider = kind === "codex"
      ? createCodexAppServerProvider({ send }, { capabilities: [C.CONVERSATION_SEND] })
      : kind === "claude" ? createClaudeAgentSdkProvider({ send }) : createOpenClackyProvider({ send });
    let active = { ...reference, providerId: provider.descriptor.id };
    let currentContext = context();
    let overBudget = false;
    const service = new SessionApplicationService({ registry: new AgentProviderRegistry([provider]),
      resolveSessionReference: () => active, resolveMessageContext: () => {
        if (overBudget) return mergeWorkerSessionContexts({ baseContext: { prompt: "x".repeat(40_000) } });
        return currentContext;
      } });
    service.ensureActiveBindingToolsReady = async () => ({ reference: active });
    await service.sendMessage("s", "first");
    await service.sendMessage("s", "next");
    assert.match(captured[0], /BINDING_RULE/);
    assert.doesNotMatch(captured[1], /BINDING_RULE/);
    reject = true;
    await assert.rejects(service.sendMessage("s", "fail"), /rejected/);
    reject = false;
    await service.sendMessage("s", "retry");
    assert.match(captured.at(-1), /BINDING_RULE/);
    service.observeSessionContextEvent({ event: { type: "execution.notice",
      payload: { item: { type: "contextCompaction" } } }, binding: active });
    await service.sendMessage("s", "after compact");
    assert.match(captured.at(-1), /BINDING_RULE/);
    active = { ...active, bindingId: "replacement" };
    await service.sendMessage("s", "new binding");
    assert.match(captured.at(-1), /BINDING_RULE/);
    currentContext = mergeWorkerSessionContexts({
      baseContext: { prompt: "中".repeat(4_665) },
      requiredContexts: [{ contextKey: "preferences", prompt: "p".repeat(6_348) }],
      directUserIntentContext: { prompt: "CURRENT_USER_EVIDENCE" }
    });
    await service.sendMessage("s", "large complete user turn");
    assert.ok(Buffer.byteLength(captured.at(-1)) > 20_480);
    assert.match(captured.at(-1), /CURRENT_USER_EVIDENCE/);
    service.invalidateSessionContext("s");
    await service.sendMessage("s", "full baseline after reset");
    assert.ok(captured.at(-1).includes("中".repeat(4_665)));
    const count = captured.length;
    overBudget = true;
    await assert.rejects(service.sendMessage("s", "unsent"), error =>
      error.code === "SESSION_CONTEXT_BUDGET_EXCEEDED"
      && error.stage === "context_assembly" && error.dispatchState === "not_sent");
    assert.equal(captured.length, count);
  });
}

test("native compaction notifications reach the shared invalidation boundary", () => {
  const notification = mapCodexProviderNotification({ binding: reference,
    message: { method: "thread/compacted", params: { threadId: "thread:s" } } });
  assert.equal(notification.type, "context.compacted");
  const item = mapCodexProviderNotification({ binding: reference,
    message: { method: "item/completed", params: { threadId: "thread:s", item: { id: "compact", type: "contextCompaction" } } } });
  assert.equal(item.type, "context.compacted");
  const claude = mapClaudeProviderEvent({ binding: reference,
    event: { type: "execution.notice", item: { id: "compact", type: "contextCompaction" } } });
  assert.equal(claude.payload.item.type, "contextCompaction");
});

test("canonical overflow is rejected even for a cached delta or non-append Provider", () => {
  const cache = new SessionContextDelivery();
  const source = context();
  cache.prepare(reference, source, policy).commit();
  const invalid = { ...source, contextBudget: { maxTurnUtf8Bytes: 100 } };
  for (const deliveryPolicy of [policy, undefined, { mode: "replace" }]) {
    assert.throws(() => cache.prepare(reference, invalid, deliveryPolicy), error =>
      error.code === "SESSION_CONTEXT_BUDGET_EXCEEDED"
      && error.dispatchState === "not_sent" && error.stage === "context_delivery");
  }
});

test("update markers fall back to a validated complete baseline when wire bytes overflow", () => {
  const cache = new SessionContextDelivery();
  const source = context({ binding: "binding" });
  const budgeted = { ...source, contextBudget: { maxTurnUtf8Bytes: Buffer.byteLength(source.prompt) } };
  cache.prepare(reference, budgeted, policy).commit();
  const changed = context({ binding: "binding", artifact: "ARTIFACT_TWO" });
  const result = cache.prepare(reference, { ...changed, contextBudget: budgeted.contextBudget }, policy);
  assert.equal(result.context.contextDelivery.mode, "full");
  assert.equal(result.context.prompt, changed.prompt);
  assert.ok(Buffer.byteLength(result.context.prompt) <= budgeted.contextBudget.maxTurnUtf8Bytes);
  result.commit();
  cache.invalidate("s");
  assert.equal(cache.prepare(reference, budgeted, policy).context.contextDelivery.mode, "full");
});
