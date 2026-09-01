import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contractError } from "./receiptContracts.mjs";

export const RUN_STATES = Object.freeze(["allocated", "preparing", "ready", "running", "stopping", "cleaning", "cleaned", "recoverable", "orphaned"]);
const TRANSITIONS = Object.freeze({
  allocated: ["preparing", "recoverable"], preparing: ["ready", "recoverable", "orphaned"],
  ready: ["running", "stopping", "cleaning", "recoverable", "orphaned"], running: ["stopping", "recoverable", "orphaned"],
  stopping: ["cleaning", "recoverable", "orphaned"], cleaning: ["cleaned", "recoverable", "orphaned"],
  recoverable: ["preparing", "ready", "stopping", "cleaning", "orphaned"], orphaned: ["stopping", "cleaning", "recoverable"], cleaned: []
});

export class RunIsolationStore {
  constructor(path, { clock = () => new Date() } = {}) { this.path = path; this.clock = clock; this.db = null; }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(SCHEMA);
  }

  close() { this.db?.close(); this.db = null; }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  createRun(input) {
    return this.transaction(() => {
      const replay = this.db.prepare("SELECT request_hash, run_id FROM run_idempotency WHERE logical_session_id=? AND operation=? AND idempotency_key=?").get(input.logicalSessionId, "prepare", input.idempotencyKey);
      if (replay) {
        if (replay.request_hash !== input.requestHash) throw contractError("IDEMPOTENCY_CONFLICT", "prepareRun idempotency key was reused with different input.");
        return { run: this.getRun(replay.run_id), replay: true };
      }
      this.db.prepare(`INSERT INTO isolation_runs
        (run_id,mode,logical_session_id,task_id,repository_id,worktree_id,state,outcome,generation,root_relative_path,
         owner_nonce,quota_bytes,observed_bytes,fencing_token,resource_version,created_at,updated_at,retention_policy_version,
         retain_until,pinned,heartbeat_at,run_context_json,phase_timestamps_json,startup_ref_json,snapshot_ref_json,toolset_ref_json,source_fingerprint,error_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.runId,input.mode,input.logicalSessionId,input.taskId,input.repositoryId,input.worktreeId,"allocated",null,input.generation,
        input.rootRelativePath,input.ownerNonce,input.quotaBytes,0,1,1,input.now,input.now,input.retentionPolicyVersion,null,0,input.now,null,JSON.stringify({readyAt:null,startedAt:null,stoppedAt:null,completedAt:null}),
        JSON.stringify(input.startupBindingReceiptRef),JSON.stringify(input.repositorySourceSnapshotReceiptRef),JSON.stringify(input.toolsetValidationReceiptPointer),input.sourceFingerprint,null);
      this.db.prepare("INSERT INTO run_idempotency(logical_session_id,operation,idempotency_key,request_hash,run_id,created_at) VALUES(?,?,?,?,?,?)")
        .run(input.logicalSessionId,"prepare",input.idempotencyKey,input.requestHash,input.runId,input.now);
      return { run: this.getRun(input.runId), replay: false };
    });
  }

  getRun(runId) { const row = this.db.prepare("SELECT * FROM isolation_runs WHERE run_id=?").get(runId); return row ? mapRun(row) : null; }
  listRuns() { return this.db.prepare("SELECT * FROM isolation_runs ORDER BY created_at,run_id").all().map(mapRun); }

  updateRun(runId, { expectedVersion, fencingToken, fromStates, state, patch = {} }) {
    return this.transaction(() => {
      const current = this.getRun(runId);
      if (!current) throw contractError("RUN_NOT_FOUND", "Run not found.");
      if (current.state === "cleaned") {
        if (state === "cleaned") return current;
        const error = contractError("RUN_CLEANED", "A cleaned Run cannot be revived."); error.statusCode = 410; throw error;
      }
      if (expectedVersion !== current.resourceVersion) throw contractError("RUN_STALE_VERSION", "Run resourceVersion is stale.");
      if (fencingToken !== current.fencingToken) throw contractError("RUN_STALE_FENCE", "Run fencing token is stale.");
      if (!fromStates.includes(current.state) || (state !== current.state && !TRANSITIONS[current.state].includes(state))) {
        throw contractError("RUN_STATE_CONFLICT", `Run cannot transition ${current.state} -> ${state}.`);
      }
      const next = { ...current, ...patch, state, resourceVersion: current.resourceVersion + 1, updatedAt: this.clock().toISOString() };
      this.db.prepare(`UPDATE isolation_runs SET state=?,outcome=?,observed_bytes=?,resource_version=?,updated_at=?,retain_until=?,pinned=?,
        heartbeat_at=?,run_context_json=?,phase_timestamps_json=?,error_json=? WHERE run_id=? AND resource_version=? AND fencing_token=?`).run(
        next.state,next.outcome,next.observedBytes,next.resourceVersion,next.updatedAt,next.retainUntil,next.pinned?1:0,next.heartbeatAt,
        json(next.runContext),json(next.phaseTimestamps),json(next.error),runId,current.resourceVersion,current.fencingToken);
      return this.getRun(runId);
    });
  }

  claimFence(runId, expectedVersion) {
    return this.transaction(() => {
      const current=this.getRun(runId); if(!current) throw contractError("RUN_NOT_FOUND","Run not found.");
      if(current.resourceVersion!==expectedVersion) throw contractError("RUN_STALE_VERSION","Run resourceVersion is stale.");
      this.db.prepare("UPDATE isolation_runs SET fencing_token=fencing_token+1,resource_version=resource_version+1,updated_at=? WHERE run_id=? AND resource_version=?")
        .run(this.clock().toISOString(),runId,expectedVersion); return this.getRun(runId);
    });
  }

  upsertDataRootBinding(binding) {
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO data_root_bindings
        (binding_id,canonical_path_hash,mount_path_hash,volume_uuid,device_id,root_inode,filesystem_type,marker_nonce,state,verified_at,fallback_policy_json,resource_version)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,1)
        ON CONFLICT(binding_id) DO UPDATE SET canonical_path_hash=excluded.canonical_path_hash,mount_path_hash=excluded.mount_path_hash,
          volume_uuid=excluded.volume_uuid,device_id=excluded.device_id,root_inode=excluded.root_inode,filesystem_type=excluded.filesystem_type,
          marker_nonce=excluded.marker_nonce,state='verified',verified_at=excluded.verified_at,fallback_policy_json=excluded.fallback_policy_json,
          resource_version=data_root_bindings.resource_version+1`).run(
        binding.bindingId,binding.canonicalPathHash,binding.mountPathHash,binding.volumeUUID,binding.deviceId,binding.rootInode,
        binding.filesystemType,binding.markerNonce,"verified",binding.verifiedAt,JSON.stringify({ policy:"fail_closed",internalFallback:false }));
      return this.db.prepare("SELECT * FROM data_root_bindings WHERE binding_id=?").get(binding.bindingId);
    });
  }

  createLease({ leaseId, runId, kind, resourceKey, ownerNonce, fence, expiresAt, metadata = null }) {
    return this.transaction(() => {
      const run=this.getRun(runId);if(!run||run.ownerNonce!==ownerNonce)throw contractError("RUN_UNAUTHORIZED","Lease owner does not match the Run.");
      if(run.fencingToken!==fence)throw contractError("RUN_STALE_FENCE","Lease fence is stale.");
      const now=this.clock().toISOString();
      this.db.prepare(`INSERT INTO resource_leases(lease_id,run_id,kind,resource_key,owner_nonce,state,fence,resource_version,acquired_at,heartbeat_at,expires_at,released_at,metadata_json)
        VALUES(?,?,?,?,?,'active',?,1,?,?,?,?,?)`).run(leaseId,runId,kind,resourceKey,ownerNonce,fence,now,now,expiresAt,null,json(metadata));
      return this.getLease(leaseId);
    });
  }
  createPortLease(input) {
    return this.transaction(() => {
      const run=this.getRun(input.runId);if(!run||run.ownerNonce!==input.ownerNonce)throw contractError("RUN_UNAUTHORIZED","Lease owner does not match the Run.");
      if(run.fencingToken!==input.fence)throw contractError("RUN_STALE_FENCE","Lease fence is stale.");
      const now=this.clock().toISOString();
      this.db.prepare(`INSERT INTO resource_leases(lease_id,run_id,kind,resource_key,owner_nonce,state,fence,resource_version,acquired_at,heartbeat_at,expires_at,released_at,metadata_json)
        VALUES(?,?,?,?,?,'active',?,1,?,?,?,?,?)`).run(input.leaseId,input.runId,input.kind,input.resourceKey,input.ownerNonce,input.fence,now,now,input.expiresAt,null,json(input.metadata));
      const metadata=input.metadata??{};
      this.db.prepare(`INSERT INTO port_leases(lease_id,run_id,protocol,address,port,socket_nonce,listen_fd_role,bound_pid,kernel_start_time,state,expires_at,resource_version)
        VALUES(?,?,?,?,?,?,?,NULL,NULL,'active',?,1)`).run(input.leaseId,input.runId,metadata.protocol??"tcp",metadata.address,metadata.port,metadata.socketNonce,metadata.listenFDRole??"backend",input.expiresAt);
      return this.getLease(input.leaseId);
    });
  }
  bindPortLease(leaseId,{pid,kernelStartTime,fence}) { return this.transaction(()=>{const lease=this.getLease(leaseId);if(!lease||lease.fencingToken!==fence||lease.state!=="active")throw contractError("RUN_STALE_FENCE","Port lease fence is stale.");const result=this.db.prepare("UPDATE port_leases SET bound_pid=?,kernel_start_time=?,resource_version=resource_version+1 WHERE lease_id=? AND state='active'").run(pid,kernelStartTime,leaseId);if(result.changes!==1)throw contractError("RUN_PORT_UNAVAILABLE","Port lease is not active.");}); }
  getLease(id) { const row=this.db.prepare("SELECT * FROM resource_leases WHERE lease_id=?").get(id); return row?mapLease(row):null; }
  activeLeases(runId, kind = null) { return this.db.prepare(`SELECT * FROM resource_leases WHERE run_id=? AND state='active' ${kind?"AND kind=?":""}`).all(...(kind?[runId,kind]:[runId])).map(mapLease); }
  releaseLease(id, fence) { return this.transaction(()=>{const lease=this.getLease(id);if(!lease||lease.state!=="active"||lease.fencingToken!==fence)throw contractError("RUN_STALE_FENCE","Lease release rejected.");const now=this.clock().toISOString();this.db.prepare("UPDATE resource_leases SET state='released',released_at=?,resource_version=resource_version+1 WHERE lease_id=? AND state='active' AND fence=?").run(now,id,fence);if(lease.kind==="port")this.db.prepare("UPDATE port_leases SET state='released',resource_version=resource_version+1 WHERE lease_id=? AND state='active'").run(id);return this.getLease(id);}); }
  releaseRunResourceLeases(runId, fence) { return this.transaction(()=>{const run=this.getRun(runId);if(!run||run.fencingToken!==fence)throw contractError("RUN_STALE_FENCE","Run fence is stale during resource release.");const now=this.clock().toISOString();this.db.prepare("UPDATE resource_leases SET state='released',released_at=?,resource_version=resource_version+1 WHERE run_id=? AND state='active' AND kind!='cleanup' AND fence<=?").run(now,runId,fence);this.db.prepare("UPDATE port_leases SET state='released',resource_version=resource_version+1 WHERE run_id=? AND state='active'").run(runId);}); }
  heartbeat(runId, fence, expiresAt) { return this.transaction(()=>{const now=this.clock().toISOString();const runResult=this.db.prepare("UPDATE isolation_runs SET heartbeat_at=?,resource_version=resource_version+1,updated_at=? WHERE run_id=? AND fencing_token=? AND state!='cleaned'").run(now,now,runId,fence);if(runResult.changes!==1)throw contractError("RUN_STALE_FENCE","Heartbeat fence is stale.");this.db.prepare("UPDATE resource_leases SET heartbeat_at=?,expires_at=?,resource_version=resource_version+1 WHERE run_id=? AND state='active' AND fence=?").run(now,expiresAt,runId,fence);this.db.prepare("UPDATE port_leases SET expires_at=?,resource_version=resource_version+1 WHERE run_id=? AND state='active'").run(expiresAt,runId);return this.getRun(runId);}); }

  recordProcess(input) { return this.transaction(()=>this.db.prepare(`INSERT INTO run_processes(run_id,role,generation,pid,kernel_start_time,pgid,executable_hash,run_token_hash,server_handle_id,state,observed_at,exit_at)
    VALUES(?,?,?,?,?,?,?,?,?,'running',?,NULL)`).run(input.runId,input.role,input.generation,input.pid,input.kernelStartTime,input.pgid,input.executableHash,input.runTokenHash,input.serverHandleId,input.observedAt)); }
  processes(runId) { return this.db.prepare("SELECT * FROM run_processes WHERE run_id=? ORDER BY role,generation").all(runId).map(mapProcess); }
  exitProcess(runId,role,generation,at) { return this.transaction(()=>this.db.prepare("UPDATE run_processes SET state='exited',exit_at=?,observed_at=? WHERE run_id=? AND role=? AND generation=?").run(at,at,runId,role,generation)); }

  createCleanup(input) { return this.transaction(()=>{const run=this.getRun(input.runId);if(!run||run.ownerNonce!==input.ownerNonce)throw contractError("RUN_UNAUTHORIZED","Cleanup owner does not match the Run.");if(run.fencingToken!==input.fence||run.resourceVersion!==input.expectedRunVersion)throw contractError("RUN_STALE_FENCE","Cleanup claim is stale.");this.db.prepare(`INSERT OR IGNORE INTO cleanup_operations(cleanup_operation_id,run_id,idempotency_key,request_hash,state,outcome,owner_nonce,fence,resource_version,source_identity_hash,trash_identity_hash,started_at,finished_at,error_json,receipt_json)
    VALUES(?,?,?,?,?,'unknown',?,?,1,NULL,NULL,?,NULL,NULL,NULL)`).run(input.cleanupOperationId,input.runId,input.idempotencyKey,input.requestHash,"claimed",input.ownerNonce,input.fence,input.startedAt);const cleanup=this.getCleanup(input.cleanupOperationId);if(cleanup.fence===input.fence&&!this.getLease(`cleanup_lease:${input.cleanupOperationId}`)){const expiresAt=new Date(Date.parse(input.startedAt)+30_000).toISOString();this.db.prepare(`INSERT INTO resource_leases(lease_id,run_id,kind,resource_key,owner_nonce,state,fence,resource_version,acquired_at,heartbeat_at,expires_at,released_at,metadata_json) VALUES(?,?,?,?,?,'active',?,1,?,?,?,?,NULL)`).run(`cleanup_lease:${input.cleanupOperationId}`,input.runId,"cleanup",input.cleanupOperationId,input.ownerNonce,input.fence,input.startedAt,input.startedAt,expiresAt,null);}return cleanup;}); }
  getCleanup(id) { const row=this.db.prepare("SELECT * FROM cleanup_operations WHERE cleanup_operation_id=?").get(id); return row?mapCleanup(row):null; }
  findCleanup(runId,idempotencyKey) { const row=this.db.prepare("SELECT * FROM cleanup_operations WHERE run_id=? AND idempotency_key=?").get(runId,idempotencyKey);return row?mapCleanup(row):null; }
  updateCleanup(id,patch) { return this.transaction(()=>{const current=this.getCleanup(id); const next={...current,...patch,resourceVersion:current.resourceVersion+1}; this.db.prepare("UPDATE cleanup_operations SET state=?,outcome=?,resource_version=?,source_identity_hash=?,trash_identity_hash=?,finished_at=?,error_json=?,receipt_json=? WHERE cleanup_operation_id=? AND resource_version=?").run(next.state,next.outcome,next.resourceVersion,next.sourceIdentityHash,next.trashIdentityHash,next.finishedAt,json(next.error),json(next.receipt),id,current.resourceVersion);if(next.receipt)this.db.prepare("INSERT OR REPLACE INTO cleanup_receipts(receipt_id,cleanup_operation_id,run_id,resource_version,receipt_hash,receipt_json,created_at) VALUES(?,?,?,?,?,?,?)").run(next.receipt.receiptId,id,current.runId,next.receipt.resourceVersion,next.receipt.receiptHash,JSON.stringify(next.receipt),this.clock().toISOString()); return this.getCleanup(id);}); }
  resetCleanupForReconcile(id,newFence) { return this.transaction(()=>{const current=this.getCleanup(id); if(!current)throw contractError("RUN_CLEANUP_OUTCOME_UNKNOWN","Cleanup operation not found.");const run=this.getRun(current.runId);if(!run||run.fencingToken!==newFence)throw contractError("RUN_STALE_FENCE","Cleanup reconcile fence is stale.");const now=this.clock().toISOString();this.db.prepare("UPDATE cleanup_operations SET state='reconciling',fence=?,receipt_json=NULL,resource_version=resource_version+1 WHERE cleanup_operation_id=? AND resource_version=?").run(newFence,id,current.resourceVersion);this.db.prepare("UPDATE resource_leases SET state='released',released_at=?,resource_version=resource_version+1 WHERE run_id=? AND kind='cleanup' AND state='active'").run(now,current.runId);this.db.prepare(`INSERT INTO resource_leases(lease_id,run_id,kind,resource_key,owner_nonce,state,fence,resource_version,acquired_at,heartbeat_at,expires_at,released_at,metadata_json) VALUES(?,?,?,?,?,'active',?,1,?,?,?,?,NULL)`).run(`cleanup_lease:${id}:fence:${newFence}`,current.runId,"cleanup",id,current.ownerNonce,newFence,now,now,new Date(Date.parse(now)+30_000).toISOString(),null);return this.getCleanup(id);}); }

  saveRunReceipt(runId, receipt) { return this.transaction(()=>{this.db.prepare("INSERT OR REPLACE INTO run_receipts(receipt_id,run_id,resource_version,receipt_hash,receipt_json,created_at) VALUES(?,?,?,?,?,?)").run(receipt.receiptId,runId,receipt.resourceVersion,receipt.receiptHash,JSON.stringify(receipt),this.clock().toISOString()); return receipt;}); }
  latestRunReceipt(runId) { const row=this.db.prepare("SELECT receipt_json FROM run_receipts WHERE run_id=? ORDER BY resource_version DESC,created_at DESC LIMIT 1").get(runId); return row?JSON.parse(row.receipt_json):null; }
  latestCleanupReceipt(runId) { const row=this.db.prepare("SELECT receipt_json FROM cleanup_receipts WHERE run_id=? ORDER BY created_at DESC LIMIT 1").get(runId); return row?JSON.parse(row.receipt_json):null; }

  appendEvent(runId,type,payload={}) { return this.transaction(()=>{const id=`run_event:${randomUUID()}`; this.db.prepare("INSERT INTO run_events(event_id,run_id,type,payload_json,created_at) VALUES(?,?,?,?,?)").run(id,runId,type,JSON.stringify(payload),this.clock().toISOString()); return id;}); }
  eventRefs(runId) { return this.db.prepare("SELECT event_id FROM run_events WHERE run_id=? ORDER BY created_at,event_id").all(runId).map(x=>x.event_id); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS data_root_bindings(binding_id TEXT PRIMARY KEY,canonical_path_hash TEXT NOT NULL,mount_path_hash TEXT NOT NULL,volume_uuid TEXT NOT NULL,device_id TEXT NOT NULL,root_inode TEXT NOT NULL,filesystem_type TEXT NOT NULL,marker_nonce TEXT NOT NULL,state TEXT NOT NULL,verified_at TEXT NOT NULL,fallback_policy_json TEXT NOT NULL,resource_version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS isolation_runs(run_id TEXT PRIMARY KEY,mode TEXT NOT NULL,logical_session_id TEXT NOT NULL,task_id TEXT NOT NULL,repository_id TEXT,worktree_id TEXT,state TEXT NOT NULL,outcome TEXT,generation INTEGER NOT NULL,root_relative_path TEXT NOT NULL,owner_nonce TEXT NOT NULL,quota_bytes INTEGER NOT NULL,observed_bytes INTEGER NOT NULL,fencing_token INTEGER NOT NULL,resource_version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,retention_policy_version TEXT NOT NULL,retain_until TEXT,pinned INTEGER NOT NULL,heartbeat_at TEXT NOT NULL,run_context_json TEXT,phase_timestamps_json TEXT NOT NULL,startup_ref_json TEXT NOT NULL,snapshot_ref_json TEXT,toolset_ref_json TEXT,source_fingerprint TEXT,observation_id TEXT,error_json TEXT);
CREATE TABLE IF NOT EXISTS run_idempotency(logical_session_id TEXT NOT NULL,operation TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,run_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(logical_session_id,operation,idempotency_key));
CREATE TABLE IF NOT EXISTS resource_leases(lease_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES isolation_runs(run_id),kind TEXT NOT NULL,resource_key TEXT NOT NULL,owner_nonce TEXT NOT NULL,state TEXT NOT NULL,fence INTEGER NOT NULL,resource_version INTEGER NOT NULL,acquired_at TEXT NOT NULL,heartbeat_at TEXT NOT NULL,expires_at TEXT NOT NULL,released_at TEXT,metadata_json TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS active_resource_key ON resource_leases(kind,resource_key) WHERE state='active';
CREATE UNIQUE INDEX IF NOT EXISTS active_cleanup_run ON resource_leases(run_id) WHERE kind='cleanup' AND state='active';
CREATE TABLE IF NOT EXISTS port_leases(lease_id TEXT PRIMARY KEY REFERENCES resource_leases(lease_id),run_id TEXT NOT NULL REFERENCES isolation_runs(run_id),protocol TEXT NOT NULL,address TEXT NOT NULL,port INTEGER NOT NULL,socket_nonce TEXT NOT NULL,listen_fd_role TEXT NOT NULL,bound_pid INTEGER,kernel_start_time TEXT,state TEXT NOT NULL,expires_at TEXT NOT NULL,resource_version INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS active_protocol_address_port ON port_leases(protocol,address,port) WHERE state='active';
CREATE TABLE IF NOT EXISTS run_processes(run_id TEXT NOT NULL REFERENCES isolation_runs(run_id),role TEXT NOT NULL,generation INTEGER NOT NULL,pid INTEGER NOT NULL,kernel_start_time TEXT NOT NULL,pgid INTEGER NOT NULL,executable_hash TEXT NOT NULL,run_token_hash TEXT NOT NULL,server_handle_id TEXT,state TEXT NOT NULL,observed_at TEXT NOT NULL,exit_at TEXT,PRIMARY KEY(run_id,role,generation));
CREATE TABLE IF NOT EXISTS cleanup_operations(cleanup_operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES isolation_runs(run_id),idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,outcome TEXT NOT NULL,owner_nonce TEXT NOT NULL,fence INTEGER NOT NULL,resource_version INTEGER NOT NULL,source_identity_hash TEXT,trash_identity_hash TEXT,started_at TEXT NOT NULL,finished_at TEXT,error_json TEXT,receipt_json TEXT,UNIQUE(run_id,idempotency_key));
CREATE TABLE IF NOT EXISTS cleanup_receipts(receipt_id TEXT PRIMARY KEY,cleanup_operation_id TEXT NOT NULL REFERENCES cleanup_operations(cleanup_operation_id),run_id TEXT NOT NULL REFERENCES isolation_runs(run_id),resource_version INTEGER NOT NULL,receipt_hash TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_receipts(receipt_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES isolation_runs(run_id),resource_version INTEGER NOT NULL,receipt_hash TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_events(event_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES isolation_runs(run_id),type TEXT NOT NULL,observation_id TEXT,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS retention_policies(policy_version TEXT PRIMARY KEY,success_ttl_seconds INTEGER NOT NULL,failed_ttl_seconds INTEGER NOT NULL,cancelled_ttl_seconds INTEGER NOT NULL,infrastructure_failed_ttl_seconds INTEGER NOT NULL,max_pin_ttl_seconds INTEGER NOT NULL,created_at TEXT NOT NULL);
INSERT OR IGNORE INTO retention_policies VALUES('run-retention-v1',0,259200,21600,86400,1209600,'2026-08-30T00:00:00.000Z');
`;

function mapRun(row){return {runId:row.run_id,mode:row.mode,logicalSessionId:row.logical_session_id,taskId:row.task_id,repositoryId:row.repository_id,worktreeId:row.worktree_id,state:row.state,outcome:row.outcome,generation:Number(row.generation),rootRelativePath:row.root_relative_path,ownerNonce:row.owner_nonce,quotaBytes:Number(row.quota_bytes),observedBytes:Number(row.observed_bytes),fencingToken:Number(row.fencing_token),resourceVersion:Number(row.resource_version),createdAt:row.created_at,updatedAt:row.updated_at,retentionPolicyVersion:row.retention_policy_version,retainUntil:row.retain_until,pinned:Boolean(row.pinned),heartbeatAt:row.heartbeat_at,runContext:parse(row.run_context_json),phaseTimestamps:parse(row.phase_timestamps_json),startupBindingReceiptRef:parse(row.startup_ref_json),repositorySourceSnapshotReceiptRef:parse(row.snapshot_ref_json),toolsetValidationReceiptPointer:parse(row.toolset_ref_json),sourceFingerprint:row.source_fingerprint,observationId:row.observation_id,error:parse(row.error_json)}}
function mapLease(row){return {leaseId:row.lease_id,runId:row.run_id,kind:row.kind,resourceKey:row.resource_key,ownerNonce:row.owner_nonce,state:row.state,fencingToken:Number(row.fence),resourceVersion:Number(row.resource_version),acquiredAt:row.acquired_at,heartbeatAt:row.heartbeat_at,expiresAt:row.expires_at,releasedAt:row.released_at,metadata:parse(row.metadata_json)}}
function mapProcess(row){return {runId:row.run_id,role:row.role,generation:Number(row.generation),pid:Number(row.pid),kernelStartTime:row.kernel_start_time,pgid:Number(row.pgid),executableHash:row.executable_hash,runTokenHash:row.run_token_hash,serverHandleId:row.server_handle_id,state:row.state,observedAt:row.observed_at,exitAt:row.exit_at}}
function mapCleanup(row){return {cleanupOperationId:row.cleanup_operation_id,runId:row.run_id,idempotencyKey:row.idempotency_key,requestHash:row.request_hash,state:row.state,outcome:row.outcome,ownerNonce:row.owner_nonce,fence:Number(row.fence),resourceVersion:Number(row.resource_version),sourceIdentityHash:row.source_identity_hash,trashIdentityHash:row.trash_identity_hash,startedAt:row.started_at,finishedAt:row.finished_at,error:parse(row.error_json),receipt:parse(row.receipt_json)}}
function parse(value){return value==null?null:JSON.parse(value)} function json(value){return value==null?null:JSON.stringify(value)}
