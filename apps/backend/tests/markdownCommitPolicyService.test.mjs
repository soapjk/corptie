import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,mkdir,readFile,realpath,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CorptieStore} from "../src/store/corptieStore.mjs";
import {ArtifactService} from "../src/application/artifactService.mjs";
import {MarkdownCommitPolicyService,validateDecisions} from "../src/application/markdownCommitPolicyService.mjs";
import {GitWorkspaceManager} from "../src/runtime/gitWorkspaceManager.mjs";
import {ensureArtifactCommitHook} from "../src/runtime/artifactCommitHook.mjs";
import {createGitWorkspaceSnapshot} from "../src/utils/gitWorktreeInventory.mjs";

async function fixture(t,{owner=true}={}) {
  const directory=await realpath(await mkdtemp(join(tmpdir(),"standalone-markdown-"))),root=join(directory,"repo");
  await mkdir(root);
  const git=(...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  git("init","-b","main");git("config","user.name","Fixture");git("config","user.email","fixture@example.invalid");git("config","commit.gpgsign","false");
  await writeFile(join(root,"README.md"),"existing\n");git("add","README.md");git("commit","-m","Base");
  const store=new CorptieStore({dbPath:join(directory,"state.sqlite"),configPath:join(directory,"config.json"),manageProcessEnvironment:false});
  await store.initialize({resolveDataPath:false});
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
  const snapshot=await createGitWorkspaceSnapshot(root);store.upsertGitWorkspaceSnapshot(snapshot);
  const repository=store.getGitRepository(snapshot.repository.id),workspace=store.listGitWorktrees(repository.id).find(tree=>tree.isMain);
  if(owner) {
    const agent=store.createAgent({name:"Fixture",role:"independentContributor"});
    store.createWork({name:"Fixture",workspaceId:repository.workspaceId,contributorAgentIds:[agent.agentId]});
  }
  const artifactService=new ArtifactService({store,contentRoot:join(directory,"artifacts"),
    ensureCommitHook:path=>ensureArtifactCommitHook(path,{dbPath:store.dbPath})});
  await artifactService.initialize();await ensureArtifactCommitHook(root,{dbPath:store.dbPath});
  const manager=new GitWorkspaceManager({store}),service=new MarkdownCommitPolicyService({store,gitWorkspaces:manager,artifactService});
  const context={project:{id:repository.id,mainPath:root},workspace};
  const prepare=()=>service.inspectCommitPolicy(context);
  const commit=(reviewId,decisions,extra={})=>service.commit(context,{reviewId,commitMessage:"User supplied message",decisions,...extra},async()=>null);
  return {directory,root,git,store,manager,service,artifactService,context,prepare,commit};
}

test("one main commit applies four different Markdown decisions, with a real hook and exact receipts",async t=>{
  const f=await fixture(t);
  for(const name of ["track.md","ignore.md","delete.md","artifact.md"]) await writeFile(join(f.root,name),`${name}\n`);
  await writeFile(join(f.root,"code.js"),"export const answer=42;\n");
  await writeFile(join(f.root,"README.md"),"edited existing document\n");
  f.git("add","ignore.md");
  const beforeIndex=f.git("ls-files","--stage"),beforeStatus=f.git("status","--porcelain=v1");
  const prepared=await f.prepare();
  assert.equal(f.git("ls-files","--stage"),beforeIndex);
  assert.equal(f.git("status","--porcelain=v1"),beforeStatus);
  assert.equal(prepared.commitPolicyBlocker.files.length,4);
  const decisions=[{path:"track.md",action:"track"},{path:"ignore.md",action:"ignore"},{path:"delete.md",action:"delete"},{path:"artifact.md",action:"artifact"}];
  const result=await f.commit(prepared.reviewId,decisions);
  assert.equal(result.committed,true);
  assert.equal(f.git("log","-1","--format=%s").trim(),"User supplied message");
  assert.equal(f.git("status","--porcelain=v1").trim(),"");
  const files=f.git("ls-tree","-r","--name-only","HEAD");
  assert.ok(files.includes("track.md"));assert.ok(files.includes("code.js"));
  for(const name of ["ignore.md","delete.md","artifact.md"]) assert.ok(!files.split("\n").includes(name));
  assert.equal(await readFile(join(f.root,"ignore.md"),"utf8"),"ignore.md\n");
  await assert.rejects(readFile(join(f.root,"artifact.md")),{code:"ENOENT"});
  assert.equal(f.store.selectAll("SELECT * FROM artifacts").length,2);
  assert.equal(f.store.selectAll("SELECT * FROM artifact_repository_promotions").length,1);
  const head=f.git("rev-parse","HEAD");
  assert.equal((await f.commit(prepared.reviewId,decisions)).headOid,result.headOid);
  assert.equal(f.git("rev-parse","HEAD"),head);
});

test("an older commit client receives a blocker and can submit its decisions without restarting the operation",async t=>{
  const f=await fixture(t);await writeFile(join(f.root,"new.md"),"new\n");
  let blocker;
  await assert.rejects(f.commit(undefined,undefined),error=>{blocker=error.commitPolicyBlocker;return error.code==="GIT_ARTIFACT_POLICY_REJECTED";});
  assert.equal((await f.commit(blocker.id,[{path:"new.md",action:"ignore"}])).committed,true);
});

test("same-status content changes invalidate review before any file action",async t=>{
  const f=await fixture(t);await writeFile(join(f.root,"one.md"),"first\n");await writeFile(join(f.root,"code.js"),"one\n");
  const prepared=await f.prepare();await writeFile(join(f.root,"code.js"),"two\n");
  await assert.rejects(f.commit(prepared.reviewId,[{path:"one.md",action:"delete"}]),{code:"COMMIT_REVIEW_CHANGED"});
  assert.equal(await readFile(join(f.root,"one.md"),"utf8"),"first\n");
});

test("switching branches at the same HEAD invalidates the reviewed commit target",async t=>{
  const f=await fixture(t);await writeFile(join(f.root,"one.md"),"keep\n");
  const prepared=await f.prepare();f.git("switch","-c","other");
  await assert.rejects(f.commit(prepared.reviewId,[{path:"one.md",action:"delete"}]),{code:"COMMIT_REVIEW_CHANGED"});
  assert.equal(await readFile(join(f.root,"one.md"),"utf8"),"keep\n");
});

test("Ignore preserves existing gitignore changes and does not create a blank commit",async t=>{
  const f=await fixture(t);await writeFile(join(f.root,".gitignore"),"/user-rule/\n");await writeFile(join(f.root,"one.md"),"keep\n");
  const prepared=await f.prepare();await f.commit(prepared.reviewId,[{path:"one.md",action:"ignore"}]);
  assert.equal(await readFile(join(f.root,".gitignore"),"utf8"),"/user-rule/\n/one.md\n");
  await writeFile(join(f.root,"two.md"),"remove\n");
  const next=await f.prepare(),before=f.git("rev-parse","HEAD");
  const result=await f.commit(next.reviewId,[{path:"two.md",action:"delete"}]);
  assert.equal(result.noChanges,true);assert.equal(f.git("rev-parse","HEAD"),before);
});

test("partial failures preserve the applied prefix and retries do not repeat it",async t=>{
  const f=await fixture(t);for(const name of ["a.md","b.md"])await writeFile(join(f.root,name),"keep\n");
  const prepared=await f.prepare(),decisions=[{path:"a.md",action:"artifact"},{path:"b.md",action:"artifact"}];
  const create=f.artifactService.create.bind(f.artifactService);let once=true;
  f.artifactService.create=async(context,input)=>{if(input.title==="b.md"&&once){once=false;throw new Error("storage unavailable");}return create(context,input);};
  await assert.rejects(f.commit(prepared.reviewId,decisions),error=>{
    assert.equal(error.commitPolicyBlocker.files[0].appliedAction,"artifact");return /storage unavailable/.test(error.message);
  });
  assert.equal(await readFile(join(f.root,"b.md"),"utf8"),"keep\n");
  const result=await f.commit(prepared.reviewId,decisions);
  assert.equal(result.noChanges,true);
  assert.equal(f.store.selectAll("SELECT * FROM artifacts").length,2);
});

test("missing ownership and paired-device authority cannot manufacture local-user tracking consent",async t=>{
  const f=await fixture(t,{owner:false});await writeFile(join(f.root,"one.md"),"keep\n");
  const prepared=await f.prepare();assert.deepEqual(prepared.commitPolicyBlocker.files[0].supportedActions,["ignore","delete"]);
  await assert.rejects(f.commit(prepared.reviewId,[{path:"one.md",action:"track"}]),{code:"COMMIT_POLICY_ACTION_UNSUPPORTED"});
  const device={...f.context,authority:{kind:"paired_device"}},deviceReview=await f.service.inspectCommitPolicy(device);
  await assert.rejects(f.service.commit(f.context,{reviewId:deviceReview.reviewId,commitMessage:"Message",decisions:[{path:"one.md",action:"delete"}]},async()=>null),{code:"COMMIT_REVIEW_SCOPE_MISMATCH"});
});

test("symlink files, symlink parents, and an unsafe gitignore never become Markdown decision targets",async t=>{
  const f=await fixture(t);await writeFile(join(f.directory,"outside.md"),"outside\n");
  await symlink(join(f.directory,"outside.md"),join(f.root,"link.md"));
  await assert.rejects(f.prepare(),{code:"INTEGRATION_STAGED_TREE_REJECTED"});
  await rm(join(f.root,"link.md"));await writeFile(join(f.root,"one.md"),"keep\n");
  const prepared=await f.prepare();await symlink(join(f.directory,"outside.md"),join(f.root,".gitignore"));
  await assert.rejects(f.commit(prepared.reviewId,[{path:"one.md",action:"ignore"}]));
  assert.equal(await readFile(join(f.directory,"outside.md"),"utf8"),"outside\n");
});

test("an unrelated edit during a decision is not absorbed into the operation's own changes",async t=>{
  const f=await fixture(t);await writeFile(join(f.root,"one.md"),"remove\n");await writeFile(join(f.root,"code.js"),"before\n");
  const prepared=await f.prepare(),remove=f.manager.deleteIntegrationMarkdownFile.bind(f.manager);
  f.manager.deleteIntegrationMarkdownFile=async input=>{const result=await remove(input);await writeFile(join(f.root,"code.js"),"external\n");return result;};
  await assert.rejects(f.commit(prepared.reviewId,[{path:"one.md",action:"delete"}]),{code:"COMMIT_REVIEW_CHANGED"});
  assert.equal(f.git("log","--format=%s").trim(),"Base");
});

test("duplicate commit requests share one flight and expired review never replays mutations",async t=>{
  const f=await fixture(t);await writeFile(join(f.root,"one.md"),"keep\n");
  const prepared=await f.prepare(),decisions=[{path:"one.md",action:"track"}];
  const [a,b]=await Promise.all([f.commit(prepared.reviewId,decisions),f.commit(prepared.reviewId,decisions)]);
  assert.equal(a.headOid,b.headOid);assert.equal(f.store.selectAll("SELECT * FROM artifacts").length,1);
  f.service.now=()=>Date.now()+20*60_000;
  await assert.rejects(f.commit(prepared.reviewId,decisions),{code:"COMMIT_REVIEW_EXPIRED"});
});

test("decision validation rejects duplicate, incomplete, unknown and changed applied choices",()=>{
  const files=[{path:"one.md",supportedActions:["ignore","delete"]}];
  for(const entries of [[],[{path:"two.md",action:"delete"}],[{path:"one.md",action:"delete"},{path:"one.md",action:"delete"}]])
    assert.throws(()=>validateDecisions(files,entries),{code:"COMMIT_POLICY_DECISION_INCOMPLETE"});
  assert.throws(()=>validateDecisions([{...files[0],appliedAction:"ignore"}],[{path:"one.md",action:"delete"}]),{code:"COMMIT_POLICY_DECISION_CHANGED"});
});
