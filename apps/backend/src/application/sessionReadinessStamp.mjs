import { createHash } from "node:crypto";
import { canonicalRecoveryJson } from "./sessionRecovery.mjs";

// Host-only identity; never send configuration or Tool receipts to a client.
export function sessionReadinessStamp(reference) {
  const session = reference.metadata?.session ?? {};
  return createHash("sha256").update(canonicalRecoveryJson({
    logical: reference.logicalSessionId ?? reference.sessionId,
    binding: reference.bindingId ?? reference.providerBindingId ?? reference.providerSessionId,
    provider: reference.providerId ?? null,
    route: reference.routingVersion ?? null,
    contract: reference.readinessContractRevision ?? null,
    runtime: reference.readinessRuntimeEpoch ?? null,
    options: {
      cwd: session.external?.cwd ?? session.cwd ?? null,
      model: session.external?.currentModel ?? session.currentModel ?? null,
      reasoning: session.external?.currentReasoningLevel ?? session.currentReasoningLevel ?? null,
      approval: session.external?.approvalPolicy ?? session.approvalPolicy ?? null,
      sandbox: session.external?.sandbox ?? session.sandbox ?? null,
      permissions: session.external?.permissions ?? session.permissions ?? null
    }
  })).digest("hex");
}
