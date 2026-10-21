import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { validateEntityName, validateWorkInput } from "../domain/workTaskValidation.mjs";
import { createGitWorkspaceSnapshot, inspectGitWorkspace } from "../utils/gitWorktreeInventory.mjs";
import { ensureArtifactCommitHook } from "../runtime/artifactCommitHook.mjs";
import { EntityCreationConflictError, workCreationMatches } from "./workApplicationService.mjs";
import { ensureProjectLocalState, inspectProjectLocalState, verifyProjectLocalState, rollbackProjectLocalState } from "../runtime/projectLocalStateDirectory.mjs";

const execFileAsync = promisify(execFile);
const fail = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });

// A compensating transaction: never keep a database transaction open across
// filesystem/Provider awaits. Only resources allocated by this attempt are undone.
export class WorkInitializationService {
  constructor({ store, workService, discussionService, resolveProviderId, deleteSession,
    run = execFileAsync, snapshot = createGitWorkspaceSnapshot }) {
    Object.assign(this, { store, workService, discussionService, resolveProviderId, deleteSession, run, snapshot });
    this.tail = Promise.resolve();
  }

  create(input, { commit = value => value } = {}) {
    // Serializes directory claims and repository registration in this backend.
    const operation = this.tail.then(() => this.initialize(input, commit));
    this.tail = operation.catch(() => {});
    return operation;
  }

  // Existing desktop/device contracts select a Workspace or ask Corptie to
  // allocate its managed directory. Neither exposes the persistence primitive.
  createForClient(input, { commit = value => value } = {}) {
    const operation = this.tail.then(async () => {
      const normalized = validateWorkInput(input, "create");
      validateEntityName(normalized.name, "name", "Work");
      const id = normalized.id ?? `work:${randomUUID()}`;
      const existing = this.store.getWork(id);
      if (existing) {
        if (!workCreationMatches(existing, normalized)) throw new EntityCreationConflictError("Work", id);
        const session = this.store.getWorkChatSession(id);
        const logical = session && this.store.getLogicalSessionByLegacySessionId(session.id);
        const result = { ...existing, workspace: this.store.getWorkspace(existing.workspaceId),
          directory: this.store.resolveWorkspaceRoot(existing.workspaceId),
          repository: this.store.getGitRepositoryForWorkspace(existing.workspaceId),
          workChat: { sessionId: session?.id, logicalSessionId: logical?.logicalSessionId,
            agentId: session?.agentId, providerId: logical?.activeBinding?.providerId } };
        return commit(await this.verify(result));
      }
      let directory;
      if (normalized.workspaceId) {
        const workspace = this.store.getWorkspace(normalized.workspaceId);
        if (!workspace || workspace.status !== "ready" || !workspace.canonicalRootPath
          || workspace.location?.transport === "ssh") throw fail("WORK_DIRECTORY_REQUIRED", "Selected Workspace must have a ready, actual local directory.");
        directory = { mode: "bind", path: workspace.canonicalRootPath };
      } else {
        const parent = join(this.store.dataRoot, "workspaces");
        await mkdir(parent, { recursive: true });
        directory = { mode: "create", path: join(parent, `work-${createHash("sha256").update(id).digest("hex")}`) };
      }
      const { id: _id, workspaceId: _workspaceId, ...work } = normalized;
      return this.initialize({ work, directory, creationId: id }, commit);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async verify(result) {
    const work = result?.id && this.store.getWork(result.id);
    const workspace = work && this.store.getWorkspace(work.workspaceId);
    const session = work && this.store.getWorkChatSession(work.id);
    const logical = session && this.store.getLogicalSessionByLegacySessionId(session.id);
    if (!work || !result.directory || result.workspace?.workspaceId !== work.workspaceId
      || workspace?.canonicalRootPath !== result.directory || workspace.status !== "ready"
      || session?.id !== result.workChat?.sessionId || !logical?.logicalSessionId
      || logical.logicalSessionId !== result.workChat.logicalSessionId
      || logical.activeBinding?.state !== "active" || logical.activeBinding.boundCwd !== result.directory) {
      throw fail("WORK_CREATION_RECEIPT_INCOMPLETE", "Stored Work creation receipt is incomplete or no longer matches live resources; inspect and repair the exact Work before retrying. No resources were modified.");
    }
    if (await realpath(result.directory) !== result.directory || !(await stat(result.directory)).isDirectory()) throw fail("WORK_DIRECTORY_CHANGED", "Stored Work directory is unavailable or changed.");
    const repository = this.store.getGitRepositoryForWorkspace(work.workspaceId);
    if ((repository?.id ?? null) !== (result.repository?.id ?? null)) throw fail("WORK_CREATION_RECEIPT_INCOMPLETE", "Stored repository binding changed.");
    if (repository && (await inspectGitWorkspace(result.directory)).repositoryId !== repository.id) throw fail("WORK_REPOSITORY_CHANGED", "Actual Git repository no longer matches its binding.");
    const localState = this.store.getRuntimeState(`work-local-state:${work.id}`);
    // Legacy successful receipts are not an implicit filesystem migration.
    if (localState) await verifyProjectLocalState(localState);
    return result;
  }

  async localState(workId, { repair = false } = {}) {
    const work = this.store.getWork(workId);
    const workspace = work && this.store.getWorkspace(work.workspaceId);
    if (!workspace?.canonicalRootPath || workspace.status !== "ready" || workspace.location?.transport === "ssh") {
      throw fail("WORK_DIRECTORY_REQUIRED", "Work requires an available local Workspace.");
    }
    const root = workspace.canonicalRootPath;
    const repository = this.store.getGitRepositoryForWorkspace(work.workspaceId);
    if (repository && (await inspectGitWorkspace(root)).repositoryId !== repository.id) throw fail("WORK_REPOSITORY_CHANGED", "Repository binding changed.");
    if (!repair) return inspectProjectLocalState(root, { scope: "projectShared" });
    const prepared = await ensureProjectLocalState(root, { scope: "projectShared" });
    if (this.store.getWork(workId)?.workspaceId !== work.workspaceId
        || this.store.getWorkspace(work.workspaceId)?.canonicalRootPath !== root) {
      rollbackProjectLocalState(prepared);
      throw fail("WORK_DIRECTORY_CHANGED", "Work binding changed during repair.");
    }
    this.store.setRuntimeState(`work-local-state:${workId}`, prepared);
    this.store.scheduleSave();
    return { state: prepared.state, scope: prepared.scope, gitStatus: prepared.gitStatus };
  }

  async initialize(input, commit) {
    const normalized = validateWorkInput(input.work, "create");
    validateEntityName(normalized.name, "name", "Work");
    if (normalized.id || normalized.workspaceId) throw fail("WORK_INITIALIZATION_INPUT_INVALID", "Use directory binding; preexisting Work/Workspace IDs cannot be supplied to create.");
    for (const agentId of normalized.contributorAgentIds) this.store.assertAssignableAgent(agentId, "contributorAgentIds");
    const agentId = input.agentId ?? normalized.primaryAgentId ?? normalized.contributorAgentIds[0];
    if (!normalized.contributorAgentIds.includes(agentId)) throw fail("AGENT_OUTSIDE_WORK", "Work Chat Agent must be a Work contributor.");
    const providerId = this.resolveProviderId(input.providerId);
    if (!providerId) throw fail("PROVIDER_UNSUPPORTED", "A supported Work Chat Provider is required.");
    const directory = input.directory;
    if (!directory || !["create", "bind"].includes(directory.mode) || typeof directory.path !== "string" || !isAbsolute(directory.path)) {
      throw fail("WORK_DIRECTORY_REQUIRED", "directory requires mode=create|bind and an absolute local path; create requires an existing parent and a new leaf directory.");
    }
    if (Object.keys(directory).some(key => !["mode", "path"].includes(key))) throw fail("UNKNOWN_FIELD", "Unknown directory field.");
    const git = input.git ?? { mode: "detect" };
    if (!git || !["detect", "none", "init", "clone"].includes(git.mode)
      || Object.keys(git).some(key => !["mode", "url", "branch", "commit"].includes(key))) throw fail("INVALID_GIT_STRATEGY", "git.mode must be detect, none, init, or clone.");
    if (["init", "clone"].includes(git.mode) && directory.mode !== "create") throw fail("INVALID_GIT_STRATEGY", "Git initialization/clone is allowed only in a new directory.");
    if (git.mode !== "clone" && [git.url, git.branch, git.commit].some(value => value !== undefined)) throw fail("INVALID_GIT_STRATEGY", "Git URL/branch/commit apply only to clone.");
    if (git.mode === "clone" && (typeof git.url !== "string" || !git.url.trim() || git.url.startsWith("-"))) throw fail("INVALID_GIT_STRATEGY", "clone requires a Git URL or local repository path.");
    for (const field of ["branch", "commit"]) if (git[field] !== undefined && (typeof git[field] !== "string" || !git[field] || git[field].startsWith("-"))) throw fail("INVALID_GIT_STRATEGY", `Invalid Git ${field}.`);

    const root = directory.mode === "bind" ? await realpath(directory.path)
      : join(await realpath(dirname(directory.path)), basename(directory.path));
    const registeredWorkspace = this.store.listWorkspaces().find(ws => ws.canonicalRootPath === root);
    if (registeredWorkspace && (directory.mode !== "bind" || this.store.selectOne("SELECT id FROM works WHERE workspace_id=?", [registeredWorkspace.workspaceId]))) throw fail("WORKSPACE_ALREADY_BOUND", "Directory's Workspace is already bound, or create would adopt existing resources.");
    let ownedDirectory = null, workspaceId = registeredWorkspace?.workspaceId ?? null, repositoryId = null, work = null;
    let workspaceOwned = false, repositoryOwned = false, localState = null;
    const workId = input.creationId ?? `work:${randomUUID()}`;
    const gitRun = args => this.run("git", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    try {
      if (directory.mode === "create") {
        await mkdir(root); // Exclusive leaf creation; never adopts an existing directory.
        ownedDirectory = await lstat(root, { bigint: true });
      } else if (!(await stat(root)).isDirectory()) throw fail("INVALID_DIRECTORY", "Binding requires an existing directory.");
      if (git.mode === "init") {
        await gitRun(["-C", root, "init"]);
        // No invented README, staging, or commit is needed for an unborn repository.
      } else if (git.mode === "clone") {
        await gitRun(["clone", ...(git.branch ? ["--branch", git.branch] : []), "--", git.url, root]);
        if (git.commit) await gitRun(["-C", root, "checkout", "--detach", git.commit, "--"]);
      }
      let inventory = null;
      try { inventory = await this.snapshot(root); }
      catch (error) {
        // Only a genuinely non-Git directory permits the non-Git path. An
        // inaccessible/corrupt Git inventory must never silently downgrade.
        const probe = await gitRun(["-C", root, "rev-parse", "--is-inside-work-tree"]).catch(() => null);
        const marker = await lstat(join(root, ".git")).catch(markerError => {
          if (markerError.code === "ENOENT") return null;
          throw markerError;
        });
        if (probe || marker || ["init", "clone"].includes(git.mode)) throw error;
      }
      const currentWorkspace = this.store.listWorkspaces().find(ws => ws.canonicalRootPath === root);
      if (currentWorkspace?.workspaceId !== registeredWorkspace?.workspaceId) throw fail("WORKSPACE_ALREADY_REGISTERED", "Directory was registered during initialization.");
      if (inventory) {
        const main = inventory.worktrees.find(entry => entry.isMain);
        if (main?.canonicalPath !== root) throw fail("WORK_REPOSITORY_ROOT_REQUIRED", "Bind the repository main directory, not a subdirectory or Task Git worktree.");
        if (git.mode === "none") throw fail("GIT_REPOSITORY_PRESENT", "Directory contains Git; use detect to bind its repository.");
        const existingRepository = this.store.getGitRepository(inventory.repository.id);
        if (existingRepository && existingRepository.workspaceId !== workspaceId) throw fail("WORKSPACE_ALREADY_REGISTERED", "Repository is already bound to another Workspace.");
        // Set compensation identities before a potentially failing Store call.
        repositoryId = inventory.repository.id;
        repositoryOwned = !existingRepository;
        workspaceOwned = !registeredWorkspace;
        if (!existingRepository) this.store.upsertGitWorkspaceSnapshot(inventory);
        workspaceId = this.store.getGitRepository(repositoryId).workspaceId;
        if (ownedDirectory) this.store.db.run("UPDATE workspaces SET kind='managedLocal', ownership='corptieManaged' WHERE workspace_id=?", [workspaceId]);
        if (ownedDirectory && this.store.dbPath) await ensureArtifactCommitHook(root, { dbPath: this.store.dbPath });
      } else {
        if (registeredWorkspace && this.store.getGitRepositoryForWorkspace(workspaceId)) throw fail("WORK_REPOSITORY_CHANGED", "Workspace's registered repository is unavailable.");
        if (!registeredWorkspace) {
          workspaceId = `workspace:${randomUUID()}`;
          workspaceOwned = true;
          this.store.createWorkspace({ workspaceId, rootPath: root, canonicalRootPath: root,
            kind: ownedDirectory ? "managedLocal" : "linkedLocal",
            ownership: ownedDirectory ? "corptieManaged" : "userManaged", status: "ready" });
        }
      }
      localState = await ensureProjectLocalState(root, { scope: "projectShared" });
      // Keep product notifications until the complete resource set is verified.
      work = this.store.runInTransaction(() => this.store.createWork({ ...normalized, id: workId, workspaceId }));
      const opened = await this.discussionService.open({ workId, agentId, providerId });
      const session = this.store.getWorkChatSession(workId);
      const logical = session && this.store.getLogicalSessionByLegacySessionId(session.id);
      if (!session || session.id !== opened.session?.id || session.workId !== workId || session.taskId
        || session.sessionKind !== "workChat" || !logical?.logicalSessionId
        || logical.activeBinding?.state !== "active" || logical.activeBinding?.providerId !== providerId
        || logical.activeBinding?.boundCwd !== root) throw fail("WORK_CHAT_INITIALIZATION_INCOMPLETE", "Work Chat must have a persisted logical Session bound to the new Work, Provider and directory.");
      if (await realpath(root) !== root || !(await stat(root)).isDirectory()) throw fail("WORK_DIRECTORY_CHANGED", "Work directory changed during initialization.");
      const result = { ...work, workspace: this.store.getWorkspace(workspaceId), directory: root,
        repository: repositoryId ? this.store.getGitRepository(repositoryId) : null,
        workChat: { sessionId: session.id, logicalSessionId: logical.logicalSessionId, agentId, providerId } };
      this.store.setRuntimeState(`work-local-state:${workId}`, localState);
      await this.verify(result);
      const committed = await commit(result);
      // Notification failure cannot roll back an already audited success.
      try { this.workService.emit("WorkChanged", work, "created"); }
      catch (notificationError) { console.warn("[work-initialization] notification failed", workId, notificationError.code ?? "NOTIFICATION_FAILED"); }
      return committed;
    } catch (error) {
      const cleanupErrors = [];
      const providerCleanup = [];
      // Include Sessions persisted by a launch that threw before returning.
      for (const session of this.store.listSessionsByWork(workId)) {
        if (session.sessionKind !== "workChat" || session.agentId !== agentId) {
          cleanupErrors.push({ sessionId: session.id, code: "ROLLBACK_CONCURRENT_SESSION" });
          continue;
        }
        try {
          const deleted = await this.deleteSession(session.id);
          if (this.store.getWorkChatSession(workId)?.id === session.id) throw fail("SESSION_CLEANUP_INCOMPLETE", "Work Chat binding is still active after deletion.");
          if (deleted?.providerDeleted === false) providerCleanup.push({ sessionId: session.id, providerId: deleted.providerId, providerErrorCode: deleted.providerErrorCode });
        }
        catch (cleanupError) { cleanupErrors.push({ sessionId: session.id, code: cleanupError.code ?? "SESSION_CLEANUP_FAILED" }); }
      }
      if (!cleanupErrors.length) {
        try {
          if (localState) {
            const cleanup = rollbackProjectLocalState(localState);
            if (cleanup.retained) this.store.setRuntimeState(`work-local-state-recovery:${workId}`, { directory: root, code: "LOCAL_STATE_ADOPTED" });
          }
          this.store.runInTransaction(() => {
            this.store.db.run("DELETE FROM works WHERE id=?", [workId]);
            this.store.setRuntimeState(`work-local-state:${workId}`, null);
            if (repositoryId && repositoryOwned) {
              const repo = this.store.getGitRepository(repositoryId);
              workspaceId ??= repo?.workspaceId ?? this.store.listWorkspaces().find(ws => ws.canonicalRootPath === root)?.workspaceId;
              this.store.db.run("DELETE FROM git_repositories WHERE repository_id=?", [repositoryId]);
            }
            if (workspaceId && workspaceOwned) this.store.db.run("DELETE FROM workspaces WHERE workspace_id=?", [workspaceId]);
          });
          this.store.scheduleSave();
          if (ownedDirectory) {
            const current = await lstat(root, { bigint: true });
            if (current.isSymbolicLink() || current.ino !== ownedDirectory.ino || current.dev !== ownedDirectory.dev) throw fail("ROLLBACK_DIRECTORY_CHANGED", "Refusing to remove a replaced directory.");
            // An opened Work Chat or another process can have added user data.
            // Never recursively erase a newly allocated directory on that basis.
            try { await rmdir(root); }
            catch (cleanupError) {
              if (cleanupError.code !== "ENOTEMPTY") throw cleanupError;
              this.store.setRuntimeState(`work-local-state-recovery:${workId}`, { directory: root, code: "WORK_DIRECTORY_RETAINED" });
              error.retainedDirectory = root;
              error.message += " The allocated directory was retained for inspection.";
            }
          }
        } catch (cleanupError) { cleanupErrors.push({ code: cleanupError.code ?? "RESOURCE_CLEANUP_FAILED" }); }
      }
      if (cleanupErrors.length) {
        const recovery = { workId, workspaceId, directory: root, ownedDirectory: Boolean(ownedDirectory), cleanupErrors, causeCode: error.code ?? "INITIALIZATION_FAILED" };
        this.store.setRuntimeState(`work-initialization-recovery:${workId}`, recovery);
        throw Object.assign(fail("WORK_INITIALIZATION_ROLLBACK_FAILED", "Work creation failed and compensation requires recovery; no success receipt was issued."), { cause: error, ...recovery });
      }
      if (providerCleanup.length) this.store.setRuntimeState(`work-initialization-recovery:${workId}`, {
        workId, directory: root, localRollbackComplete: true, providerCleanup, causeCode: error.code ?? "INITIALIZATION_FAILED"
      });
      if (error.localStateRecovery) this.store.setRuntimeState(`work-local-state-recovery:${workId}`, error.localStateRecovery);
      throw error;
    }
  }
}
