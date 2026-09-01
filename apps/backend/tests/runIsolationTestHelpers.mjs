import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DataRootVerifier } from "../src/runIsolation/dataRootVerifier.mjs";
import { RunIsolationService } from "../src/runIsolation/runIsolationService.mjs";
import { DEPENDENCY_CONTRACT_MANIFEST, projectToolsetValidationReceiptPointer } from "../src/runIsolation/dependencyContractManifest.mjs";
import { receiptHash } from "../src/runIsolation/receiptContracts.mjs";

export const startupRef = Object.freeze({
  startupOperationId:"startup:test",receiptHash:"a".repeat(64),schemaVersion:2,resourceVersion:1,
  artifactRef:{artifactId:"artifact:7f26689a-5b9a-4b32-ad86-ad93c0be2949",version:1,contentHash:"472b8c34180f2c1e7f7b59d7e2c8fc620ec515971a56e5f8ecae6fe69a0aced2",relation:"implementation_spec",receiptType:"StartupBindingReceipt",schemaVersion:2}
});
export const session = Object.freeze({logicalSessionId:"logical:test",taskId:"task:test",repositoryId:null,worktreeId:null});

export async function fixture(t,{clock=()=>new Date("2026-08-30T00:00:00.000Z"),uuid=undefined,serviceOptions={}}={}){
  const root=await mkdtemp("/Volumes/T9/corptie-run-isolation-test-");await mkdir(root,{recursive:true});const info=await stat(root,{bigint:true});
  const verifier=new DataRootVerifier({homeDirectory:"/Users/test",clock,volumeInspector:async()=>({external:true,volumeUUID:"volume:test",mountPoint:"/Volumes/T9",filesystemType:"apfs"})});
  const service=new RunIsolationService({dataRoot:root,dataRootVerifier:verifier,reserveBytes:0,quotaBytes:16*1024*1024,clock,...(uuid?{uuid}:{}),...serviceOptions});await service.initialize();
  t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true})});return {root,service,info};
}

export function prepareInput(overrides={}){return {mode:"test",sourceAware:false,startupBindingReceiptRef:startupRef,repositorySourceSnapshotReceiptRef:null,toolsetValidationReceiptPointer:null,idempotencyKey:"prepare-1",...overrides}}

export function toolsetFixture({receiptId="toolset_validation_receipt:shared",sourceFingerprint="d".repeat(64),authority={logicalSessionId:"logical:test",taskId:"task:test",repositoryId:"repository:a",worktreeId:"worktree:a"}}={}) {
  const contractRef=(contract)=>({artifactId:contract.artifactId,version:contract.version,contentHash:contract.contentHash,relation:"implementation_spec",receiptType:contract.receiptType,schemaVersion:contract.schemaVersion});
  const snapshotRef={receiptId:"snapshot:shared",receiptHash:"e".repeat(64),sourceFingerprint,schemaVersion:1,resourceVersion:1,artifactRef:contractRef(DEPENDENCY_CONTRACT_MANIFEST.repositorySourceSnapshot)};
  const receipt={receiptId,receiptHash:"0".repeat(64),schemaVersion:3,resourceVersion:1,artifactRef:contractRef(DEPENDENCY_CONTRACT_MANIFEST.toolsetValidation),identity:{logicalSessionId:authority.logicalSessionId,objectiveId:"objective:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",taskId:authority.taskId,repositoryId:authority.repositoryId,worktreeId:authority.worktreeId,startupBindingRef:{artifactId:DEPENDENCY_CONTRACT_MANIFEST.startupBinding.artifactId,artifactVersion:1,artifactContentHash:DEPENDENCY_CONTRACT_MANIFEST.startupBinding.contentHash,startupOperationId:"startup:test",startupReceiptHash:"a".repeat(64)}},snapshotRef,toolsetVersion:`ptv1:${"b".repeat(64)}`,validationPlanIdentity:`vp1:${"c".repeat(64)}`,validationCacheKey:`tvck1:${"f".repeat(64)}`,actionReceipts:[],assertionReceipts:[],cacheDisposition:"stored",outcome:"passed",startedAt:"2026-08-29T23:59:00.000Z",finishedAt:"2026-08-29T23:59:30.000Z",expiresAt:"2026-08-30T01:00:00.000Z",error:null};
  receipt.receiptHash=receiptHash(receipt);
  return {authority,snapshotRef,receipt,pointer:projectToolsetValidationReceiptPointer(receipt,sourceFingerprint,authority,DEPENDENCY_CONTRACT_MANIFEST,new Date("2026-08-30T00:00:00.000Z"))};
}
