import {
  normalizeCodexApprovalPolicy,
  normalizeCodexSandbox
} from "./codexPermissions.mjs";

export function normalizeNewSessionDefaults(input = {}) {
  return {
    sandbox: normalizeCodexSandbox(input.sandbox),
    approvalPolicy: normalizeCodexApprovalPolicy(input.approvalPolicy)
  };
}
