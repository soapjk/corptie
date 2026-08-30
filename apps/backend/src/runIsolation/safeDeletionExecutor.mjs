import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { SAFETY_CHECKS, SAFETY_ERROR_CODES, evidenceHash } from "./receiptContracts.mjs";
import { assertNoSymlinkSegments, deriveRunPaths, isSameOrDescendant } from "./dataRootVerifier.mjs";
import { loadNativeSafeDeletion } from "./nativeSafeDeletion.mjs";

export class SafeDeletionExecutor {
  constructor({ dataRootBinding, store, portBroker, processSupervisor, nativeSafety = loadNativeSafeDeletion() }={}){this.binding=dataRootBinding;this.store=store;this.portBroker=portBroker;this.processSupervisor=processSupervisor;this.nativeSafety=nativeSafety;}

  async prove({run,paths,ownerNonce,fence,cleanupOperationId=null}){
    const facts={}; const pass=(name,value)=>facts[name]=check("passed",null,value); const fail=(name,status,value)=>facts[name]=check(status,SAFETY_ERROR_CODES[name],value);
    const trashRelative=cleanupOperationId?join("trash",cleanupOperationId.replace(/[^a-zA-Z0-9._-]/g,"_")):null;
    let targetPath=paths.runRoot;let targetRelative=relative(this.binding.canonicalPath,targetPath);let reconcileFromTrash=false;
    if(cleanupOperationId&&!await exists(targetPath)){targetPath=join(this.binding.canonicalPath,trashRelative);targetRelative=trashRelative;reconcileFromTrash=true;}
    let rootInfo,marker;
    try{const root=await realpath(this.binding.canonicalPath);rootInfo=await stat(root,{bigint:true});
      if(root!==this.binding.canonicalPath||String(rootInfo.dev)!==this.binding.deviceId||String(rootInfo.ino)!==this.binding.rootInode)throw new Error("identity");pass("canonicalRoot",{rootHash:this.binding.canonicalPathHash,dev:String(rootInfo.dev),ino:String(rootInfo.ino)});}catch(error){fail("canonicalRoot","failed",{code:error.code??"identity"});}
    try{marker=JSON.parse(await readFile(join(targetPath,".run-owner.json"),"utf8")); if(marker.layoutVersion!==3||marker.runId!==run.runId||marker.repositoryId!==run.repositoryId||marker.worktreeId!==run.worktreeId||marker.ownerNonce!==ownerNonce||marker.dataRootBindingId!==this.binding.bindingId||marker.deviceId!==this.binding.deviceId||marker.rootInode!==this.binding.rootInode)throw new Error("marker");}catch(error){fail("runMarker","failed",{code:error.code??"marker"});}
    const derived=deriveRunPaths(this.binding,{repositoryId:run.repositoryId,worktreeId:run.worktreeId,runId:run.runId,mode:run.mode});
    if(derived.runRoot===paths.runRoot)pass("identity",{runRootHash:evidenceHash(paths.runRoot)});else fail("identity","failed",{derived:derived.runRoot,actual:paths.runRoot});
    const cleanup=this.store.getCleanup(cleanupOperationId);const cleanupLeases=this.store.activeLeases(run.runId,"cleanup");
    if(cleanup&&cleanupLeases.length===1&&cleanupLeases[0].ownerNonce===ownerNonce&&cleanupLeases[0].resourceKey===cleanupOperationId)pass("leaseOwner",{ownerNonce,cleanupOperationId,leaseId:cleanupLeases[0].leaseId});else fail("leaseOwner","failed",{ownerNonce,cleanupOperationId,active:cleanupLeases.length});
    if(run.fencingToken===fence&&cleanup?.fence===fence&&cleanupLeases[0]?.fencingToken===fence)pass("fence",{fence,cleanupResourceVersion:cleanup.resourceVersion});else fail("fence","failed",{expected:run.fencingToken,actual:fence,cleanupFence:cleanup?.fence??null});
    let nativeTreeIdentity=null;
    try{
      await assertNoSymlinkSegments(targetPath);
      nativeTreeIdentity=this.nativeSafety.inspect(this.binding.canonicalPath,targetRelative);
      if(nativeTreeIdentity.rootDeviceId!==this.binding.deviceId||nativeTreeIdentity.rootInode!==this.binding.rootInode)throw Object.assign(new Error("root identity"),{code:"RUN_IDENTITY_CHANGED"});
      if(!marker||marker.runDeviceId!==nativeTreeIdentity.targetDeviceId||marker.runInode!==nativeTreeIdentity.targetInode)throw Object.assign(new Error("run marker identity"),{code:"RUN_IDENTITY_CHANGED"});
      pass("runMarker",{...marker,reconcileFromTrash,proofMechanism:nativeTreeIdentity.proofMechanism});
      pass("noSymlink",{mechanism:nativeTreeIdentity.proofMechanism,targetDeviceId:nativeTreeIdentity.targetDeviceId,targetInode:nativeTreeIdentity.targetInode});
      pass("noHardlinkEscape",{mechanism:nativeTreeIdentity.proofMechanism,files:nativeTreeIdentity.files});
      pass("noMountCrossing",{mechanism:nativeTreeIdentity.proofMechanism,rootDeviceId:nativeTreeIdentity.rootDeviceId,targetDeviceId:nativeTreeIdentity.targetDeviceId});
    }catch(error){
      const code=nativeErrorCode(error);
      if(!facts.runMarker)fail("runMarker","failed",{code});
      fail("noSymlink",code==="RUN_SYMLINK_FORBIDDEN"?"failed":"indeterminate",{code});
      fail("noHardlinkEscape",code==="RUN_HARDLINK_FORBIDDEN"?"failed":"indeterminate",{code});
      fail("noMountCrossing",code==="RUN_MOUNT_CROSSING"?"failed":"indeterminate",{code});
    }
    const processes=this.store.processes(run.runId).filter(x=>x.state!=="exited"); let processReconciliation="matchedExited";
    for(const process of processes){const result=await this.processSupervisor.reconcile(process);if(result.status!=="esrch"&&result.status!=="matchedExited"){processReconciliation=result.status;break;}}
    if(["matchedExited","esrch"].includes(processReconciliation))pass("noActiveProcess",{processReconciliation});else fail("noActiveProcess","indeterminate",{processReconciliation});
    for(const [name,kind] of [["noActivePort","port"],["noActiveDataLease","data"],["noActiveCredentialLease","credential"]]){const active=this.store.activeLeases(run.runId,kind);if(active.length===0)pass(name,{active:0});else fail(name,"failed",{active:active.length});}
    const open=processes.some(x=>x.serverHandleId&&this.portBroker.isOpen(x.serverHandleId));if(!open)pass("serverHandleClosed",{open:false});else fail("serverHandleClosed","failed",{open:true});
    const forbidden=[this.binding.canonicalPath,join(this.binding.canonicalPath,"control"),join(this.binding.canonicalPath,"shared"),join(this.binding.canonicalPath,"trash")];
    const rel=relative(this.binding.canonicalPath,targetPath);const allowedTrash=reconcileFromTrash&&trashRelative===rel;if(isSameOrDescendant(targetPath,this.binding.canonicalPath)&&rel&& !rel.startsWith(`..${sep}`)&&!forbidden.includes(resolve(targetPath))&&(derived.runRoot===paths.runRoot||allowedTrash))pass("targetBoundary",{relativeHash:evidenceHash(rel),reconcileFromTrash});else fail("targetBoundary","failed",{relativeHash:evidenceHash(rel)});
    for(const name of SAFETY_CHECKS)if(!facts[name])fail(name,"indeterminate",{missing:true});
    const safetyChecks=Object.fromEntries(SAFETY_CHECKS.map(name=>[name,facts[name]]));
    return {safetyChecks,processReconciliation,nativeTreeIdentity,targetRelativePath:targetRelative,trashRelativePath:trashRelative,reconcileFromTrash};
  }

  async execute({cleanupOperationId,run,paths,proof}){
    if(Object.values(proof.safetyChecks).some(x=>x.status!=="passed")||!["matchedExited","esrch"].includes(proof.processReconciliation))return {outcome:"quarantined",trashIdentityHash:null,bytesReclaimed:0,filesRemoved:0};
    if(!proof.nativeTreeIdentity)return {outcome:"quarantined",trashIdentityHash:null,bytesReclaimed:0,filesRemoved:0,errorCode:"RUN_NATIVE_PROOF_MISSING"};
    const trashRoot=join(this.binding.canonicalPath,"trash");await mkdir(trashRoot,{recursive:true,mode:0o700});
    const sourceRelative=relative(this.binding.canonicalPath,paths.runRoot);const trashRelative=proof.trashRelativePath??join("trash",cleanupOperationId.replace(/[^a-zA-Z0-9._-]/g,"_"));
    try{
      const removed=proof.reconcileFromTrash?this.nativeSafety.delete(this.binding.canonicalPath,proof.targetRelativePath,proof.nativeTreeIdentity):this.nativeSafety.remove(this.binding.canonicalPath,sourceRelative,trashRelative,proof.nativeTreeIdentity);
      const identity={device:removed.targetDeviceId,inode:removed.targetInode,bytes:removed.bytes,files:removed.files};
      return {outcome:"cleaned",sourceIdentityHash:evidenceHash({...identity,path:sourceRelative}),trashIdentityHash:evidenceHash({...identity,path:trashRelative}),bytesReclaimed:Number(removed.bytes),filesRemoved:Number(removed.files)};
    }catch(error){return {outcome:"quarantined",trashIdentityHash:null,bytesReclaimed:0,filesRemoved:0,errorCode:nativeErrorCode(error)};}
  }
}

function check(status,errorCode,evidence){return {status,errorCode,evidenceHash:status==="not_applicable"?null:evidenceHash(evidence)}}
function nativeErrorCode(error){return String(error?.message??error).match(/\bRUN_[A-Z0-9_]+\b/)?.[0]??"RUN_NATIVE_PROOF_INDETERMINATE"}
async function exists(path){try{await access(path);return true}catch(error){if(error?.code==="ENOENT")return false;throw error}}
