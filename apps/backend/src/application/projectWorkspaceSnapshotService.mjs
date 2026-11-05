import { measureStartup } from "../utils/startupTiming.mjs";
import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withWorktreeOperationLock } from "../runtime/worktreeOperationLock.mjs";

const execFile = promisify(callback);
const failure = code => Object.assign(new Error(code), { code, statusCode:409, retryable:true });
const identity = { GIT_AUTHOR_NAME:"Corptie", GIT_AUTHOR_EMAIL:"snapshot@corptie.local",
  GIT_COMMITTER_NAME:"Corptie", GIT_COMMITTER_EMAIL:"snapshot@corptie.local" };

export class ProjectWorkspaceSnapshotService {
  constructor({ git = null } = {}) { this.execGit = git; }
  async git(path, args, env = {}) {
    if (this.execGit) return this.execGit(path,args,env);
    return (await execFile("git",["-C",path,...args],{encoding:"utf8",maxBuffer:16*1024*1024,
      timeout:120000,env:{...process.env,GIT_OPTIONAL_LOCKS:"0",...env}})).stdout;
  }
  async captureParentWorkspace({path, operationId, bindingContext = null, startupTiming = null, validate = async()=>{}}) {
    return measureStartup(startupTiming,"snapshot.wait-and-capture",()=>withWorktreeOperationLock(path, async()=>{
      await validate();
      const encoded=Buffer.from(operationId).toString("hex");
      // Lossless encoding, no extra digest. Keep each ref path component below
      // filesystem NAME_MAX when an operation includes an exact source path.
      const ref = `refs/corptie/workspace-snapshots/${encoded.match(/.{1,200}/g).join("/")}`;
      const existing = await this.git(path,["rev-parse","--verify","--quiet",ref]).catch(error=>{
        if ([1,128].includes(error.code)) return "";
        throw error;
      });
      if (existing.trim()) {
        const oid=existing.trim();
        const message=(await this.git(path,["show","-s","--format=%B",oid])).trim();
        if(message!==`Corptie parent workspace snapshot\n${JSON.stringify(bindingContext)}`) throw failure("TASK_DELIVERY_BINDING_CHANGED");
        return {version:2,kind:"parent_workspace_snapshot",snapshotRef:ref,baseCommitOid:oid,
          baseTreeOid:(await this.git(path,["rev-parse",`${oid}^{tree}`])).trim(),
          parentHeadOid:(await this.git(path,["rev-parse",`${oid}^`])).trim(),captureMode:"working_tree"};
      }
      const directory=await mkdtemp(join(tmpdir(),"corptie-workspace-snapshot-"));
      try {
        const indexPath=(await this.git(path,["rev-parse","--path-format=absolute","--git-path","index"])).trim();
        const indexBytes=()=>readFile(indexPath).catch(error=>{if(error.code==='ENOENT') return Buffer.alloc(0);throw error;});
        for(let attempt=0;attempt<3;attempt++) {
          const head=(await this.git(path,["rev-parse","HEAD"])).trim(), before=await indexBytes();
          const status=await this.git(path,["status","--porcelain=v2","-z","--ignore-submodules=none"]);
          if(status.split("\0").some(line=>/^[12] /.test(line) && /^S(?!\.\.\.)/.test(line.split(" ")[2]))) {
            throw failure("PARENT_SUBMODULE_DIRTY");
          }
          const trees=[];
          for(let pass=0;pass<2;pass++) {
            const env={GIT_INDEX_FILE:join(directory,`index-${attempt}-${pass}`)};
            await this.git(path,["read-tree",head],env);
            await measureStartup(startupTiming,pass===0 ? "snapshot.capture" : "snapshot.verify",()=>this.git(path,["add","--all","--","."],env));
            trees.push((await this.git(path,["write-tree"],env)).trim());
          }
          await validate();
          if(trees[0]!==trees[1] || head!==(await this.git(path,["rev-parse","HEAD"])).trim()
            || !before.equals(await indexBytes())) continue;
          const tree=trees[0], headTree=(await this.git(path,["rev-parse",`${head}^{tree}`])).trim();
          // Clean parents retain the old HEAD baseline without another object/ref.
          if(tree===headTree) return {version:1,kind:"parent",baseCommitOid:head,baseTreeOid:tree};
          const oid=(await this.git(path,["-c","commit.gpgsign=false","commit-tree",tree,"-p",head,"-m",`Corptie parent workspace snapshot\n${JSON.stringify(bindingContext)}`],identity)).trim();
          await this.git(path,["update-ref",ref,oid,"0".repeat(oid.length)]);
          return {version:2,kind:"parent_workspace_snapshot",parentHeadOid:head,baseCommitOid:oid,
            baseTreeOid:tree,snapshotRef:ref,capturedAt:new Date().toISOString(),captureMode:"working_tree"};
        }
        throw failure("PARENT_WORKSPACE_CHANGING");
      } finally { await rm(directory,{recursive:true,force:true}); }
    }));
  }
}
