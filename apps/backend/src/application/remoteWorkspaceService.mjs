import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { RemoteWorkspaceError, remoteAbsolutePath, sshWorkspaceIdentity } from "../runtime/sshWorkspaceTransport.mjs";

const MUTATIONS = new Set(["create", "bind", "unbind", "write", "stage", "commit", "merge", "remove"]);
const ACTIONS = new Set(["inspect", "status", "read", "search", ...MUTATIONS]);
const PROTOCOL = new URL("../../resources/ssh/workspace_protocol.py", import.meta.url);
let protocolSource;

/**
 * Provider-neutral Workspace port. Bindings and approval decisions come from
 * authenticated Session services, never from the model's tool arguments.
 * No local file/Git fallback exists here. Credentials and Provider state remain
 * in the local runtime and are not part of the remote protocol payload.
 */
export class RemoteWorkspaceService {
  constructor({ transport, resolveSessionBinding, authorizeMutation, onConnectionState = () => {} } = {}) {
    if (typeof transport?.execute !== "function" || typeof resolveSessionBinding !== "function"
      || typeof authorizeMutation !== "function") {
      throw new TypeError("RemoteWorkspaceService requires transport, resolveSessionBinding and authorizeMutation.");
    }
    this.transport = transport;
    this.resolveSessionBinding = resolveSessionBinding;
    this.authorizeMutation = authorizeMutation;
    this.onConnectionState = onConnectionState;
  }

  async perform(sessionId, action, input = {}, options = {}) {
    if (typeof sessionId !== "string" || !sessionId || !ACTIONS.has(action)) {
      throw new RemoteWorkspaceError("REMOTE_CAPABILITY_UNSUPPORTED", "A supported Workspace operation and Session are required.");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new RemoteWorkspaceError("REMOTE_INPUT_INVALID", "Workspace operation input must be an object.");
    }
    // Snapshot mutable caller data before the first await/approval boundary.
    const operationInput = structuredClone(input);
    const binding = structuredClone(await this.resolveSessionBinding(sessionId));
    if (!binding || binding.sessionId !== sessionId || binding.workspace?.transport !== "ssh"
      || !binding.taskId || !binding.workId) {
      throw new RemoteWorkspaceError("REMOTE_SESSION_BINDING_REQUIRED", "An authoritative remote Task/Session Workspace binding is required.");
    }
    const workspace = binding.workspace;
    const root = remoteAbsolutePath(workspace.rootPath);
    const identity = sshWorkspaceIdentity(workspace.hostIdentity, root);
    if (workspace.identity !== identity) {
      throw new RemoteWorkspaceError("REMOTE_WORKSPACE_IDENTITY_MISMATCH", "Remote Workspace identity differs from its host and repository path.");
    }
    // Discovery and creation use the repository root. File and Git operations
    // use only the server-side selected Worktree, including explicit bind/remove.
    const path = action === "inspect" || action === "create" ? null : remoteAbsolutePath(binding.worktreePath);
    let operationId;
    if (MUTATIONS.has(action)) {
      if (typeof options.idempotencyKey !== "string" || !options.idempotencyKey || options.idempotencyKey.length > 512) {
        throw new RemoteWorkspaceError("REMOTE_IDEMPOTENCY_KEY_REQUIRED", "A stable idempotency key is required.");
      }
      operationId = sha256(JSON.stringify([identity, sessionId, options.idempotencyKey]));
      const authorization = await this.authorizeMutation({
        sessionId, taskId: binding.taskId, workId: binding.workId,
        workspaceIdentity: identity, hostIdentity: workspace.hostIdentity,
        repositoryRoot: root, worktreePath: path, action,
        input: structuredClone(operationInput), operationId
      });
      if (authorization?.authorized !== true) {
        throw new RemoteWorkspaceError("REMOTE_WRITE_NOT_AUTHORIZED", "This destination and operation require an explicit user decision.");
      }
      // A route transition while the user reviews an action invalidates it.
      const current = await this.resolveSessionBinding(sessionId);
      if (JSON.stringify(current) !== JSON.stringify(binding)) {
        throw new RemoteWorkspaceError("REMOTE_SESSION_ROUTE_CHANGED", "The Session route changed while the operation was being authorized.");
      }
    }
    const request = {
      version: 1, sessionId, taskId: binding.taskId, repositoryRoot: root,
      worktreePath: path, action, input: operationInput,
      ...(operationId ? { operationId } : {})
    };
    protocolSource ??= readFile(PROTOCOL, "utf8");
    let result;
    try {
      result = await this.transport.execute({
        connectionRef: workspace.connectionRef, expectedHostIdentity: workspace.hostIdentity,
        cwd: root, argv: ["python3", "-I", "-c", await protocolSource],
        stdin: JSON.stringify(request), signal: options.signal,
        timeoutMs: options.timeoutMs
      });
    } catch (error) {
      this.onConnectionState({ workspaceIdentity: identity, state: "unknown" });
      throw error;
    }
    if (result.state !== "completed" || result.exitCode !== 0) {
      this.onConnectionState({ workspaceIdentity: identity, state: "unknown" });
      throw new RemoteWorkspaceError("REMOTE_OPERATION_OUTCOME_UNKNOWN", "The remote result could not be verified. Bindings are retained; no operation was replayed.", {
        operationId: operationId ?? null, transportState: result.state,
        remoteProcessTermination: result.remoteProcessTermination, retrySafe: false
      });
    }
    let envelope;
    try { envelope = JSON.parse(result.stdout); } catch { /* reject banners/truncated responses */ }
    if (envelope?.version !== 1 || typeof envelope.ok !== "boolean"
      || (envelope.ok && (!envelope.result || typeof envelope.result !== "object"))) {
      this.onConnectionState({ workspaceIdentity: identity, state: "unknown" });
      throw new RemoteWorkspaceError("REMOTE_PROTOCOL_INVALID", "Remote Workspace returned an invalid protocol response.");
    }
    this.onConnectionState({ workspaceIdentity: identity, state: "connected" });
    if (!envelope.ok) {
      const code = typeof envelope.error?.code === "string" && /^REMOTE_[A-Z_]+$/u.test(envelope.error.code)
        ? envelope.error.code : "REMOTE_OPERATION_FAILED";
      throw new RemoteWorkspaceError(code, envelope.error?.message ?? "Remote Workspace operation failed.");
    }
    return { ...envelope.result, workspaceIdentity: identity, operationId: operationId ?? null };
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
