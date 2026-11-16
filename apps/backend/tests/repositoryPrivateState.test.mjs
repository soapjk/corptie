import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateRepositoryGitState, readRepositoryPrivateState, ownerStatePath } from "../src/runtime/repositoryPrivateState.mjs";
import { GitCommitProtection } from "../src/runtime/gitCommitProtection.mjs";
const run = promisify(execFile);
async function fixture(t) {
 const root = await realpath(await mkdtemp(join(tmpdir(), "corptie-git-state-")));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const git = async (cwd,args) => (await run("git",["-C",cwd,...args],{encoding:"utf8"})).stdout;
 await git(root,["init","-b","main"]);
 await git(root,["-c","user.name=Test","-c","user.email=test@example.invalid","-c","commit.gpgsign=false","commit","--allow-empty","-m","initial"]);
 return {root,git};
}

test("one-way migration preserves preferences and owners in private state, leaving unrelated config and ignore files intact",async t=>{
 const {root,git}=await fixture(t);
 await git(root,["config","corptie-task-worktree.abcd.task-id","task:abcd-task"]);
 await git(root,["config","corptie.privateFilesWarning","false"]);
 await git(root,["config","user.name","User Name"]);
 await git(root,["config","corptie.unrecognized","user-owned"]);
 const exclude=join(root,".git/info/exclude"),before=await readFile(exclude,"utf8");
 await migrateRepositoryGitState(root,git);
 assert.deepEqual(await readRepositoryPrivateState(root,ownerStatePath("abcd")),{taskId:"task:abcd-task"});
 assert.equal((await git(root,["config","user.name"])).trim(),"User Name");
 assert.equal((await git(root,["config","corptie.unrecognized"])).trim(),"user-owned");
 await assert.rejects(git(root,["config","--local","--get","corptie.privateFilesWarning"]));
 await assert.rejects(git(root,["config","--local","--get","corptie-task-worktree.abcd.task-id"]));
 await migrateRepositoryGitState(root,git);
 assert.equal(await readFile(exclude,"utf8"),before);
 const linked=root+"-linked";t.after(()=>rm(linked,{recursive:true,force:true}));
 await git(root,["worktree","add","-b","linked",linked]);
 assert.equal(await new GitCommitProtection({rules:[]}).warningEnabled(linked),false);
 assert.equal((await git(root,["status","--porcelain"])).trim(),"");
});

test("state migration never removes old config when local state is unsafe or conflicts",async t=>{
 const {root,git}=await fixture(t);
 const other=join(root,"outside");await mkdir(other);await symlink(other,join(root,".corptie"));
 await git(root,["config","corptie-task-worktree.abcd.task-id","task:owned"]);
 await assert.rejects(migrateRepositoryGitState(root,git));
 assert.equal((await git(root,["config","corptie-task-worktree.abcd.task-id"])).trim(),"task:owned");
 await assert.rejects(readFile(join(other,"git/task-worktrees/abcd.json")),{code:"ENOENT"});
});

test("read-only preference inspection does not create private files or alter Git config",async t=>{
 const {root}=await fixture(t);
 const config=join(root,".git/config"),before=await readFile(config);
 assert.equal(await new GitCommitProtection({rules:[]}).warningEnabled(root),true);
 await assert.rejects(readFile(join(root,".corptie/.gitignore")),{code:"ENOENT"});
 assert.deepEqual(await readFile(config),before);
});
