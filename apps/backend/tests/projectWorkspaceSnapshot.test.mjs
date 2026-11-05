import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as callback} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,chmod,readlink,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProjectWorkspaceSnapshotService} from '../src/application/projectWorkspaceSnapshotService.mjs';
import {GitWorkspaceManager} from '../src/runtime/gitWorkspaceManager.mjs';
import {mergeWorkspaceSnapshot,synchronizeWorkspaceSnapshot,prepareSnapshotConflictWorkspace} from '../src/runtime/workspaceSnapshotIntegration.mjs';
import {withWorktreeOperationLock} from '../src/runtime/worktreeOperationLock.mjs';
import {integrationBlocksWorkspaceCapture} from '../src/domain/worktreeCreationScope.mjs';
const exec=promisify(callback);
const git=async(path,args,env={})=>(await exec('git',['-C',path,...args],{encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0',...env}})).stdout;
const oid=async(path,ref='HEAD')=>(await git(path,['rev-parse',ref])).trim();
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'corptie-snapshot-test-')),path=join(dir,'parent');
  await mkdir(path);await git(path,['init','-b','main']);await git(path,['config','user.name','Tests']);await git(path,['config','user.email','tests@corptie.local']);await git(path,['config','commit.gpgsign','false']);
  await writeFile(join(path,'tracked.txt'),'original\n');await writeFile(join(path,'delete.txt'),'delete me\n');
  await writeFile(join(path,'.gitignore'),'ignored.tmp\n.corptie/\n');
  await git(path,['add','.']);await git(path,['commit','-m','Initial']);
  const initial=await oid(path), service=new ProjectWorkspaceSnapshotService();
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const capture=(operationId='startup:test',extra={})=>service.captureParentWorkspace({path,operationId,...extra});
  const child=async(base)=>{const p=join(dir,'child');await git(path,['worktree','add','-b','child',p,base.baseCommitOid]);return p;};
  const manager=new GitWorkspaceManager({store:{assertStandaloneWorktreeMutation(){},listGitRepositories:()=>[]}});
  return {dir,path,initial,service,capture,child,manager};
}

test('captures final working contents including partial staging, binary, deletion, rename and symlink without changing parent',async t=>{
 const f=await fixture(t),p=f.path;
 await writeFile(join(p,'tracked.txt'),'staged\n');await git(p,['add','tracked.txt']);await writeFile(join(p,'tracked.txt'),'working\n');
 await git(p,['mv','delete.txt','renamed.txt']);
 await writeFile(join(p,'新 文件.bin'),Buffer.from([0,255,13,10]));await writeFile(join(p,'ignored.tmp'),'private');
 await symlink('tracked.txt',join(p,'link'));await writeFile(join(p,'executable'),'#!/bin/sh\n');await chmod(join(p,'executable'),0o755);
 const indexPath=(await git(p,['rev-parse','--git-path','index'])).trim();
 const index=await readFile(join(p,indexPath)),status=await git(p,['status','--porcelain=v1']);
 const base=await f.capture();assert.equal(base.kind,'parent_workspace_snapshot');assert.equal(base.parentHeadOid,f.initial);
 assert.equal(await oid(p),f.initial);assert.deepEqual(await readFile(join(p,indexPath)),index);assert.equal(await git(p,['status','--porcelain=v1']),status);
 const c=await f.child(base);assert.equal(await readFile(join(c,'tracked.txt'),'utf8'),'working\n');
 assert.equal(await readFile(join(c,'renamed.txt'),'utf8'),'delete me\n');await assert.rejects(readFile(join(c,'delete.txt')),{code:'ENOENT'});
 assert.deepEqual(await readFile(join(c,'新 文件.bin')),Buffer.from([0,255,13,10]));assert.equal(await readlink(join(c,'link')),'tracked.txt');
 assert.ok((await stat(join(c,'executable'))).mode & 0o111);await assert.rejects(readFile(join(c,'ignored.tmp')),{code:'ENOENT'});
 assert.equal(await git(c,['status','--porcelain=v1']),'');assert.equal(await oid(c,'HEAD^{tree}'),base.baseTreeOid);
});

test('replay uses pinned snapshot even after parent changes, and fences changed ownership',async t=>{
 const f=await fixture(t);await writeFile(join(f.path,'tracked.txt'),'captured\n');
 const base=await f.capture('startup:replay',{bindingContext:{revision:1}});await writeFile(join(f.path,'tracked.txt'),'later\n');
 const replay=await f.capture('startup:replay',{bindingContext:{revision:1}});assert.equal(replay.baseCommitOid,base.baseCommitOid);
 await assert.rejects(f.capture('startup:replay',{bindingContext:{revision:2}}),{code:'TASK_DELIVERY_BINDING_CHANGED'});
});

test('clean source reuses HEAD and creates no snapshot ref',async t=>{
 const f=await fixture(t),base=await f.capture();assert.equal(base.baseCommitOid,f.initial);assert.equal(base.version,1);
 assert.equal(await git(f.path,['for-each-ref','refs/corptie/workspace-snapshots']),'');
});

test('concurrent edits are retried and sustained edits fail without touching parent index',async t=>{
 const f=await fixture(t);let calls=0;
 const service=new ProjectWorkspaceSnapshotService({git:async(p,args,env)=>{
   const result=await git(p,args,env);if(args[0]==='write-tree') await writeFile(join(p,'tracked.txt'),`edit ${++calls}\n`);return result;
 }});
 await assert.rejects(service.captureParentWorkspace({path:f.path,operationId:'changing'}),{code:'PARENT_WORKSPACE_CHANGING'});
 assert.equal(await oid(f.path),f.initial);assert.equal((await git(f.path,['show',':tracked.txt'])).trim(),'original');
});

test('snapshot merge applies only child delta and preserves later parent edits',async t=>{
 const f=await fixture(t);await writeFile(join(f.path,'inherited.txt'),'inherited\n');const base=await f.capture(),c=await f.child(base);
 await writeFile(join(c,'child.txt'),'child\n');await git(c,['add','.']);await git(c,['commit','-m','Child']);const childHead=await oid(c);
 await git(f.path,['add','.']);await git(f.path,['commit','-m','Parent inherited changes']);await writeFile(join(f.path,'parent.txt'),'parent\n');await git(f.path,['add','.']);await git(f.path,['commit','-m','Parent later']);
 const parentHead=await oid(f.path),input={mainPath:f.path,sourceHead:childHead,expectedMainHead:parentHead,snapshotBase:base,jobId:'test'};
 const result=await mergeWorkspaceSnapshot(f.manager,input);assert.equal(await readFile(join(f.path,'child.txt'),'utf8'),'child\n');
 assert.equal(await readFile(join(f.path,'parent.txt'),'utf8'),'parent\n');assert.equal(await readFile(join(f.path,'inherited.txt'),'utf8'),'inherited\n');
 assert.equal(result.snapshotReceipt.baseCommitOid,base.baseCommitOid);assert.equal(result.snapshotReceipt.resultTree,await oid(f.path,'HEAD^{tree}'));
 const replay=await mergeWorkspaceSnapshot(f.manager,{...input,allowRecordedMergeRecovery:true});assert.equal(replay.mainHead,result.mainHead);assert.equal(replay.recovered,true);
});

test('inherited-only child does not integrate the internal snapshot commit',async t=>{
 const f=await fixture(t);await writeFile(join(f.path,'tracked.txt'),'inherited\n');const base=await f.capture();
 await git(f.path,['restore','tracked.txt']);const result=await mergeWorkspaceSnapshot(f.manager,{mainPath:f.path,sourceHead:base.baseCommitOid,expectedMainHead:f.initial,snapshotBase:base});
 assert.equal(result.snapshotReceipt.noChanges,true);assert.equal(await oid(f.path),f.initial);assert.equal(await readFile(join(f.path,'tracked.txt'),'utf8'),'original\n');
});

test('unrelated parent state is not overwritten; real conflicts stay isolated and can use a snapshot-aware resolution workspace',async t=>{
 const f=await fixture(t);await writeFile(join(f.path,'tracked.txt'),'snapshot\n');const base=await f.capture(),c=await f.child(base);
 await writeFile(join(c,'tracked.txt'),'child\n');await git(c,['add','.']);await git(c,['commit','-m','Child']);const sourceHead=await oid(c);
 await writeFile(join(f.path,'tracked.txt'),'parent\n');await git(f.path,['add','.']);await git(f.path,['commit','-m','Parent']);const parentHead=await oid(f.path);
 await assert.rejects(mergeWorkspaceSnapshot(f.manager,{mainPath:f.path,sourceHead,expectedMainHead:parentHead,snapshotBase:base}),{code:'MERGE_CONFLICT'});
 assert.equal(await oid(f.path),parentHead);assert.equal(await git(f.path,['status','--porcelain=v1']),'');
 f.manager.store.getTaskDeliveryBinding=()=>({base_commit_oid:base.baseCommitOid,base_tree_oid:base.baseTreeOid});
 await assert.rejects(synchronizeWorkspaceSnapshot(f.manager,{path:c,targetHead:parentHead,expectedSourceHead:sourceHead,
   snapshotBase:{...base,taskId:'task:child'}}),{code:'REBASE_CONFLICT'});
 assert.equal(await oid(c),sourceHead);assert.equal(await git(c,['status','--porcelain=v1']),'');
 const resolution=join(f.dir,'resolution');await git(f.path,['worktree','add','-b','resolve',resolution,parentHead]);
 await prepareSnapshotConflictWorkspace(f.manager,{sourceHead,expectedMainHead:parentHead,snapshotBase:base},{path:resolution});
 assert.equal((await git(resolution,['rev-parse','MERGE_HEAD'])).trim(),sourceHead);
 await writeFile(join(resolution,'tracked.txt'),'resolved\n');await git(resolution,['add','.']);await git(resolution,['commit','-m','Resolve']);
 await git(f.path,['merge-base','--is-ancestor',parentHead,await oid(resolution)]);assert.equal(await oid(f.path),parentHead);
});

test('snapshot synchronization replays child changes without replaying inherited snapshot, and advances comparison baseline',async t=>{
 const f=await fixture(t);await writeFile(join(f.path,'inherited.txt'),'inherited\n');const base=await f.capture(),c=await f.child(base);
 await git(f.path,['add','.']);await git(f.path,['commit','-m','Parent inherited']);await writeFile(join(f.path,'later.txt'),'later\n');await git(f.path,['add','.']);await git(f.path,['commit','-m','Later']);
 await writeFile(join(c,'child.txt'),'child\n');await git(c,['add','.']);await git(c,['commit','-m','Child']);const head=await oid(c),target=await oid(f.path);
 let binding={base_commit_oid:base.baseCommitOid,base_tree_oid:base.baseTreeOid};
 f.manager.store.runInTransaction=fn=>fn();f.manager.store.getTaskDeliveryBinding=()=>binding;
 f.manager.store.db={run:(_sql,args)=>{binding={base_commit_oid:args[0],base_tree_oid:args[1]};}};f.manager.store.scheduleSave=()=>{};
 const snapshotBase={...base,taskId:'task:child'};
 await synchronizeWorkspaceSnapshot(f.manager,{path:c,expectedSourceHead:head,targetHead:target,snapshotBase});
 assert.equal(await readFile(join(c,'later.txt'),'utf8'),'later\n');assert.equal(await readFile(join(c,'child.txt'),'utf8'),'child\n');
 assert.equal(binding.base_commit_oid,target);assert.equal((await git(c,['diff','--name-only',target,'HEAD'])).trim(),'child.txt');
 await synchronizeWorkspaceSnapshot(f.manager,{path:c,expectedSourceHead:head,targetHead:target,snapshotBase,allowResolvedRebase:true});
});

test('dirty integration target is preserved',async t=>{
 const f=await fixture(t);await writeFile(join(f.path,'inherited.txt'),'inherited\n');const base=await f.capture(),c=await f.child(base);
 await writeFile(join(c,'child.txt'),'child\n');await git(c,['add','.']);await git(c,['commit','-m','Child']);
 await mergeWorkspaceSnapshot(f.manager,{mainPath:f.path,sourceHead:await oid(c),expectedMainHead:f.initial,snapshotBase:base});
 assert.equal(await readFile(join(f.path,'inherited.txt'),'utf8'),'inherited\n');
 assert.equal(await readFile(join(f.path,'child.txt'),'utf8'),'child\n');
 assert.notEqual(await oid(f.path),f.initial);
 assert.match(await git(f.path,['status','--porcelain=v1']),/inherited.txt/);
});

test('capture scopes permit unrelated branches and acceptance-only pauses, but fence actual parent writes',()=>{
 const job={phase:'merging',details:{plan:{targetWorktreeId:'other',items:[]}}};
 assert.equal(integrationBlocksWorkspaceCapture(job,'parent'),false);
 assert.equal(integrationBlocksWorkspaceCapture({...job,details:{plan:{targetWorktreeId:'parent',items:[]}}},'parent'),true);
 assert.equal(integrationBlocksWorkspaceCapture({phase:'awaiting_integration_acceptance',details:{plan:{writeWorktreeIds:['parent'],items:[]}}},'parent'),false);
 assert.equal(integrationBlocksWorkspaceCapture({details:{plan:{operationType:'sync',sourceWorktreeIds:['child'],targetWorktreeId:'parent'}}},'parent'),false);
 assert.equal(integrationBlocksWorkspaceCapture({details:{}},'parent'),true);
});

test('project worktree lock serializes writes with capture, allows independent worktrees and supports nested Git calls',async t=>{
 const f=await fixture(t),events=[];let release,entered;
 const started=new Promise(done=>entered=done),hold=new Promise(done=>release=done);
 const first=withWorktreeOperationLock(f.path,async()=>{events.push('first');entered();await hold;await withWorktreeOperationLock(f.path,async()=>events.push('nested'));});
 await started;const second=withWorktreeOperationLock(f.path,async()=>events.push('second'));
 await withWorktreeOperationLock(f.dir,async()=>events.push('independent'));assert.deepEqual(events,['first','independent']);
 release();await Promise.all([first,second]);assert.deepEqual(events,['first','independent','nested','second']);
});

test('parent discarding inherited content does not get that content reintroduced by a child delta',async t=>{
 const f=await fixture(t);await writeFile(join(f.path,'inherited.txt'),'temporary parent content\n');const base=await f.capture(),c=await f.child(base);
 await rm(join(f.path,'inherited.txt'));await writeFile(join(c,'delta.txt'),'child delta\n');await git(c,['add','.']);await git(c,['commit','-m','Delta']);
 await mergeWorkspaceSnapshot(f.manager,{mainPath:f.path,sourceHead:await oid(c),expectedMainHead:f.initial,snapshotBase:base});
 await assert.rejects(readFile(join(f.path,'inherited.txt')),{code:'ENOENT'});assert.equal(await readFile(join(f.path,'delta.txt'),'utf8'),'child delta\n');
});

test('dirty submodule contents are explicitly rejected instead of silently capturing the old gitlink',async t=>{
 const f=await fixture(t),sub=join(f.dir,'sub');await mkdir(sub);await git(sub,['init','-b','main']);
 await git(sub,['config','user.name','Tests']);await git(sub,['config','user.email','tests@corptie.local']);
 await writeFile(join(sub,'sub.txt'),'base\n');await git(sub,['add','.']);await git(sub,['commit','-m','Initial']);
 await git(f.path,['-c','protocol.file.allow=always','submodule','add',sub,'sub']);await git(f.path,['commit','-am','Submodule']);
 await writeFile(join(f.path,'sub','sub.txt'),'dirty\n');await assert.rejects(f.capture(),{code:'PARENT_SUBMODULE_DIRTY'});
 assert.equal(await readFile(join(f.path,'sub','sub.txt'),'utf8'),'dirty\n');
});

test('released stale integration plan does not reserve the parent while live/unverified targets remain fenced',()=>{
 const details={resumeRequiresReplan:true,dispatchRevision:21,plan:{writeWorktreeIds:['parent'],items:[]},
   dispatchSafety:{verifiedRevision:21,safeWorktrees:[{worktreeId:'parent'}],blockedWorktreeIds:[]}};
 const job={status:'paused',phase:'failed',details};
 assert.equal(integrationBlocksWorkspaceCapture(job,'parent'),false);
 assert.equal(integrationBlocksWorkspaceCapture({...job,status:'running'},'parent'),true);
 assert.equal(integrationBlocksWorkspaceCapture({...job,details:{...details,resumeRequiresReplan:false}},'parent'),true);
 assert.equal(integrationBlocksWorkspaceCapture({...job,details:{...details,dispatchSafety:{...details.dispatchSafety,verifiedRevision:20}}},'parent'),true);
 assert.equal(integrationBlocksWorkspaceCapture({...job,details:{...details,dispatchSafety:{...details.dispatchSafety,blockedWorktreeIds:['parent']}}},'parent'),true);
 assert.equal(integrationBlocksWorkspaceCapture({...job,details:{...details,dispatchSafety:{...details.dispatchSafety,safeWorktrees:[]}}},'parent'),true);
});
