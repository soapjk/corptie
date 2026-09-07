import { randomUUID } from "node:crypto";
import { remoteAbsolutePath, sshWorkspaceIdentity, RemoteWorkspaceError } from "../runtime/sshWorkspaceTransport.mjs";

/** Additive migration: existing Workspace/Git identities and local paths stay intact. */
export function migrateSshWorkspaces(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS ssh_workspace_connections (
      connection_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      host_identity TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      host_alias TEXT NOT NULL,
      host_key_alias TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ssh_workspace_locations (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES ssh_workspace_connections(connection_id) ON DELETE RESTRICT,
      host_identity TEXT NOT NULL,
      remote_root_path TEXT NOT NULL,
      connection_state TEXT NOT NULL DEFAULT 'unknown' CHECK(connection_state IN ('unknown','connected','disconnected')),
      last_validated_at TEXT,
      UNIQUE(host_identity, remote_root_path)
    );
    CREATE TABLE IF NOT EXISTS ssh_workspace_observations (
      workspace_id TEXT PRIMARY KEY REFERENCES ssh_workspace_locations(workspace_id) ON DELETE CASCADE,
      observed_at TEXT NOT NULL,
      inventory_json TEXT NOT NULL
    );
  `);
}

export class SshWorkspaceRepository {
  constructor(store) { this.store = store; }

  registerConnection(input) {
    knownFields(input, ["connectionId", "label", "hostIdentity", "credentialRef", "hostAlias", "hostKeyAlias"]);
    const connectionId = input.connectionId ?? `ssh-connection:${randomUUID()}`;
    for (const [field, value] of Object.entries({ connectionId, ...input })) {
      if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\0\r\n]/u.test(value)) invalid(field);
    }
    for (const field of ["hostAlias", "hostKeyAlias"]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/u.test(input[field] ?? "")) invalid(field);
    }
    if (!input.label || !input.hostIdentity || !input.credentialRef?.startsWith("ssh-credential:")) invalid("connection reference");
    // Connection identity is immutable. Credential changes use a new reference
    // and an explicit new connection, so old Workspaces cannot silently retarget.
    const existing = this.connection(connectionId);
    if (existing) {
      if (["label", "hostIdentity", "credentialRef", "hostAlias", "hostKeyAlias"].some((key) => existing[key] !== input[key])) {
        throw new RemoteWorkspaceError("SSH_CONNECTION_IMMUTABLE", "An existing SSH connection cannot be silently retargeted.");
      }
      return this.presentConnection(existing);
    }
    this.store.db.run(
      `INSERT INTO ssh_workspace_connections(connection_id,label,host_identity,credential_ref,host_alias,host_key_alias,created_at)
       VALUES(?,?,?,?,?,?,?)`,
      [connectionId, input.label, input.hostIdentity, input.credentialRef, input.hostAlias, input.hostKeyAlias, new Date().toISOString()]
    );
    this.store.scheduleSave();
    return this.presentConnection(this.connection(connectionId));
  }

  connection(id) {
    const row = this.store.selectOne("SELECT * FROM ssh_workspace_connections WHERE connection_id=?", [id]);
    return row ? {
      connectionId: row.connection_id, label: row.label, hostIdentity: row.host_identity,
      credentialRef: row.credential_ref, hostAlias: row.host_alias, hostKeyAlias: row.host_key_alias,
      createdAt: row.created_at
    } : null;
  }

  presentConnection(connection) {
    if (!connection) return null;
    const { credentialRef, ...publicConnection } = connection;
    return publicConnection;
  }

  listConnections() {
    return this.store.selectAll("SELECT connection_id FROM ssh_workspace_connections ORDER BY label,connection_id")
      .map((row) => this.presentConnection(this.connection(row.connection_id)));
  }

  registerWorkspace(input) {
    knownFields(input, ["connectionId", "rootPath"]);
    const connection = this.connection(input.connectionId);
    if (!connection) throw new RemoteWorkspaceError("SSH_CONNECTION_NOT_FOUND", "Select a registered SSH connection.");
    const rootPath = remoteAbsolutePath(input.rootPath);
    const identity = sshWorkspaceIdentity(connection.hostIdentity, rootPath);
    const existing = this.store.selectOne("SELECT workspace_id FROM workspaces WHERE canonical_root_path=?", [identity]);
    if (existing) return this.store.getWorkspace(existing.workspace_id);
    const workspaceId = `workspace:${randomUUID()}`;
    const now = new Date().toISOString();
    this.store.db.run("BEGIN IMMEDIATE");
    try {
      // The existing generic external kind is stored internally. The public
      // model derives sshRemote from its explicit transport resource.
      this.store.db.run(
        `INSERT INTO workspaces(workspace_id,kind,ownership,root_path,canonical_root_path,status,created_at,updated_at)
         VALUES(?,'cloud','externalManaged',NULL,?,'pending',?,?)`,
        [workspaceId, identity, now, now]
      );
      this.store.db.run(
        `INSERT INTO ssh_workspace_locations(workspace_id,connection_id,host_identity,remote_root_path,connection_state)
         VALUES(?,?,?,?,'unknown')`,
        [workspaceId, connection.connectionId, connection.hostIdentity, rootPath]
      );
      this.store.db.run("COMMIT");
    } catch (error) {
      this.store.db.run("ROLLBACK");
      throw error;
    }
    this.store.scheduleSave();
    return this.store.getWorkspace(workspaceId);
  }

  location(workspaceId) {
    const row = this.store.selectOne(
      `SELECT l.*,c.label,c.host_alias FROM ssh_workspace_locations l
       JOIN ssh_workspace_connections c ON c.connection_id=l.connection_id WHERE l.workspace_id=?`, [workspaceId]
    );
    return presentLocation(row);
  }

  locations() {
    return new Map(this.store.selectAll(
      `SELECT l.*,c.label,c.host_alias FROM ssh_workspace_locations l
       JOIN ssh_workspace_connections c ON c.connection_id=l.connection_id`
    ).map((row) => [row.workspace_id, presentLocation(row)]));
  }

  recordConnectionState(workspaceId, state) {
    if (!["unknown", "connected", "disconnected"].includes(state)) invalid("connection state");
    if (!this.location(workspaceId)) throw new RemoteWorkspaceError("SSH_WORKSPACE_NOT_FOUND", "Remote Workspace was not found.");
    this.store.db.run(
      "UPDATE ssh_workspace_locations SET connection_state=?,last_validated_at=CASE WHEN ?='connected' THEN ? ELSE last_validated_at END WHERE workspace_id=?",
      [state, state, new Date().toISOString(), workspaceId]
    );
    // No mutation of Git inventory, Session bindings, Task lifecycle, or root
    // path. Disconnection is never interpreted as directory deletion.
    this.store.scheduleSave();
    return this.store.getWorkspace(workspaceId);
  }

  observation(workspaceId) {
    const row = this.store.selectOne("SELECT observed_at,inventory_json FROM ssh_workspace_observations WHERE workspace_id=?", [workspaceId]);
    return row ? { ...JSON.parse(row.inventory_json), observedAt: row.observed_at } : null;
  }

  recordObservation(workspaceId, observation) {
    if (!this.location(workspaceId)) throw new RemoteWorkspaceError("SSH_WORKSPACE_NOT_FOUND", "Remote Workspace was not found.");
    this.store.db.run(`INSERT INTO ssh_workspace_observations(workspace_id,observed_at,inventory_json) VALUES(?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET observed_at=excluded.observed_at,inventory_json=excluded.inventory_json`,
    [workspaceId, new Date().toISOString(), JSON.stringify(observation)]);
    const workspace = this.recordConnectionState(workspaceId, "connected");
    return { workspace, observation: this.observation(workspaceId) };
  }
}

function presentLocation(row) {
  return row ? {
      transport: "ssh", connectionId: row.connection_id, hostIdentity: row.host_identity,
      hostLabel: row.label, hostAlias: row.host_alias, rootPath: row.remote_root_path,
      identity: sshWorkspaceIdentity(row.host_identity, row.remote_root_path),
      connectionState: row.connection_state, lastValidatedAt: row.last_validated_at,
      cwdIsSandbox: false,
      executionSupported: false,
      executionUnavailableReason: "SSH_EXECUTION_NOT_VERIFIED"
  } : null;
}

function invalid(field) { throw new RemoteWorkspaceError("SSH_CONFIGURATION_INVALID", `Invalid ${field}.`); }

function knownFields(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("input");
  if (Object.keys(input).some((key) => !allowed.includes(key))) invalid("configuration field");
}
