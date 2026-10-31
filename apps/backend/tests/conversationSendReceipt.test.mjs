import assert from "node:assert/strict";
import test from "node:test";
import { validateConversationSendReceipt } from "../src/agent-provider/contracts.mjs";
import { SessionApplicationService } from "../src/agent-provider/sessionApplicationService.mjs";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { createClaudeAgentSdkProvider } from "../src/agent-provider/providers/claudeAgentSdkProvider.mjs";

test("send receipt requires an explicit outcome and a nonempty stable Turn ID", () => {
  for (const value of [null, {}, { turn: { id: "legacy" } }, { turnId: "" },
    { turnId: " turn ", delivery: "accepted" }, { turnId: "turn", delivery: "completed" }]) {
    assert.throws(() => validateConversationSendReceipt(value), {
      code: "PROVIDER_SEND_RECEIPT_INVALID", dispatchState: "unknown", stage: "provider_dispatch"
    });
  }
  for (const delivery of ["accepted", "unknown"]) {
    const receipt = { turnId: "turn", delivery, compatibleField: true };
    assert.equal(validateConversationSendReceipt(receipt), receipt);
  }
});

test("malformed post-dispatch receipts commit context admission and never resend", async () => {
  let sends = 0, commits = 0, rejects = 0;
  const provider = createClaudeAgentSdkProvider({ send: async () => { sends++; return { id: "native" }; } });
  const reference = { sessionId: "session", logicalSessionId: "logical", providerId: provider.descriptor.id,
    providerSessionId: "native", bindingId: "binding", routingVersion: 2 };
  const service = new SessionApplicationService({ registry: new AgentProviderRegistry([provider]),
    resolveSessionReference: () => reference });
  service.contextDelivery = { prepare: () => ({ context: null,
    commit: () => commits++, reject: () => rejects++ }) };
  await assert.rejects(service.sendMessage("session", "once"), {
    code: "PROVIDER_SEND_RECEIPT_INVALID", dispatchState: "unknown"
  });
  assert.equal(sends, 1);
  assert.equal(commits, 1);
  assert.equal(rejects, 0);
});
