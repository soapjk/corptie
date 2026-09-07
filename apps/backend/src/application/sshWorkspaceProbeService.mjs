import { readFile } from "node:fs/promises";
import { RemoteWorkspaceError, remoteAbsolutePath } from "../runtime/sshWorkspaceTransport.mjs";

const protocol = readFile(new URL("../../resources/ssh/workspace_protocol.py", import.meta.url), "utf8");

/** Native resource discovery only; never creates or binds a Task/Session. */
export class SshWorkspaceProbeService {
  constructor({ repository, transport }) {
    this.repository = repository;
    this.transport = transport;
    this.active = new Set();
  }

  async inspect(workspaceId, { signal } = {}) {
    const location = this.repository.location(workspaceId);
    if (!location) throw failure("SSH_WORKSPACE_NOT_FOUND", "Remote Workspace was not found.");
    if (this.active.has(workspaceId)) throw failure("SSH_WORKSPACE_BUSY", "This Workspace is already being inspected.");
    this.active.add(workspaceId);
    try {
      const response = await this.transport.execute({
        connectionRef: location.connectionId, expectedHostIdentity: location.hostIdentity,
        cwd: location.rootPath, argv: ["python3", "-I", "-c", await protocol],
        stdin: JSON.stringify({ version: 1, action: "inspect", resourceInspection: true, repositoryRoot: location.rootPath }),
        signal
      });
      if (response.state !== "completed" || response.exitCode !== 0) {
        throw failure("SSH_PROBE_OUTCOME_UNKNOWN", "Repository inspection could not be verified. Existing observations are retained.");
      }
      let envelope;
      try { envelope = JSON.parse(response.stdout); } catch { /* rejected below */ }
      if (envelope?.version !== 1 || envelope.ok !== true) {
        throw failure("SSH_REPOSITORY_UNVERIFIED", "The remote directory could not be verified as a Git repository root.");
      }
      const result = envelope.result;
      if (!result || !Array.isArray(result.worktrees) || result.worktrees.length > 10000) {
        throw failure("SSH_PROBE_PROTOCOL_INVALID", "Repository inspection returned an invalid inventory.");
      }
      // Whitelist remote data. Remote capability claims never enable execution.
      const observation = { rootPath: remoteAbsolutePath(result.rootPath), worktrees: result.worktrees.map((tree) => {
        if (typeof tree.headOid !== "string" || !/^[a-f0-9]{40,64}$/u.test(tree.headOid)
          || (tree.branchRef != null && (typeof tree.branchRef !== "string" || !tree.branchRef.startsWith("refs/heads/") || /[\0\r\n]/u.test(tree.branchRef)))) {
          throw failure("SSH_PROBE_PROTOCOL_INVALID", "Repository inspection returned an invalid Worktree.");
        }
        return { path: remoteAbsolutePath(tree.path), headOid: tree.headOid, branchRef: tree.branchRef ?? null,
          detached: tree.detached === true, locked: Boolean(tree.locked), prunable: Boolean(tree.prunable) };
      }) };
      return this.repository.recordObservation(workspaceId, observation);
    } catch (error) {
      this.repository.recordConnectionState(workspaceId, "unknown");
      if (error instanceof RemoteWorkspaceError) throw error;
      throw failure("SSH_PROBE_FAILED", "Repository inspection failed. Existing observations are retained.");
    } finally {
      this.active.delete(workspaceId);
    }
  }
}

function failure(code, message) { return new RemoteWorkspaceError(code, message); }
