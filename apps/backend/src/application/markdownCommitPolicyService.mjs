import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { sessionHasActiveRun } from "../utils/sessionPresentation.mjs";

const fail=(code,message)=>Object.assign(new Error(message),{code,statusCode:409});
export const MARKDOWN_COMMIT_ACTIONS=Object.freeze(["ignore","delete","artifact","track"]);
export function validateDecisions(files, entries, {supportedActions=null}={}) {
  if(!Array.isArray(entries)) throw Object.assign(fail("COMMIT_POLICY_DECISION_INCOMPLETE","Choose an action for every Markdown file."),{statusCode:400});
  const decisions=new Map(entries.map(entry=>[entry?.path,entry?.action]));
  if(entries.length!==files.length || decisions.size!==files.length || files.some(file=>!decisions.has(file.path)))
    throw Object.assign(fail("COMMIT_POLICY_DECISION_INCOMPLETE","Choose exactly one action for every Markdown file."),{statusCode:400});
  for(const file of files) {
    const action=decisions.get(file.path);
    if(!(supportedActions??file.supportedActions??MARKDOWN_COMMIT_ACTIONS).includes(action)) throw Object.assign(fail("COMMIT_POLICY_ACTION_UNSUPPORTED",`Unsupported action for ${file.path}.`),{statusCode:400});
    if(file.appliedAction && file.appliedAction!==action) throw fail("COMMIT_POLICY_DECISION_CHANGED",`${file.path} was already handled as ${file.appliedAction}.`);
  }
  return decisions;
}

// Shared Artifact boundary. The caller supplies trusted ownership and optional
// integration-only propagation; standalone commits never propagate consent.
export function createMarkdownArtifactDecision({store,gitWorkspaces,artifactService,resolveOwner,trackingTargets=async()=>[]}) {
  return async(input,{removeSource,allowTracking})=>{
    const binding=resolveOwner(input);
    const file=await gitWorkspaces.readIntegrationMarkdownFile({path:input.item.path,relativePath:input.relativePath,expectedContentHash:input.expectedContentHash});
    const identity=createHash("sha256").update([input.jobId,input.blockerId,input.relativePath,input.expectedContentHash,allowTracking?"track":"artifact"].join("\0")).digest("hex");
    const context={kind:"local_user",actorId:"user:local-macos",workId:binding.workId};
    const artifact=await artifactService.create(context,{
      artifactId:`artifact:worktree-markdown:${identity}`,title:basename(input.relativePath),
      summary:`Captured from Worktree Markdown decision for ${input.relativePath}.`,content:file.content,mimeType:"text/markdown",
      visibility:binding.taskId?"task_private":"work_private",scope:binding.taskId?"task":"work",
      ...(binding.taskId?{boundTaskId:binding.taskId}:{}),kind:"document",categoryPath:"worktree-markdown",tags:["worktree","markdown"],sourceEventId:input.decisionId
    });
    if(allowTracking) {
      await artifactService.promoteExistingRepositoryFileFromUserDecision(context,artifact.artifactId,{
        repositoryPath:file.repositoryRoot,path:file.relativePath,version:artifact.currentVersion,contentHash:file.contentHash,decisionId:input.decisionId
      });
      for(const targetPath of await trackingTargets(input,file.repositoryRoot))
        await artifactService.promoteExistingRepositoryFileFromUserDecision(context,artifact.artifactId,{
          repositoryPath:targetPath,sourceRepositoryPath:file.repositoryRoot,integrationJobId:input.jobId,
          path:file.relativePath,version:artifact.currentVersion,contentHash:file.contentHash,decisionId:`${input.decisionId}:target:${targetPath}`
        });
    }
    if(removeSource) await gitWorkspaces.deleteIntegrationMarkdownFile({...input,path:input.item.path});
    return {artifactId:artifact.artifactId,version:artifact.currentVersion};
  };
}

// Bounded, process-local review state, not a durable Job. After restart a new
// explicit review is required; no file mutation or commit is replayed.
export class MarkdownCommitPolicyService {
  constructor({store,gitWorkspaces,artifactService,now=()=>Date.now()}) {
    Object.assign(this,{store,gitWorkspaces,artifactService,now});
    this.reviews=new Map();this.inFlight=new Map();
    this.artifactDecision=createMarkdownArtifactDecision({store,gitWorkspaces,artifactService,resolveOwner:input=>input.owner});
  }
  owners(repositoryId) {
    const repository=this.store.getGitRepository(repositoryId);
    if(!repository?.workspaceId) return [];
    return this.store.selectAll("SELECT id AS workId,name AS title FROM works WHERE workspace_id=? AND status='active' ORDER BY id",[repository.workspaceId]);
  }
  async inspect(context) {
    return this.gitWorkspaces.inspectWorktreeCommitPolicy({path:context.workspace.path,repositoryId:context.project.id,
      verifyPromotion:fixed=>this.artifactService.verifyRepositoryPromotion(fixed)});
  }
  blocker(review) {
    return {id:review.id,version:review.version,worktreeId:review.worktreeId,branchName:review.branchName,
      checkedAt:review.checkedAt,files:review.files.map(file=>({...file})),artifactOwners:review.owners};
  }
  preparation(review) {
    return {schemaVersion:2,reviewId:review.id,commitPolicyBlocker:review.files.length?this.blocker(review):null};
  }
  async inspectCommitPolicy(context) {
    for(const [id,review] of this.reviews) if(review.expiresAt<this.now() && !this.inFlight.has(id)) this.reviews.delete(id);
    if(this.reviews.size>=100) throw fail("COMMIT_REVIEW_CAPACITY","Too many pending commit reviews. Close or expire previous reviews.");
    const inspection=await this.inspect(context),owners=this.owners(context.project.id);
    if(inspection.violations.length) throw Object.assign(fail("INTEGRATION_STAGED_TREE_REJECTED","The commit contains paths that cannot be authorized through Markdown decisions."),{violations:inspection.violations});
    const review={id:`commit_review:${randomUUID()}`,version:1,repositoryId:context.project.id,worktreeId:context.workspace.worktreeId,
      branchName:context.workspace.branchName??null,path:inspection.repositoryRoot,inspection,
      authority:context.authority?.kind??"local_user",owners,files:inspection.files.map(file=>({...file,
        supportedActions:owners.length && (context.authority?.kind??"local_user")==="local_user" ? file.supportedActions : ["ignore","delete"]})),
      checkedAt:new Date(this.now()).toISOString(),expiresAt:this.now()+10*60_000};
    this.reviews.set(review.id,review);
    return this.preparation(review);
  }
  assertWritable(context) {
    this.store.assertStandaloneWorktreeMutation?.({worktreeIds:[context.workspace.worktreeId]});
    for(const logical of this.store.listLogicalSessionsByWorkspaceId?.(context.workspace.worktreeId)??[]) {
      if(sessionHasActiveRun(this.store.getSession(logical.legacySessionId)) || this.store.hasUnsettledSessionRuntimeWork?.(logical.legacySessionId))
        throw fail("REPOSITORY_BUSY","A Session is executing in this Worktree. Wait for it to settle before committing.");
    }
    const jobs=this.store.selectAll(`SELECT details_json FROM worktree_integration_jobs WHERE repository_id=?
      AND status IN ('queued','running','paused','cancellation_requested','replanning')`,[context.project.id]);
    const busy=jobs.some(row=>{
      let details;try {details=JSON.parse(row.details_json);} catch {return true;}
      return !details?.plan?.reservedWorktreeIds || details.plan.reservedWorktreeIds.includes(context.workspace.worktreeId);
    });
    if(busy) throw fail("REPOSITORY_BUSY","An integration already owns this Worktree. Continue or cancel it before committing.");
  }
  async assertReviewFresh(review,context) {
    const current=await this.inspect(context);
    if(current.state!==review.inspection.state || current.repositoryRoot!==review.path)
      throw fail("COMMIT_REVIEW_CHANGED","The Worktree changed after review. Review the latest files before committing.");
    return current;
  }
  assertExpectedChange(before,after,allowedPaths) {
    const allowed=new Set(allowedPaths);
    const unchanged=inspection=>JSON.stringify([
      inspection.headOid,inspection.headRef,inspection.versions.filter(([path])=>!allowed.has(path)),
      inspection.indexEntries.filter(entry=>!allowed.has(entry.slice(entry.indexOf("\t")+1)))
    ]);
    if(unchanged(before)!==unchanged(after)) throw fail("COMMIT_REVIEW_CHANGED","Unrelated files or index entries changed while decisions were applied. Review again.");
  }
  async applyDecision(context,review,file,action,input) {
    const common={repositoryId:review.repositoryId,jobId:review.id,blockerId:review.id,
      decisionId:`${review.id}:${file.path}:${action}`,item:{path:review.path},path:review.path,
      relativePath:file.path,expectedContentHash:file.contentHash};
    if(action==="ignore") return this.gitWorkspaces.ignoreIntegrationMarkdownFile({...common,expectedIgnoreContentHash:review.inspection.ignoreContentHash});
    if(action==="delete") return this.gitWorkspaces.deleteIntegrationMarkdownFile(common);
    if(review.authority!=="local_user") throw fail("COMMIT_POLICY_AUTHORITY_REQUIRED","Artifact decisions require direct local-user authorization.");
    const owners=this.owners(review.repositoryId);
    const ownerId=input.artifactWorkId ?? (owners.length===1?owners[0].workId:null);
    if(!owners.some(owner=>owner.workId===ownerId)) throw fail("COMMIT_POLICY_ARTIFACT_OWNER_AMBIGUOUS","Choose an available Work to own the Artifact.");
    return this.artifactDecision({...common,owner:{workId:ownerId,taskId:null}},{removeSource:action==="artifact",allowTracking:action==="track"});
  }
  async commit(context,input,prepareProtection) {
    if(typeof input.commitMessage!=="string" || !input.commitMessage.trim()) throw fail("COMMIT_MESSAGE_REQUIRED","Enter a commit message.");
    let review=input.reviewId?this.reviews.get(input.reviewId):null;
    if(input.reviewId && (!review || review.invalid || review.expiresAt<this.now())) throw fail("COMMIT_REVIEW_EXPIRED","This commit review expired. Review again; no action will be replayed automatically.");
    if(!review) {const prepared=await this.inspectCommitPolicy(context);review=this.reviews.get(prepared.reviewId);}
    if(review.repositoryId!==context.project.id || review.worktreeId!==context.workspace.worktreeId
      || review.authority!==(context.authority?.kind??"local_user")) throw fail("COMMIT_REVIEW_SCOPE_MISMATCH","The commit review belongs to a different workspace or authority.");
    const requestKey=JSON.stringify([input.commitMessage,input.decisions??[],input.artifactWorkId??null,input.privateFilesDecision??null,input.neverRemindPrivateFiles===true]);
    if((review.requestKey && review.requestKey!==requestKey) || (review.inFlightKey && review.inFlightKey!==requestKey)) throw fail("COMMIT_REQUEST_CHANGED","A commit attempt already used this review. Review again to change its decisions.");
    if(review.result) return review.result;
    if(this.inFlight.has(review.id)) return this.inFlight.get(review.id);
    if(this.gitWorkspaces.directCommitRepositories.has(context.project.id)) throw fail("REPOSITORY_BUSY","Another commit is already running.");
    review.inFlightKey=requestKey;
    const promise=this.execute(context,review,input,prepareProtection).finally(()=>{
      this.inFlight.delete(review.id);delete review.inFlightKey;this.gitWorkspaces.directCommitRepositories.delete(context.project.id);
    });
    this.inFlight.set(review.id,promise);this.gitWorkspaces.directCommitRepositories.add(context.project.id);
    return promise;
  }
  async execute(context,review,input,prepareProtection) {
    try {
      this.assertWritable(context);
      await this.assertReviewFresh(review,context);
      if(review.files.length) {
        if(!input.decisions) throw fail("GIT_ARTIFACT_POLICY_REJECTED","Choose an action for each new Markdown file before committing.");
        const decisions=validateDecisions(review.files,input.decisions);
        // Validate ownership for the entire batch before any destructive step.
        if(review.files.some(file=>!file.appliedAction && ["artifact","track"].includes(decisions.get(file.path)))) {
          const owners=this.owners(review.repositoryId),id=input.artifactWorkId??(owners.length===1?owners[0].workId:null);
          if(!owners.some(owner=>owner.workId===id)) throw fail("COMMIT_POLICY_ARTIFACT_OWNER_AMBIGUOUS","Choose an available Work to own the Artifact.");
        }
        review.requestKey=review.inFlightKey;
        for(const file of review.files.filter(file=>!file.appliedAction)) {
          this.assertWritable(context);await this.assertReviewFresh(review,context);
          const action=decisions.get(file.path),before=review.inspection,result=await this.applyDecision(context,review,file,action,input);
          file.appliedAction=action;if(result?.artifactId)file.artifactId=result.artifactId;
          const after=await this.inspect(context);
          this.assertExpectedChange(before,after,action==="ignore"?[file.path,".gitignore"]:[file.path]);
          review.inspection=after;
        }
      }
      this.assertWritable(context);await this.assertReviewFresh(review,context);
      const beforeProtection=review.inspection,protection=await prepareProtection();
      const afterProtection=await this.inspect(context);
      this.assertExpectedChange(beforeProtection,afterProtection,protection?.decision==="ignore"?[".gitignore",...(protection.protectedPaths??[])]:[]);
      review.inspection=afterProtection;
      if(review.inspection.files.length || review.inspection.violations.length) throw fail("GIT_ARTIFACT_POLICY_REJECTED","The current commit still contains unauthorized documents. Review again.");
      review.requestKey=review.inFlightKey;
      const dirty=await this.gitWorkspaces.gitOutput(review.path,["status","--porcelain=v1"]);
      if(!dirty.trim()) review.result={committed:false,noChanges:true,policyResults:review.files};
      else {
        const result=await this.gitWorkspaces.commitWorktreeChangesForProject({repositoryId:review.repositoryId,
          workingDirectory:context.project.mainPath,sourceWorktreeId:review.worktreeId,commitMessage:input.commitMessage,
          beforeStage:()=>this.assertReviewFresh(review,context),beforeCommit:async()=>{
            const current=await this.inspect(context);
            if(current.contentState!==review.inspection.contentState) throw fail("COMMIT_REVIEW_CHANGED","Files changed during staging. Review again.");
            if(!await this.gitWorkspaces.gitSucceeds(review.path,["diff","--quiet","--ignore-submodules=dirty","--"]))
              throw fail("COMMIT_REVIEW_CHANGED","The index no longer matches the reviewed working files. Review again.");
            review.inspection=current;
          }});
        review.result={...result,policyResults:review.files};
      }
      return review.result;
    } catch(error) {
      // Never assume a failed Git command rolled back its index or file writes.
      // Expose the known prefix; externally changed content requires re-review.
      if(["COMMIT_REVIEW_CHANGED","COMMIT_REVIEW_SCOPE_MISMATCH"].includes(error.code)) review.invalid=true;
      if(error.code!=="COMMIT_REVIEW_CHANGED") {
        const head=(await this.gitWorkspaces.gitOutput(review.path,["rev-parse","--verify","HEAD"]).catch(()=>"")).trim();
        if(head && head!==review.inspection.headOid) {
          review.invalid=true;error.code="COMMIT_OUTCOME_UNKNOWN";
          error.message="HEAD changed during the commit attempt. Check Git history before reviewing or retrying; no commit will be replayed automatically.";
        } else {
          const latest=await this.inspect(context).catch(()=>null);
          if(!latest || latest.state!==review.inspection.state) {
            review.invalid=true;error.code="COMMIT_REVIEW_CHANGED";
            error.message="The failed operation may have changed files or the index. Review the current state; completed file actions are preserved.";
          } else if(error.code==="GIT_ARTIFACT_POLICY_REJECTED" && review.files.every(file=>file.appliedAction)) {
            review.invalid=true;error.code="COMMIT_POLICY_STAGED_CONTENT_CHANGED";
            error.message="The Git hook rejected the staged document version after approval. Review Git filters and the current file versions before retrying.";
          }
        }
      }
      error.commitPolicyBlocker=this.blocker(review);
      error.commitReviewId=review.id;
      throw error;
    }
  }
}
