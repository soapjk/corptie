export const DEFAULT_CODEX_SANDBOX = "workspace-write";
export const DEFAULT_CODEX_APPROVAL_POLICY = "on-request";

const CODEX_SANDBOX_ALIASES = new Map([
  ["workspace-write", "workspace-write"],
  ["workspaceWrite", "workspace-write"],
  ["danger-full-access", "danger-full-access"],
  ["dangerFullAccess", "danger-full-access"],
  ["read-only", "read-only"],
  ["readOnly", "read-only"]
]);

const APP_SERVER_SANDBOX_TYPES = {
  "workspace-write": "workspaceWrite",
  "danger-full-access": "dangerFullAccess",
  "read-only": "readOnly"
};

export function normalizeCodexSandbox(value, fallback = DEFAULT_CODEX_SANDBOX) {
  const sandbox = CODEX_SANDBOX_ALIASES.get(typeof value === "string" ? value.trim() : "");
  if (sandbox) return sandbox;
  return CODEX_SANDBOX_ALIASES.get(typeof fallback === "string" ? fallback.trim() : "")
    ?? DEFAULT_CODEX_SANDBOX;
}

export function normalizeCodexApprovalPolicy(value, fallback = DEFAULT_CODEX_APPROVAL_POLICY) {
  const approvalPolicy = typeof value === "string" ? value.trim() : "";
  return ["on-request", "ask-risky", "on-failure", "never"].includes(approvalPolicy)
    ? approvalPolicy
    : fallback;
}

export function codexPermissionsForSession(session, fallback = {}) {
  const external = session?.external ?? {};
  return {
    sandbox: normalizeCodexSandbox(
      external.sandbox ?? session?.sandbox,
      normalizeCodexSandbox(fallback.sandbox)
    ),
    approvalPolicy: normalizeCodexApprovalPolicy(
      external.approvalPolicy ?? session?.approvalPolicy,
      normalizeCodexApprovalPolicy(fallback.approvalPolicy)
    )
  };
}

export function hasCodexSessionPermissions(session) {
  return Boolean(
    (session?.external?.sandbox ?? session?.sandbox)
    && (session?.external?.approvalPolicy ?? session?.approvalPolicy)
  );
}

export function codexTurnPermissionOptions(session, fallback = {}) {
  const permissions = codexPermissionsForSession(session, fallback);
  return {
    approvalPolicy: ["ask-risky", "on-failure"].includes(permissions.approvalPolicy)
      ? "on-request"
      : permissions.approvalPolicy,
    sandboxPolicy: { type: APP_SERVER_SANDBOX_TYPES[permissions.sandbox] }
  };
}

export function withCodexSessionPermissions(session, permissions = {}) {
  const normalized = codexPermissionsForSession({
    sandbox: permissions.sandbox,
    approvalPolicy: permissions.approvalPolicy
  });
  return {
    ...session,
    external: {
      ...(session?.external ?? {}),
      sandbox: normalized.sandbox,
      approvalPolicy: normalized.approvalPolicy
    }
  };
}

export function codexPermissionsFromThread(thread) {
  const sandbox = thread?.sandbox
    ?? thread?.sandboxMode
    ?? thread?.sandboxPolicy?.type
    ?? thread?.sandbox_policy?.type;
  const approvalPolicy = thread?.approvalPolicy ?? thread?.approval_policy;
  if (!sandbox && !approvalPolicy) return null;
  return {
    sandbox: normalizeCodexSandbox(sandbox),
    approvalPolicy: normalizeCodexApprovalPolicy(approvalPolicy)
  };
}

export function readInitialCodexPermissionsFromRollout(text) {
  for (const line of String(text ?? "").split("\n")) {
    if (!line.includes('"turn_context"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "turn_context") continue;
      const sandbox = entry.payload?.sandbox_policy?.type;
      const approvalPolicy = entry.payload?.approval_policy;
      if (!sandbox && !approvalPolicy) continue;
      return {
        sandbox: normalizeCodexSandbox(sandbox),
        approvalPolicy: normalizeCodexApprovalPolicy(approvalPolicy)
      };
    } catch {
      // Ignore a partially written rollout line and continue to the first valid context.
    }
  }
  return null;
}
