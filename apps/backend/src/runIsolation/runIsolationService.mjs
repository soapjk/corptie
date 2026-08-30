import { createHash, randomBytes, randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { relative } from "node:path";
import { spawn } from "node:child_process";
import { DataRootVerifier, createRunDirectories, deriveRunPaths } from "./dataRootVerifier.mjs";
import { resolveToolsetValidationReceiptPointer, validateDependencyGate } from "./dependencyContractManifest.mjs";
import { DEPENDENCY_CONTRACT_MANIFEST } from "./dependencyContractManifest.mjs";
import { PortBroker } from "./portBroker.mjs";
import { ProcessSupervisor } from "./processSupervisor.mjs";
import { RunIsolationStore } from "./runIsolationStore.mjs";
import { RunIsolationJanitor } from "./runIsolationJanitor.mjs";
import { SafeDeletionExecutor } from "./safeDeletionExecutor.mjs";
import { buildRunEnvironment } from "./runEnvironment.mjs";
import { CLEANUP_RECEIPT_CONTRACT, RUN_RECEIPT_CONTRACT, SAFETY_CHECKS, contractError, evidenceHash, signReceipt } from "./receiptContracts.mjs";

const TTL = Object.freeze({ passed: 0, failed: 72*60*60*1000, cancelled: 6*60*60*1000, infrastructure_failed: 24*60*60*1000 });

export class RunIsolationService {
  constructor({ dataRoot, quotaBytes = 2*1024*1024*1024, reserveBytes = 10*1024*1024*1024, softQuotaBytes = Number.POSITIVE_INFINITY, hardQuotaBytes = Number.POSITIVE_INFINITY,
    dataRootVerifier = new DataRootVerifier(), portBroker = new PortBroker(), processSupervisor = new ProcessSupervisor(),
    commandResolver = null, toolsetReceiptResolver = null, dependencyManifest = DEPENDENCY_CONTRACT_MANIFEST, clock = () => new Date(), uuid = randomUUID } = {}) {
    if (!dataRoot) throw new TypeError("An explicit external dataRoot is required.");
    this.dataRoot=dataRoot;this.quotaBytes=quotaBytes;this.reserveBytes=reserveBytes;this.softQuotaBytes=softQuotaBytes;this.hardQuotaBytes=hardQuotaBytes;this.verifier=dataRootVerifier;this.portBroker=portBroker;
    this.processSupervisor=processSupervisor;this.commandResolver=commandResolver;this.toolsetReceiptResolver=toolsetReceiptResolver;this.dependencyManifest=dependencyManifest;this.clock=clock;this.uuid=uuid;this.binding=null;this.store=null;this.safeDeletion=null;this.runtimeSecrets=new Map();this.executions=new Map();this.commandOutputs=new Map();
  }

  async initialize(){
    this.binding=await this.verifier.verify(this.dataRoot,{reserveBytes:this.reserveBytes,softQuotaBytes:Number.isFinite(this.softQuotaBytes)?this.softQuotaBytes:null,hardQuotaBytes:Number.isFinite(this.hardQuotaBytes)?this.hardQuotaBytes:null});
    this.store=new RunIsolationStore(`${this.binding.canonicalPath}/control/isolation.sqlite`,{clock:this.clock});await this.store.initialize();
    this.store.upsertDataRootBinding(this.binding);
    this.safeDeletion=new SafeDeletionExecutor({dataRootBinding:this.binding,store:this.store,portBroker:this.portBroker,processSupervisor:this.processSupervisor});this.janitor=new RunIsolationJanitor({service:this,softQuotaBytes:this.softQuotaBytes,hardQuotaBytes:this.hardQuotaBytes,clock:this.clock});return this;
  }
  async close(){for(const execution of this.executions.values())if(execution.process)await this.processSupervisor.terminate(execution.process).catch(()=>{});await Promise.allSettled([...this.executions.values()].map((execution)=>execution.final));await this.portBroker.close();this.runtimeSecrets.clear();this.commandOutputs.clear();this.store?.close()}

  async prepareRun(request,session){
    validatePrepareInput(request,session);
    const sourceAware=Boolean(request.sourceAware);
    assertAuthoritativeIdentity(request,session);
    const snapshotRef=request.repositorySourceSnapshotReceiptRef??null;
    const sourceFingerprint=sourceAware?snapshotRef?.sourceFingerprint??null:null;
    const requestedToolsetPointer=request.toolsetValidationReceiptPointer??null;
    const toolsetValidationReceiptPointer=(request.toolsetRequired||requestedToolsetPointer)
      ? await resolveToolsetValidationReceiptPointer({pointer:requestedToolsetPointer,resolver:this.toolsetReceiptResolver,sourceFingerprint,authority:session,manifest:this.dependencyManifest,now:this.clock()})
      : null;
    validateDependencyGate({sourceAware,toolsetRequired:Boolean(request.toolsetRequired),startupBindingReceiptRef:request.startupBindingReceiptRef,
      repositorySourceSnapshotReceiptRef:snapshotRef,toolsetValidationReceiptPointer,manifest:this.dependencyManifest});
    if(Number.isFinite(this.hardQuotaBytes)||Number.isFinite(this.softQuotaBytes))await this.janitor.assertAdmission(this.quotaBytes);
    const now=this.clock().toISOString();const runId=`run:${this.uuid()}`;const ownerNonce=this.uuid();
    const requestHash=evidenceHash({mode:request.mode,startupBindingReceiptRef:request.startupBindingReceiptRef,sourceAware,
      repositorySourceSnapshotReceiptRef:snapshotRef,toolsetValidationReceiptPointer,
      testPlanRef:request.testPlanRef??null,fixtureRef:request.fixtureRef??null,quotaClass:request.quotaClass??"standard"});
    const repositoryId=sourceAware?session.repositoryId:null;const worktreeId=sourceAware?session.worktreeId:null;
    if(sourceAware&&(!repositoryId||!worktreeId))throw contractError("SOURCE_SNAPSHOT_IDENTITY_MISMATCH","Source-aware Run requires authoritative repository and worktree binding.");
    const authoritativeSnapshotRef=sourceAware?snapshotRef:null;
    const provisional=deriveRunPaths(this.binding,{repositoryId,worktreeId,runId,mode:request.mode});
    const created=this.store.createRun({runId,mode:request.mode,logicalSessionId:session.logicalSessionId,workItemId:session.workItemId,
      repositoryId,worktreeId,generation:1,rootRelativePath:relative(this.binding.canonicalPath,provisional.runRoot),ownerNonce,
      quotaBytes:this.quotaBytes,retentionPolicyVersion:"run-retention-v1",startupBindingReceiptRef:request.startupBindingReceiptRef,
      repositorySourceSnapshotReceiptRef:authoritativeSnapshotRef,toolsetValidationReceiptPointer,sourceFingerprint,idempotencyKey:request.idempotencyKey,requestHash,now});
    if(created.replay){const runToken=this.runtimeSecrets.get(created.run.runId);if(!runToken)throw contractError("RUN_CREDENTIAL_UNAVAILABLE","Run credential was not retained across process recovery.");return {context:{...created.run.runContext,runToken},receipt:this.store.latestRunReceipt(created.run.runId),replay:true};}
    let run=this.store.updateRun(runId,{expectedVersion:1,fencingToken:1,fromStates:["allocated"],state:"preparing"});let reservation=null;
    try{
      await createRunDirectories(provisional,{layoutVersion:3,runId,mode:request.mode,repositoryId,worktreeId,ownerNonce,
        dataRootBindingId:this.binding.bindingId,deviceId:this.binding.deviceId,rootInode:this.binding.rootInode,createdAt:now});
      reservation=await this.portBroker.reserve({runId});const expiresAt=new Date(this.clock().getTime()+30_000).toISOString();
      const runLease=this.store.createLease({leaseId:`lease:${this.uuid()}`,runId,kind:"run",resourceKey:runId,ownerNonce,fence:1,expiresAt});
      const dataLease=this.store.createLease({leaseId:`lease:${this.uuid()}`,runId,kind:"data",resourceKey:provisional.runRoot,ownerNonce,fence:1,expiresAt});
      const portLease=this.store.createPortLease({leaseId:`lease:${this.uuid()}`,runId,kind:"port",resourceKey:`tcp:${reservation.host}:${reservation.port}`,ownerNonce,fence:1,expiresAt,metadata:{protocol:"tcp",address:reservation.host,port:reservation.port,handleId:reservation.handleId,socketNonce:reservation.socketNonce,listenFDRole:"backend"}});
      const credentialLease=this.store.createLease({leaseId:`lease:${this.uuid()}`,runId,kind:"credential",resourceKey:`run-token:${runId}`,ownerNonce,fence:1,expiresAt});
      const runToken=randomBytes(32).toString("base64url");this.runtimeSecrets.set(runId,runToken);
      const context=Object.freeze({schemaVersion:3,runId,mode:request.mode,generation:1,logicalSessionId:session.logicalSessionId,workItemId:session.workItemId,
        repositoryId,worktreeId,startupBindingReceiptRef:request.startupBindingReceiptRef,repositorySourceSnapshotReceiptRef:authoritativeSnapshotRef,
        sourceFingerprint,toolsetValidationReceiptPointer,dataRootBindingId:this.binding.bindingId,dataRootCanonicalPathHash:this.binding.canonicalPathHash,
        runRoot:provisional.runRoot,dataDir:provisional.dataDir,databasePath:provisional.databasePath,cacheDir:provisional.cacheDir,indexDir:provisional.indexDir,
        tmpDir:provisional.tmpDir,logDir:provisional.logDir,uploadDir:provisional.uploadDir,queueDir:provisional.queueDir,runtimeDir:provisional.runtimeDir,
        userDefaultsSuite:`com.corptie.run.${provisional.runSlug}`,backendHost:reservation.host,backendPort:reservation.port,backendListenFD:reservation.listenFD,
        socketNonce:reservation.socketNonce,serverHandleId:reservation.handleId,runLeaseRef:leaseRef(runLease),processLeaseRefs:[],portLeaseRefs:[leaseRef(portLease)],
        dataLeaseRef:leaseRef(dataLease),credentialLeaseRefs:[leaseRef(credentialLease)],fencingToken:1,resourceVersion:run.resourceVersion+1,runToken,createdAt:now,quotaBytes:this.quotaBytes});
      const readyAt=this.clock().toISOString();run=this.store.updateRun(runId,{expectedVersion:run.resourceVersion,fencingToken:1,fromStates:["preparing"],state:"ready",patch:{runContext:redactedContext(context),phaseTimestamps:{readyAt,startedAt:null,stoppedAt:null,completedAt:null}}});
      this.store.appendEvent(runId,"RunPrepared",{resourceVersion:run.resourceVersion});const receipt=this.#runReceipt(run,"ready",null);this.store.saveRunReceipt(runId,receipt);
      return {context:Object.freeze({...context,resourceVersion:run.resourceVersion}),receipt,replay:false};
    }catch(error){
      if(reservation?.handleId)await this.portBroker.release(reservation.handleId).catch(()=>{});this.runtimeSecrets.delete(runId);
      const current=this.store.getRun(runId);if(current&&["preparing","allocated"].includes(current.state)){this.store.releaseRunResourceLeases(runId,current.fencingToken);this.store.updateRun(runId,{expectedVersion:current.resourceVersion,fencingToken:current.fencingToken,fromStates:[current.state],state:"recoverable",patch:{outcome:"unknown",error:businessError(error)}})}throw error;
    }
  }

  async execute(request,session){
    const run=this.#authorize(request.runId,session);
    if(run.state==="running"){const active=this.executions.get(run.runId);if(active)return active.final;throw contractError("RUN_PROCESS_IDENTITY_INDETERMINATE","A running Run has no authoritative local process completion handle.");}
    if(["completed","failed","cancelled"].includes(run.state))return this.store.latestRunReceipt(run.runId);
    assertFence(request,run);
    if(run.state!=="ready")throw contractError("RUN_STATE_CONFLICT","Only ready Run can execute.");
    if(run.toolsetValidationReceiptPointer)await resolveToolsetValidationReceiptPointer({pointer:run.toolsetValidationReceiptPointer,resolver:this.toolsetReceiptResolver,sourceFingerprint:run.sourceFingerprint,authority:session,manifest:this.dependencyManifest,now:this.clock()});
    if(!this.commandResolver)throw contractError("RUN_CONTEXT_REQUIRED","No provider-neutral command descriptor resolver is configured.");
    const descriptor=await this.commandResolver(request.commandDescriptorRef,run.runContext);const log=await open(`${run.runContext.logDir}/${descriptor.role??"worker"}.log`,"a",0o600);
    const runToken=this.runtimeSecrets.get(run.runId);if(!runToken)throw contractError("RUN_CREDENTIAL_UNAVAILABLE","Run credential is unavailable after recovery.");const environment=buildRunEnvironment({...run.runContext,runToken,backendListenFD:3,environmentOverrides:descriptor.environment});
    const child=spawn(descriptor.executable,descriptor.args??[],{cwd:descriptor.cwd,env:environment,detached:true,stdio:["ignore",log.fd,log.fd,run.runContext.backendListenFD]});
    const childCompletion=new Promise((resolve)=>{let settled=false;const complete=(value)=>{if(settled)return;settled=true;resolve(value)};child.once("error",(error)=>complete({kind:"error",error}));child.once("close",(code,signal)=>complete({kind:"exit",code,signal}))});
    await log.close();
    let identity=null;let identityError=null;let terminalBeforeIdentity=false;
    for(let attempt=0;attempt<10&&!identity&&!terminalBeforeIdentity;attempt+=1){
      try{identity=await this.processSupervisor.identity(child.pid,{runToken,fencingToken:run.fencingToken,pgid:child.pid});identityError=null}catch(error){identityError=error}
      if(!identity){const completion=await Promise.race([childCompletion,new Promise(resolve=>setTimeout(()=>resolve(null),20))]);terminalBeforeIdentity=completion!==null}
    }
    if(!identity&&!terminalBeforeIdentity&&identityError)throw identityError;
    // Very short commands can exit before ps observes a stable identity. The
    // exact child handle still provides terminal evidence; wait for it before
    // publishing the ready/running transition when no live identity exists.
    if(!identity)await childCompletion;
    const processLease=identity?this.store.createLease({leaseId:`lease:${this.uuid()}`,runId:run.runId,kind:"process",resourceKey:`pid:${child.pid}:${identity.kernelStartTime}`,ownerNonce:run.ownerNonce,fence:run.fencingToken,expiresAt:new Date(this.clock().getTime()+30_000).toISOString()}):null;
    if(identity){this.store.recordProcess({runId:run.runId,role:descriptor.role??"worker",generation:run.generation,pid:child.pid,kernelStartTime:identity.kernelStartTime,pgid:child.pid,
      executableHash:identity.executableRealpathHash,runTokenHash:identity.runTokenHash,serverHandleId:run.runContext.serverHandleId,observedAt:this.clock().toISOString()});
      for(const portLease of this.store.activeLeases(run.runId,"port"))this.store.bindPortLease(portLease.leaseId,{pid:child.pid,kernelStartTime:identity.kernelStartTime,fence:run.fencingToken});}
    const startedAt=this.clock().toISOString();const next=this.store.updateRun(run.runId,{expectedVersion:run.resourceVersion,fencingToken:run.fencingToken,fromStates:["ready"],state:"running",patch:{phaseTimestamps:{...run.phaseTimestamps,startedAt},runContext:{...run.runContext,processLeaseRefs:processLease?[leaseRef(processLease)]:[]}}});
    this.store.appendEvent(run.runId,"RunStarted",{pid:child.pid});const receipt=this.#runReceipt(next,"running",null);this.store.saveRunReceipt(run.runId,receipt);
    const execution={child,process:this.store.processes(run.runId).find((item)=>item.pid===child.pid)??null,requestedOutcome:null,timer:null,final:null,captureOutput:descriptor.captureOutput===true,logPath:`${run.runContext.logDir}/${descriptor.role??"worker"}.log`};
    if(Number.isFinite(descriptor.timeoutMilliseconds)&&descriptor.timeoutMilliseconds>0){execution.timer=setTimeout(()=>{execution.requestedOutcome="infrastructure_failed";if(execution.process)this.processSupervisor.terminate(execution.process).catch(()=>{});},descriptor.timeoutMilliseconds);execution.timer.unref?.();}
    execution.final=childCompletion.then(async(completion)=>{if(execution.timer)clearTimeout(execution.timer);try{return await this.#completeExecution(run.runId,{...completion,requestedOutcome:execution.requestedOutcome},session)}catch(error){return this.#markCompletionRecoverable(run.runId,error)}}).finally(()=>this.executions.delete(run.runId));
    this.executions.set(run.runId,execution);
    return execution.final;
  }

  heartbeat({runId,fencingToken},session){const run=this.#authorize(runId,session);if(run.fencingToken!==fencingToken)throw contractError("RUN_STALE_FENCE","Heartbeat fence is stale.");return this.store.heartbeat(runId,fencingToken,new Date(this.clock().getTime()+30_000).toISOString())}

  async cancel(request,session){
    let run=this.#authorize(request.runId,session);if(run.state==="cleaning"&&run.outcome==="cancelled")return this.store.latestRunReceipt(run.runId);assertFence(request,run);if(run.state==="cleaned")throw contractError("RUN_CLEANED","Run is cleaned.");
    const active=this.executions.get(run.runId);if(active){active.requestedOutcome="cancelled";if(!active.process)return active.final;const result=await this.processSupervisor.terminate(active.process);if(!["matchedExited","esrch"].includes(result.status))throw contractError("RUN_PROCESS_IDENTITY_INDETERMINATE","Cancellation could not prove the child process exited.");return active.final;}
    if(!["ready","running","stopping"].includes(run.state))throw contractError("RUN_STATE_CONFLICT","Run cannot be cancelled now.");
    if(run.state!=="stopping")run=this.store.updateRun(run.runId,{expectedVersion:run.resourceVersion,fencingToken:run.fencingToken,fromStates:[run.state],state:"stopping",patch:{outcome:"cancelled"}});
    const reconciliation=await this.#stopProcesses(run);const completedAt=this.clock().toISOString();run=this.store.updateRun(run.runId,{expectedVersion:run.resourceVersion,fencingToken:run.fencingToken,fromStates:["stopping"],state:"cleaning",patch:{outcome:"cancelled",phaseTimestamps:{...run.phaseTimestamps,stoppedAt:completedAt,completedAt}}});
    const receipt=this.#runReceipt(run,"cancelled",null);this.store.saveRunReceipt(run.runId,receipt);this.store.appendEvent(run.runId,"RunCancelled",{reconciliation});return receipt;
  }

  async cleanup(request,session){
    let run=this.#authorize(request.runId,session);const requestHash=evidenceHash({runId:run.runId,policy:request.policy,expectedResourceVersion:request.expectedResourceVersion,fencingToken:request.fencingToken});
    const keyed=this.store.findCleanup(run.runId,request.idempotencyKey);if(!request.cleanupOperationId&&keyed){if(keyed.requestHash!==requestHash)throw contractError("IDEMPOTENCY_CONFLICT","Cleanup payload differs.");if(keyed.receipt)return keyed.receipt;throw contractError("RUN_CLEANUP_BLOCKED","The idempotent cleanup claim is still active.")}
    const operationId=request.cleanupOperationId??`cleanup:${this.uuid()}`;const existing=this.store.getCleanup(operationId);if(existing?.receipt){if(existing.requestHash!==requestHash)throw contractError("IDEMPOTENCY_CONFLICT","Cleanup payload differs.");return existing.receipt;}
    assertFence(request,run);
    const startedAt=this.clock().toISOString();try{this.store.createCleanup({cleanupOperationId:operationId,runId:run.runId,idempotencyKey:request.idempotencyKey,requestHash,ownerNonce:run.ownerNonce,fence:run.fencingToken,expectedRunVersion:run.resourceVersion,startedAt})}catch(error){if(/CONSTRAINT|UNIQUE constraint/i.test(`${error?.code??""} ${error?.message??""}`))throw contractError("RUN_CLEANUP_BLOCKED","Another cleanup claim owns this Run.");throw error}
    if(request.policy!=="success_default"&&request.policy!=="janitor_expiry")return this.#retain(run,operationId,request.policy,startedAt,request.reason);
    if(!["cleaning","stopping","ready","recoverable","orphaned"].includes(run.state))throw contractError("RUN_STATE_CONFLICT","Run is not eligible for cleanup.");
    if(run.state!=="cleaning")run=this.store.updateRun(run.runId,{expectedVersion:run.resourceVersion,fencingToken:run.fencingToken,fromStates:[run.state],state:"cleaning"});
    const reconciliation=await this.#stopProcesses(run);await this.portBroker.release(run.runContext.serverHandleId);
    this.store.releaseRunResourceLeases(run.runId,run.fencingToken);this.runtimeSecrets.delete(run.runId);
    const paths=deriveRunPaths(this.binding,{repositoryId:run.repositoryId,worktreeId:run.worktreeId,runId:run.runId,mode:run.mode});const proof=await this.safeDeletion.prove({run,paths,ownerNonce:run.ownerNonce,fence:run.fencingToken,cleanupOperationId:operationId});proof.processReconciliation=reconciliation==="matchedRunning"?"indeterminate":reconciliation;
    const result=await this.safeDeletion.execute({cleanupOperationId:operationId,run,paths,proof});
    this.#releaseCleanupLease(run);
    if(result.bytesReclaimed!==undefined&&result.bytesReclaimed!==run.observedBytes)run=this.store.updateRun(run.runId,{expectedVersion:run.resourceVersion,fencingToken:run.fencingToken,fromStates:["cleaning"],state:"cleaning",patch:{observedBytes:result.bytesReclaimed}});
    const finishedAt=this.clock().toISOString();
    const error=result.outcome==="cleaned"?null:businessError(contractError("RUN_CLEANUP_QUARANTINED","Cleanup safety proof is incomplete."));
    const cleanupReceipt=signReceipt(this.#cleanupReceipt({run,operationId,policy:request.policy,outcome:result.outcome,proof,result,startedAt,finishedAt,error}),"cleanup");
    this.store.updateCleanup(operationId,{state:result.outcome,outcome:result.outcome,sourceIdentityHash:result.sourceIdentityHash??null,trashIdentityHash:result.trashIdentityHash??null,finishedAt,error,receipt:cleanupReceipt});
    if(result.outcome==="cleaned")run=this.store.updateRun(run.runId,{expectedVersion:run.resourceVersion,fencingToken:run.fencingToken,fromStates:["cleaning"],state:"cleaned",patch:{phaseTimestamps:{...run.phaseTimestamps,completedAt:run.phaseTimestamps.completedAt??finishedAt}}});
    else run=this.store.updateRun(run.runId,{expectedVersion:run.resourceVersion,fencingToken:run.fencingToken,fromStates:["cleaning"],state:"recoverable",patch:{outcome:"unknown",error}});
    return cleanupReceipt;
  }

  pin({runId,expectedResourceVersion,fencingToken,reason,retainUntil},session){let run=this.#authorize(runId,session);assertFence({expectedResourceVersion,fencingToken},run);const until=Date.parse(retainUntil);if(!reason||!Number.isFinite(until)||until<=this.clock().getTime()||until>this.clock().getTime()+14*24*60*60*1000)throw contractError("RECEIPT_RETENTION_INVALID","Pin requires a reason and retainUntil within 14 days.");run=this.store.updateRun(runId,{expectedVersion:run.resourceVersion,fencingToken:run.fencingToken,fromStates:[run.state],state:run.state,patch:{pinned:true,retainUntil}});this.store.appendEvent(runId,"RunPinned",{reasonHash:evidenceHash(reason),retainUntil});return {runId,retainUntil,reason,resourceVersion:run.resourceVersion}}
  inspect(runId,session){return this.#authorize(runId,session)}
  takeCommandOutput(runId){const output=this.commandOutputs.get(runId)??null;this.commandOutputs.delete(runId);return output}
  recoverExpiredRuns({heartbeatTimeoutMilliseconds=30_000}={}){const cutoff=this.clock().getTime()-heartbeatTimeoutMilliseconds;const recovered=[];for(let run of this.store.listRuns()){if(!["preparing","ready","running","stopping"].includes(run.state)||Date.parse(run.heartbeatAt)>cutoff)continue;const error=businessError(contractError("RUN_HEARTBEAT_EXPIRED","Run heartbeat expired during recovery."));run=this.store.updateRun(run.runId,{expectedVersion:run.resourceVersion,fencingToken:run.fencingToken,fromStates:[run.state],state:"orphaned",patch:{outcome:"unknown",error}});this.store.appendEvent(run.runId,"HeartbeatMissed",{heartbeatAt:run.heartbeatAt});recovered.push(run)}return recovered}
  async reconcile(cleanupOperationId,session){const operation=this.store.getCleanup(cleanupOperationId);if(!operation)throw contractError("RUN_CLEANUP_OUTCOME_UNKNOWN","Cleanup operation not found.");if(operation.receipt&&operation.receipt.outcome!=="unknown")return operation.receipt;let run=this.#authorize(operation.runId,session);run=this.store.claimFence(run.runId,run.resourceVersion);this.store.resetCleanupForReconcile(cleanupOperationId,run.fencingToken);return this.cleanup({runId:run.runId,policy:"janitor_expiry",expectedResourceVersion:run.resourceVersion,fencingToken:run.fencingToken,idempotencyKey:operation.idempotencyKey,cleanupOperationId},session)}

  async #completeExecution(runId,completion,session){
    let run=this.#authorize(runId,session);if(run.state!=="running")return this.store.latestRunReceipt(runId);
    // A close event from the exact child handle is authoritative evidence that
    // this process generation exited. Do not reclassify an in-place exec (for
    // example swift -> swift-driver) as a foreign PID during terminal cleanup.
    const execution=this.executions.get(runId);if(completion.kind==="exit"&&execution?.process)this.store.exitProcess(execution.process.runId,execution.process.role,execution.process.generation,this.clock().toISOString());
    const requested=completion.requestedOutcome??this.executions.get(runId)?.requestedOutcome;
    const outcome=requested??(completion.kind==="error"||completion.signal?"infrastructure_failed":completion.code===0?"passed":"failed");
    const terminalState=outcome==="passed"?"completed":outcome==="cancelled"?"cancelled":"failed";
    const terminalError=terminalState==="failed"?businessError(completion.error??contractError(outcome==="infrastructure_failed"?"RUN_PROCESS_CRASHED":"RUN_PROCESS_FAILED",`Run process ended code=${completion.code??"unknown"} signal=${completion.signal??"none"}.`)):null;
    run=this.store.updateRun(runId,{expectedVersion:run.resourceVersion,fencingToken:run.fencingToken,fromStates:["running"],state:"stopping",patch:{outcome}});
    this.store.appendEvent(runId,"RunStopping",{outcome,code:completion.code??null,signal:completion.signal??null});
    const reconciliation=await this.#stopProcesses(run);if(!["matchedExited","esrch"].includes(reconciliation))throw contractError("RUN_PROCESS_IDENTITY_INDETERMINATE","Process completion could not be reconciled safely.");
    await this.portBroker.release(run.runContext.serverHandleId);this.runtimeSecrets.delete(runId);this.store.releaseRunResourceLeases(runId,run.fencingToken);
    if(execution?.captureOutput){const output=await readFile(execution.logPath,"utf8").catch(()=>"");this.commandOutputs.set(runId,output.length>4*1024*1024?output.slice(-4*1024*1024):output)}
    const completedAt=this.clock().toISOString();run=this.store.updateRun(runId,{expectedVersion:run.resourceVersion,fencingToken:run.fencingToken,fromStates:["stopping"],state:"cleaning",patch:{outcome,phaseTimestamps:{...run.phaseTimestamps,stoppedAt:completedAt,completedAt},error:terminalError}});
    const receipt=this.#runReceipt(run,terminalState,terminalError);this.store.saveRunReceipt(runId,receipt);this.store.appendEvent(runId,"RunCompleted",{state:terminalState,outcome,reconciliation});
    const policy=outcome==="passed"?"success_default":outcome==="cancelled"?"cancelled_ttl":outcome==="infrastructure_failed"?"infrastructure_ttl":"failure_ttl";
    await this.cleanup({runId,policy,expectedResourceVersion:run.resourceVersion,fencingToken:run.fencingToken,idempotencyKey:`process-completion:${runId}:${run.generation}`,reason:terminalError?.message},session);
    return receipt;
  }

  #markCompletionRecoverable(runId,error){
    let run=this.store.getRun(runId);if(run&&["running","stopping","cleaning"].includes(run.state)){const failure=businessError(error);run=this.store.updateRun(runId,{expectedVersion:run.resourceVersion,fencingToken:run.fencingToken,fromStates:[run.state],state:"recoverable",patch:{outcome:"unknown",error:failure}});const receipt=this.#runReceipt(run,"recoverable",failure);this.store.saveRunReceipt(runId,receipt);return receipt;}throw error;
  }

  #authorize(runId,session){const run=this.store.getRun(runId);if(!run)throw contractError("RUN_NOT_FOUND","Run not found.");if(run.logicalSessionId!==session?.logicalSessionId||run.workItemId!==session?.workItemId)throw contractError("RUN_UNAUTHORIZED","Authenticated Session does not own the Run.");return run}
  async #stopProcesses(run){let status="matchedExited";for(const p of this.store.processes(run.runId).filter(x=>x.state!=="exited")){const result=await this.processSupervisor.terminate(p);status=result.status;if(["matchedExited","esrch"].includes(status))this.store.exitProcess(p.runId,p.role,p.generation,this.clock().toISOString());else break;}return status}
  #releaseCleanupLease(run){const leases=this.store.activeLeases(run.runId,"cleanup");if(leases.length!==1)throw contractError("RUN_CLEANUP_BLOCKED","Cleanup lease ownership is indeterminate.");this.store.releaseLease(leases[0].leaseId,run.fencingToken)}
  #runReceipt(run,state,error){const ctx=run.runContext;const times=run.phaseTimestamps;const outcome=state==="completed"?"passed":state==="failed"?(run.outcome??"failed"):state==="cancelled"?"cancelled":["recoverable","orphaned"].includes(state)?"unknown":null;return signReceipt({schemaVersion:6,receiptId:`run_receipt:${this.uuid()}`,receiptHash:"0".repeat(64),runId:run.runId,mode:run.mode,logicalSessionId:run.logicalSessionId,workItemId:run.workItemId,repositoryId:run.repositoryId,worktreeId:run.worktreeId,sourceFingerprint:run.sourceFingerprint,startupBindingReceiptRef:run.repositoryId?run.startupBindingReceiptRef:null,repositorySourceSnapshotReceiptRef:run.repositorySourceSnapshotReceiptRef,toolsetValidationReceiptPointer:run.toolsetValidationReceiptPointer,state,outcome,runContextHash:evidenceHash(redactedContext(ctx)),dataRootBindingId:this.binding.bindingId,processLeaseRefs:ctx?.processLeaseRefs??[],portLeaseRefs:ctx?.portLeaseRefs??[],dataLeaseRef:ctx?.dataLeaseRef,credentialLeaseRefs:ctx?.credentialLeaseRefs??[],fencingToken:run.fencingToken,resourceVersion:run.resourceVersion,eventRefs:this.store.eventRefs(run.runId),metricsRef:null,readyAt:times?.readyAt??null,startedAt:times?.startedAt??null,stoppedAt:times?.stoppedAt??null,completedAt:times?.completedAt??null,error},"run")}
  #cleanupReceipt({run,operationId,policy,outcome,proof,result,startedAt,finishedAt,error}){const previous=this.store.latestRunReceipt(run.runId);return {schemaVersion:4,receiptId:`cleanup_receipt:${this.uuid()}`,receiptHash:"0".repeat(64),cleanupOperationId:operationId,runId:run.runId,runReceiptRef:resolvedRunRef(previous),logicalSessionId:run.logicalSessionId,workItemId:run.workItemId,repositoryId:run.repositoryId,worktreeId:run.worktreeId,sourceFingerprint:run.sourceFingerprint,outcome,policy,ownerSessionId:run.logicalSessionId,retentionReason:null,retentionPolicyVersion:"run-retention-v1",retainUntil:null,quotaBytes:run.quotaBytes,observedBytes:run.observedBytes,fencingToken:run.fencingToken,resourceVersion:run.resourceVersion,dataRootBindingId:this.binding.bindingId,sourceIdentityHash:result.sourceIdentityHash??evidenceHash({runId:run.runId,ownerNonce:run.ownerNonce}),trashIdentityHash:result.trashIdentityHash??null,safetyChecks:proof.safetyChecks,processReconciliation:proof.processReconciliation,bytesReclaimed:result.bytesReclaimed??0,filesRemoved:result.filesRemoved??0,eventRefs:this.store.eventRefs(run.runId),startedAt,finishedAt,error}}
  #retain(run,operationId,policy,startedAt,reason){const finishedAt=this.clock().toISOString();const ttl=policy==="explicit_pin"?14*24*60*60*1000:policy==="failure_ttl"?TTL.failed:policy==="cancelled_ttl"?TTL.cancelled:TTL.infrastructure_failed;const retainUntil=new Date(this.clock().getTime()+ttl).toISOString();const safetyChecks=Object.fromEntries(SAFETY_CHECKS.map(name=>[name,{status:"not_applicable",errorCode:null,evidenceHash:null}]));const receipt=signReceipt({...this.#cleanupReceipt({run,operationId,policy,outcome:"retained",proof:{safetyChecks,processReconciliation:"matchedExited"},result:{},startedAt,finishedAt,error:null}),retentionReason:reason??policy,retentionPolicyVersion:"run-retention-v1",retainUntil},"cleanup");this.#releaseCleanupLease(run);this.store.updateCleanup(operationId,{state:"retained",outcome:"retained",finishedAt,receipt});this.store.updateRun(run.runId,{expectedVersion:run.resourceVersion,fencingToken:run.fencingToken,fromStates:[run.state],state:run.state,patch:{retainUntil,pinned:policy==="explicit_pin"}});return receipt}
}

function validatePrepareInput(r,s){if(!r||!["test","development"].includes(r.mode)||!r.idempotencyKey||!s?.logicalSessionId||!s?.workItemId)throw contractError("RUN_CONTEXT_REQUIRED","prepareRun requires mode, idempotencyKey and authenticated Session.");const allowed=new Set(["mode","sourceAware","startupBindingReceiptRef","repositorySourceSnapshotReceiptRef","toolsetValidationReceiptPointer","toolsetRequired","idempotencyKey","testPlanRef","fixtureRef","quotaClass"]);for(const k of Object.keys(r))if(!allowed.has(k))throw contractError("RUN_CONTEXT_SCHEMA_UNSUPPORTED",`${k} is unsupported or owned by RunIsolationService.`)}
function assertAuthoritativeIdentity(r,s){for(const k of ["logicalSessionId","workItemId","repositoryId","worktreeId"])if(Object.hasOwn(r,k)&&r[k]!==s[k])throw contractError("RUN_UNAUTHORIZED",`${k} differs from authoritative Session binding.`)}
function assertFence(r,run){if(r.expectedResourceVersion!==run.resourceVersion)throw contractError("RUN_STALE_VERSION","Run version is stale.");if(r.fencingToken!==run.fencingToken)throw contractError("RUN_STALE_FENCE","Run fence is stale.")}
function leaseRef(x){return {leaseId:x.leaseId,kind:x.kind,fencingToken:x.fencingToken,resourceVersion:x.resourceVersion}}
function businessError(e){return {code:/^[A-Z][A-Z0-9_]{2,127}$/.test(e?.code??"")?e.code:"RUN_INTERNAL_ERROR",message:e?.message??"Run isolation failed.",traceId:null,detailsHash:e?.details?evidenceHash(e.details):null}}
function redactedContext(c){if(!c)return null;const x={...c};delete x.runToken;return x}
function resolvedRunRef(r){if(!r)throw contractError("RUN_CLEANUP_OUTCOME_UNKNOWN","Cleanup requires a RunReceipt.");return {receiptId:r.receiptId,receiptHash:r.receiptHash,schemaVersion:6,issuer:"run_isolation",resourceVersion:r.resourceVersion,artifactRef:{artifactId:CLEANUP_RECEIPT_CONTRACT.artifactId,version:CLEANUP_RECEIPT_CONTRACT.version,contentHash:CLEANUP_RECEIPT_CONTRACT.contentHash,relation:"implementation_spec",receiptType:"RunReceipt",schemaVersion:6}}}
