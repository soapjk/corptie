import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { createGitWorkspaceSnapshot } from "../utils/gitWorktreeInventory.mjs";
import {
  DEFAULT_SHARED_AGENT_CONFIGURATION_PATHS,
  linkSharedAgentConfiguration
} from "./sharedAgentConfiguration.mjs";

const execFileAsync = promisify(execFile);

export class GitWorkspaceManager {
  constructor(options) {
    this.store = options.store;
    this.transitions = options.transitions;
    this.execFile = options.execFile ?? execFileAsync;
  }

  async createWorktree(input) {
    const logical = this.requireLogicalRoute(input.logicalSessionId);
    if (!logical.repositoryId || !logical.activeBinding?.boundCwd) {
      throw new Error("The active session is not attached to a Git repository.");
    }
    const targetPath = absolutePath(input.targetPath);
    await assertPathMissing(targetPath);
    const snapshotBefore = await createGitWorkspaceSnapshot(logical.activeBinding.boundCwd);
    if (snapshotBefore.repository.id !== logical.repositoryId) {
      throw new Error("The active workspace no longer belongs to the registered repository.");
    }
    if (input.inventoryVersion
      && input.inventoryVersion !== snapshotBefore.inventoryVersion) {
      throw new Error("The Git worktree inventory changed; refresh it before creating a worktree.");
    }
    this.store.upsertGitWorkspaceSnapshot(snapshotBefore);
    if (snapshotBefore.worktrees.some((worktree) => resolve(worktree.path) === targetPath)) {
      throw new Error(`A Git worktree already exists at ${targetPath}.`);
    }
    const args = await this.worktreeAddArguments(input, snapshotBefore, targetPath);
    await mkdir(dirname(targetPath), { recursive: true });
    try {
      await this.execFile(
        "git",
        ["-C", logical.activeBinding.boundCwd, "worktree", "add", ...args],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
      );
    } catch (error) {
      throw new Error(safeGitError(error, "git worktree add failed"));
    }
    const snapshotAfter = await createGitWorkspaceSnapshot(targetPath);
    this.store.upsertGitWorkspaceSnapshot(snapshotAfter);
    const targetCanonicalPath = await realpath(targetPath);
    const created = snapshotAfter.worktrees.find((worktree) => {
      return worktree.canonicalPath === targetCanonicalPath || resolve(worktree.path) === targetPath;
    });
    if (!created || created.availability !== "available") {
      throw new Error("Git created the worktree, but Corptie could not validate its repository identity.");
    }
    const main = snapshotAfter.worktrees.find((worktree) => {
      return worktree.isMain && worktree.availability === "available";
    });
    const sharedAgentConfiguration = main
      ? await linkSharedAgentConfiguration({
          mainPath: main.canonicalPath || main.path,
          targetPath: created.canonicalPath || created.path,
          commonGitDir: snapshotAfter.repository.commonGitDirCanonicalPath
        })
      : null;
    let transition = null;
    if (input.switchAfterCreate !== false) {
      transition = await this.transitions.switchWorkspace({
        logicalSessionId: logical.logicalSessionId,
        targetWorktreeId: created.worktreeId,
        activeTurnId: input.activeTurnId,
        lastCompletedTurnId: input.lastCompletedTurnId,
        continuationPrompt: input.continuationPrompt,
        dynamicToolAgentId: input.dynamicToolAgentId,
        config: input.config,
        developerInstructions: input.developerInstructions
      });
    }
    return {
      repositoryId: snapshotAfter.repository.id,
      worktree: this.store.getGitWorktree(created.worktreeId),
      inventoryVersion: snapshotAfter.inventoryVersion,
      sharedAgentConfiguration,
      transition
    };
  }

  async switchWorkspace(input) {
    const logical = this.requireLogicalRoute(input.logicalSessionId);
    return this.transitions.switchWorkspace({
      ...input,
      logicalSessionId: logical.logicalSessionId
    });
  }

  async projectStatus(logicalSessionId) {
    const logical = this.requireLogicalRoute(logicalSessionId);
    if (!logical.repositoryId || !logical.activeBinding?.boundCwd) {
      throw new Error("The active session is not attached to a Git repository.");
    }
    return this.projectStatusForPath(logical.activeBinding.boundCwd, logical.repositoryId);
  }

  async projectStatusForPath(workingDirectory, expectedRepositoryId = null) {
    const snapshot = await createGitWorkspaceSnapshot(absolutePath(workingDirectory));
    if (expectedRepositoryId && snapshot.repository.id !== expectedRepositoryId) {
      throw new Error("The active workspace no longer belongs to the registered repository.");
    }
    this.store.upsertGitWorkspaceSnapshot(snapshot);
    const main = snapshot.worktrees.find((worktree) => worktree.isMain);
    if (!main || main.availability !== "available") {
      throw new Error("The repository's main worktree is unavailable.");
    }
    const worktrees = [];
    for (const worktree of snapshot.worktrees) {
      const sessions = this.store.listLogicalSessionsByWorkspaceId(worktree.worktreeId)
        .filter((session) => Boolean(this.store.getSession(session.legacySessionId)))
        .map((session) => ({
          logicalSessionId: session.logicalSessionId,
          sessionId: session.legacySessionId,
          title: session.sessionName,
          active: true
        }));
      if (worktree.availability !== "available") {
        worktrees.push({
          ...worktree,
          state: "unavailable",
          dirty: null,
          mergedIntoMain: null,
          synchronizedWithMain: null,
          aheadOfMain: null,
          behindMain: null,
          pendingIntegration: true,
          sessions
        });
        continue;
      }
      const status = await this.gitOutput(worktree.path, ["status", "--porcelain=v1"]);
      const dirty = Boolean(status.trim());
      const diffStat = dirty
        ? (await this.gitOutput(worktree.path, ["diff", "--stat", "HEAD"])).trim()
        : "";
      if (worktree.isMain) {
        worktrees.push({
          ...worktree,
          state: dirty ? "mainDirty" : "main",
          dirty,
          statusSummary: status.trim(),
          diffStat,
          mergedIntoMain: true,
          synchronizedWithMain: !dirty,
          aheadOfMain: 0,
          behindMain: 0,
          pendingIntegration: false,
          sessions
        });
        continue;
      }
      const counts = await this.gitOutput(main.path, [
        "rev-list",
        "--left-right",
        "--count",
        `${main.headOid}...${worktree.headOid}`
      ]);
      const [behindMain, aheadOfMain] = counts.trim().split(/\s+/).map((value) => Number(value) || 0);
      const mergedIntoMain = await this.gitSucceeds(main.path, [
        "merge-base",
        "--is-ancestor",
        worktree.headOid,
        main.headOid
      ]);
      const pendingIntegration = dirty || !mergedIntoMain;
      const synchronizedWithMain = !dirty
        && aheadOfMain === 0
        && behindMain === 0
        && worktree.headOid === main.headOid;
      const state = dirty
        ? "working"
        : (mergedIntoMain ? "synced" : (behindMain > 0 ? "diverged" : "readyToMerge"));
      worktrees.push({
        ...worktree,
        state,
        dirty,
        statusSummary: status.trim(),
        diffStat,
        mergedIntoMain,
        synchronizedWithMain,
        aheadOfMain,
        behindMain,
        pendingIntegration,
        sessions
      });
    }
    return {
      repositoryId: snapshot.repository.id,
      inventoryVersion: snapshot.inventoryVersion,
      mainWorktreeId: main.worktreeId,
      mainPath: main.path,
      mainBranch: main.branchName,
      mainHeadOid: main.headOid,
      pendingWorktreeCount: worktrees.filter((worktree) => !worktree.isMain && worktree.pendingIntegration).length,
      worktrees
    };
  }

  async integrationInspectionForProject(workingDirectory, expectedRepositoryId = null) {
    const status = await this.projectStatusForPath(workingDirectory, expectedRepositoryId);
    const worktrees = [];
    for (const worktree of status.worktrees) {
      if (worktree.availability !== "available") {
        worktrees.push({ ...worktree, operationState: null, conflictFiles: [], changedFiles: [] });
        continue;
      }
      const [porcelain, operationState, conflicts] = await Promise.all([
        this.gitOutput(worktree.path, ["status", "--porcelain=v1"]),
        this.integrationOperationState(worktree.path),
        this.gitOutput(worktree.path, ["diff", "--name-only", "--diff-filter=U"])
      ]);
      worktrees.push({
        ...worktree,
        statusSummary: porcelain.trim(),
        changedFiles: changedFilesFromPorcelain(porcelain),
        operationState,
        conflictFiles: conflicts.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
      });
    }
    return { ...status, worktrees };
  }

  async integrationOperationState(workingDirectory) {
    if (await this.gitSucceeds(workingDirectory, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])) {
      return "merge";
    }
    if (await this.gitSucceeds(workingDirectory, ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"])) {
      return "cherry_pick";
    }
    if (await this.gitSucceeds(workingDirectory, ["rev-parse", "-q", "--verify", "REVERT_HEAD"])) {
      return "revert";
    }
    for (const [name, gitPath] of [["rebase", "rebase-merge"], ["rebase", "rebase-apply"]]) {
      const path = (await this.gitOutput(workingDirectory, ["rev-parse", "--git-path", gitPath])).trim();
      if (await pathExists(isAbsolute(path) ? path : resolve(workingDirectory, path))) return name;
    }
    return null;
  }

  async commitIntegrationChanges(input) {
    const currentHead = (await this.gitOutput(input.path, ["rev-parse", "--verify", "HEAD"])).trim();
    const marker = `Corptie-Integration-Job: ${input.jobId}`;
    if (currentHead !== input.expectedHead) {
      const body = await this.gitOutput(input.path, ["show", "-s", "--format=%B", "HEAD"]);
      if (body.includes(marker)) return { committed: true, recovered: true, headOid: currentHead };
      throw integrationGitError("WORKTREE_HEAD_CHANGED", "The Worktree HEAD changed after confirmation.");
    }
    const operationState = await this.integrationOperationState(input.path);
    if (operationState) {
      throw integrationGitError("GIT_OPERATION_IN_PROGRESS", `The Worktree has an existing ${operationState} operation.`);
    }
    const status = (await this.gitOutput(input.path, ["status", "--porcelain=v1"])).trim();
    if (!status) return { committed: false, recovered: false, headOid: currentHead };
    if (input.expectedStatusSummary != null && status !== input.expectedStatusSummary.trim()) {
      throw integrationGitError("WORKTREE_CHANGES_CHANGED", "The uncommitted changes changed after confirmation.");
    }
    try {
      await this.runGit(input.path, ["add", "--all"]);
      await this.runGit(input.path, ["commit", "-m", input.commitMessage, "-m", marker]);
    } catch (error) {
      throw integrationGitError("WORKTREE_COMMIT_FAILED", safeGitError(error, "Could not commit Worktree changes"));
    }
    const headOid = (await this.gitOutput(input.path, ["rev-parse", "--verify", "HEAD"])).trim();
    return { committed: true, recovered: false, headOid };
  }

  async mergeIntegrationSource(input) {
    if (await this.gitSucceeds(input.mainPath, ["merge-base", "--is-ancestor", input.sourceHead, "HEAD"])) {
      const mainHead = (await this.gitOutput(input.mainPath, ["rev-parse", "--verify", "HEAD"])).trim();
      return { merged: false, alreadyMerged: true, recovered: mainHead !== input.expectedMainHead, mainHead };
    }
    const operationState = await this.integrationOperationState(input.mainPath);
    if (operationState === "merge") {
      const mergeHead = (await this.gitOutput(input.mainPath, ["rev-parse", "--verify", "MERGE_HEAD"])).trim();
      if (mergeHead !== input.sourceHead) {
        throw integrationGitError("UNRELATED_MERGE_IN_PROGRESS", "main has a merge in progress for a different source.");
      }
      const conflicts = (await this.gitOutput(input.mainPath, ["diff", "--name-only", "--diff-filter=U"]))
        .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (conflicts.length > 0) {
        const error = integrationGitError("MERGE_CONFLICT", "Resolve the merge conflicts in main, then retry.");
        error.conflictFiles = conflicts;
        throw error;
      }
      try {
        await this.runGit(input.mainPath, ["commit", "--no-edit"]);
      } catch (error) {
        throw integrationGitError("MERGE_COMMIT_FAILED", safeGitError(error, "Could not finish the resolved merge"));
      }
      const mainHead = (await this.gitOutput(input.mainPath, ["rev-parse", "--verify", "HEAD"])).trim();
      return { merged: true, alreadyMerged: false, recovered: true, mainHead };
    }
    if (operationState) {
      throw integrationGitError("GIT_OPERATION_IN_PROGRESS", `main has an existing ${operationState} operation.`);
    }
    const mainHead = (await this.gitOutput(input.mainPath, ["rev-parse", "--verify", "HEAD"])).trim();
    if (mainHead !== input.expectedMainHead) {
      throw integrationGitError("MAIN_HEAD_CHANGED", "main HEAD changed while the integration task was running.");
    }
    const mainStatus = (await this.gitOutput(input.mainPath, ["status", "--porcelain=v1"])).trim();
    if (mainStatus) throw integrationGitError("MAIN_DIRTY", "main gained uncommitted changes while integrating.");
    try {
      await this.runGit(input.mainPath, ["merge", "--no-ff", "--no-edit", input.sourceHead]);
    } catch (error) {
      const conflicts = (await this.gitOutput(input.mainPath, ["diff", "--name-only", "--diff-filter=U"]))
        .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (conflicts.length > 0) {
        const conflict = integrationGitError("MERGE_CONFLICT", safeGitError(error, "Merge conflict"));
        conflict.conflictFiles = conflicts;
        throw conflict;
      }
      throw integrationGitError("MERGE_FAILED", safeGitError(error, "Could not merge the Worktree into main"));
    }
    const updatedHead = (await this.gitOutput(input.mainPath, ["rev-parse", "--verify", "HEAD"])).trim();
    return { merged: true, alreadyMerged: false, recovered: false, mainHead: updatedHead };
  }

  async createIntegrationWorktreeForProject(input) {
    const snapshot = await createGitWorkspaceSnapshot(absolutePath(input.workingDirectory));
    if (snapshot.repository.id !== input.repositoryId) {
      throw new Error("The integration project no longer belongs to the registered repository.");
    }
    const main = snapshot.worktrees.find((worktree) => worktree.isMain && worktree.availability === "available");
    if (!main) throw new Error("The repository's main worktree is unavailable.");
    const mainStatus = await this.gitOutput(main.path, ["status", "--porcelain=v1"]);
    if (mainStatus.trim()) {
      throw new Error("The main worktree has uncommitted changes. Clean it before resolving integration conflicts.");
    }
    const suffix = String(input.runId ?? "integration")
      .replace(/^integration:/, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || Date.now().toString(36);
    const branchName = `integration/${suffix}`;
    const targetPath = resolve(dirname(main.path), `${basename(main.path)}-integration-${suffix}`);
    await assertPathMissing(targetPath);
    if (await this.gitSucceeds(main.path, ["show-ref", "--verify", `refs/heads/${branchName}`])) {
      throw new Error(`Integration branch already exists: ${branchName}`);
    }
    try {
      await this.execFile(
        "git",
        ["-C", main.path, "worktree", "add", "-b", branchName, targetPath, main.headOid],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
      );
    } catch (error) {
      throw new Error(safeGitError(error, "Could not create the Integration Worktree"));
    }
    const updated = await createGitWorkspaceSnapshot(targetPath);
    this.store.upsertGitWorkspaceSnapshot(updated);
    const created = updated.worktrees.find((worktree) => resolve(worktree.path) === targetPath);
    if (!created) throw new Error("The Integration Worktree was created but could not be inventoried.");
    const sharedAgentConfiguration = await linkSharedAgentConfiguration({
      mainPath: main.canonicalPath || main.path,
      targetPath: created.canonicalPath || created.path,
      commonGitDir: updated.repository.commonGitDirCanonicalPath
    });
    return {
      worktreeId: created.worktreeId,
      path: created.path,
      branchName: created.branchName,
      headOid: created.headOid,
      sharedAgentConfiguration
    };
  }

  async mergeWorktreeIntoMain(input) {
    const logical = this.requireLogicalRoute(input.logicalSessionId);
    return this.mergeWorktreeIntoMainForProject({
      ...input,
      repositoryId: logical.repositoryId,
      workingDirectory: logical.activeBinding?.boundCwd,
      sourceWorktreeId: input.sourceWorktreeId || logical.activeBinding?.worktreeId
    });
  }

  async mergeWorktreeIntoMainForProject(input) {
    const sourceWorktreeId = input.sourceWorktreeId;
    if (!input.repositoryId || !input.workingDirectory || !sourceWorktreeId) {
      throw new Error("The Session is not attached to a mergeable Git worktree.");
    }
    const snapshot = await createGitWorkspaceSnapshot(input.workingDirectory);
    if (snapshot.repository.id !== input.repositoryId) {
      throw new Error("The active workspace no longer belongs to the registered repository.");
    }
    this.store.upsertGitWorkspaceSnapshot(snapshot);
    const source = snapshot.worktrees.find((worktree) => worktree.worktreeId === sourceWorktreeId);
    const main = snapshot.worktrees.find((worktree) => worktree.isMain);
    if (!source || source.availability !== "available" || source.isMain) {
      throw new Error("The selected worktree is not an available non-main worktree.");
    }
    if (!main || main.availability !== "available") {
      throw new Error("The repository's main worktree is unavailable.");
    }
    const mainStatus = await this.gitOutput(main.path, ["status", "--porcelain=v1"]);
    if (mainStatus.trim()) {
      throw new Error("The main worktree has uncommitted changes. Clean it before merging a worktree.");
    }

    const sourceStatus = await this.gitOutput(source.path, ["status", "--porcelain=v1"]);
    let committed = false;
    let commitMessage = null;
    if (sourceStatus.trim()) {
      commitMessage = requiredCommitMessage(input.commitMessage);
      try {
        await this.runGit(source.path, ["add", "--all"]);
        await this.runGit(source.path, ["commit", "-m", commitMessage]);
        committed = true;
      } catch (error) {
        throw new Error(safeGitError(error, "Could not commit the worktree changes"));
      }
    }

    const sourceHead = (await this.gitOutput(source.path, ["rev-parse", "--verify", "HEAD"])).trim();
    await this.assertCommitHasNoMainLinkedAgentConfiguration(source.path, main.path, sourceHead);
    const alreadyMerged = await this.gitSucceeds(main.path, [
      "merge-base",
      "--is-ancestor",
      sourceHead,
      "HEAD"
    ]);
    if (!alreadyMerged) {
      try {
        await this.runGit(main.path, ["merge", "--no-ff", "--no-edit", sourceHead]);
      } catch (error) {
        await this.runGit(main.path, ["merge", "--abort"]).catch(() => {});
        const mergeError = new Error(safeGitError(error, "Could not merge the worktree into main"));
        // Preserve Git's original multiline diagnostics for callers that need to
        // distinguish merge conflicts and surface the exact files involved.
        mergeError.stdout = error?.stdout;
        mergeError.stderr = error?.stderr;
        throw mergeError;
      }
    }
    const mainHead = (await this.gitOutput(main.path, ["rev-parse", "--verify", "HEAD"])).trim();
    let sourceSynchronized = false;
    if (input.synchronizeSource === true && source.branchName) {
      try {
        await this.runGit(source.path, ["merge", "--ff-only", mainHead]);
        sourceSynchronized = true;
      } catch (error) {
        throw new Error(safeGitError(error, "Merged into main, but could not synchronize the retained worktree"));
      }
    }
    const updated = await createGitWorkspaceSnapshot(main.path);
    this.store.upsertGitWorkspaceSnapshot(updated);
    return {
      merged: !alreadyMerged,
      alreadyMerged,
      committed,
      commitMessage,
      sourceSynchronized,
      sourceHead,
      mainHead,
      sourceWorktreeId: source.worktreeId,
      sourceBranch: source.branchName,
      sourcePath: source.path,
      mainPath: main.path
    };
  }

  async synchronizeWorktreeWithMain(input) {
    const logical = this.requireLogicalRoute(input.logicalSessionId);
    return this.synchronizeWorktreeWithMainForProject({
      ...input,
      repositoryId: logical.repositoryId,
      workingDirectory: logical.activeBinding?.boundCwd,
      sourceWorktreeId: input.sourceWorktreeId || logical.activeBinding?.worktreeId
    });
  }

  async synchronizeWorktreeWithMainForProject(input) {
    const sourceWorktreeId = input.sourceWorktreeId;
    if (!input.repositoryId || !input.workingDirectory || !sourceWorktreeId) {
      throw new Error("The Session is not attached to a synchronizable Git worktree.");
    }
    const snapshot = await createGitWorkspaceSnapshot(input.workingDirectory);
    if (snapshot.repository.id !== input.repositoryId) {
      throw new Error("The active workspace no longer belongs to the registered repository.");
    }
    const source = snapshot.worktrees.find((worktree) => worktree.worktreeId === sourceWorktreeId);
    const main = snapshot.worktrees.find((worktree) => worktree.isMain);
    if (!source || source.availability !== "available" || source.isMain || !source.branchName) {
      throw new Error("The selected worktree is not an available branch worktree.");
    }
    if (!main || main.availability !== "available") {
      throw new Error("The repository's main worktree is unavailable.");
    }
    const [sourceStatus, mainStatus] = await Promise.all([
      this.gitOutput(source.path, ["status", "--porcelain=v1"]),
      this.gitOutput(main.path, ["status", "--porcelain=v1"])
    ]);
    if (sourceStatus.trim()) throw new Error("Commit or merge the worktree changes before synchronizing it with main.");
    if (mainStatus.trim()) throw new Error("The main worktree has uncommitted changes.");
    const sourceMerged = await this.gitSucceeds(main.path, [
      "merge-base", "--is-ancestor", source.headOid, main.headOid
    ]);
    if (!sourceMerged) {
      throw new Error("Merge this worktree into main before synchronizing it.");
    }
    const alreadySynchronized = source.headOid === main.headOid;
    if (!alreadySynchronized) {
      try {
        await this.runGit(source.path, ["merge", "--ff-only", main.headOid]);
      } catch (error) {
        throw new Error(safeGitError(error, "Could not synchronize the worktree with main"));
      }
    }
    const updated = await createGitWorkspaceSnapshot(main.path);
    this.store.upsertGitWorkspaceSnapshot(updated);
    return {
      synchronized: !alreadySynchronized,
      alreadySynchronized,
      sourceWorktreeId,
      sourcePath: source.path,
      sourceBranch: source.branchName,
      mainHead: main.headOid
    };
  }

  async commitWorktreeChanges(input) {
    const logical = this.requireLogicalRoute(input.logicalSessionId);
    return this.commitWorktreeChangesForProject({
      ...input,
      repositoryId: logical.repositoryId,
      workingDirectory: logical.activeBinding?.boundCwd
    });
  }

  async commitWorktreeChangesForProject(input) {
    if (!input.repositoryId || !input.workingDirectory || !input.sourceWorktreeId) {
      throw new Error("The Session is not attached to a committable Git repository.");
    }
    const snapshot = await createGitWorkspaceSnapshot(input.workingDirectory);
    if (snapshot.repository.id !== input.repositoryId) {
      throw new Error("The active workspace no longer belongs to the registered repository.");
    }
    const source = snapshot.worktrees.find((worktree) => worktree.worktreeId === input.sourceWorktreeId);
    if (!source || source.availability !== "available") {
      throw new Error("The selected worktree is unavailable.");
    }
    const status = await this.gitOutput(source.path, ["status", "--porcelain=v1"]);
    if (!status.trim()) throw new Error("The selected worktree has no uncommitted changes.");
    const commitMessage = requiredCommitMessage(input.commitMessage);
    try {
      await this.runGit(source.path, ["add", "--all"]);
      await this.runGit(source.path, ["commit", "-m", commitMessage]);
    } catch (error) {
      throw new Error(safeGitError(error, "Could not commit the worktree changes"));
    }
    const headOid = (await this.gitOutput(source.path, ["rev-parse", "--verify", "HEAD"])).trim();
    const updated = await createGitWorkspaceSnapshot(source.path);
    this.store.upsertGitWorkspaceSnapshot(updated);
    return {
      committed: true,
      commitMessage,
      headOid,
      sourceWorktreeId: source.worktreeId,
      sourceBranch: source.branchName,
      sourcePath: source.path
    };
  }

  async revisionContains(workingDirectory, ancestorRevision, descendantRevision) {
    if (!ancestorRevision || !descendantRevision) return false;
    return this.gitSucceeds(workingDirectory, [
      "merge-base", "--is-ancestor", ancestorRevision, descendantRevision
    ]);
  }

  async removeMergedWorktree(input) {
    const logical = this.requireLogicalRoute(input.logicalSessionId);
    return this.removeWorktreeForProject({
      ...input,
      repositoryId: logical.repositoryId,
      workingDirectory: logical.activeBinding?.boundCwd
    });
  }

  async removeWorktreeForProject(input) {
    const sourceWorktreeId = input.sourceWorktreeId;
    const source = this.store.getGitWorktree(sourceWorktreeId);
    if (!source || source.repositoryId !== input.repositoryId || source.isMain) {
      throw new Error("The selected worktree does not belong to this project.");
    }
    const ignoredLogicalSessionIds = new Set(input.ignoreLogicalSessionIds ?? []);
    const boundSessions = this.store.listLogicalSessionsByWorkspaceId(sourceWorktreeId).filter((session) => {
      return !ignoredLogicalSessionIds.has(session.logicalSessionId);
    });
    if (boundSessions.length > 0) {
      throw new Error("The worktree still has active Sessions. Switch or delete them before removing it.");
    }
    const snapshot = await createGitWorkspaceSnapshot(input.workingDirectory);
    const main = snapshot.worktrees.find((worktree) => worktree.isMain && worktree.availability === "available");
    if (!main) throw new Error("The repository's main worktree is unavailable.");
    const currentSource = snapshot.worktrees.find((worktree) => {
      return worktree.worktreeId === sourceWorktreeId && worktree.availability === "available";
    });
    if (!currentSource || currentSource.isMain) {
      throw new Error("The selected worktree is no longer available.");
    }
    const status = await this.gitOutput(currentSource.path, ["status", "--porcelain=v1"]);
    const dirty = Boolean(status.trim());
    const merged = await this.gitSucceeds(main.path, [
      "merge-base",
      "--is-ancestor",
      currentSource.headOid,
      main.headOid
    ]);
    let discardedCommitCount = 0;
    if (!merged) {
      const counts = await this.gitOutput(main.path, [
        "rev-list", "--left-right", "--count", `${main.headOid}...${currentSource.headOid}`
      ]);
      discardedCommitCount = Number(counts.trim().split(/\s+/)[1]) || 0;
    }
    const requiresForceConfirmation = !merged || dirty;
    if (requiresForceConfirmation) {
      const confirmedBranchName = String(input.confirmedBranchName ?? "");
      const forceConfirmed = input.forceDeleteUnmerged === true
        && input.acknowledgeIrrecoverable === true
        && currentSource.branchName
        && confirmedBranchName === currentSource.branchName;
      if (!forceConfirmed) {
        const error = new Error(
          `The worktree has ${discardedCommitCount} commits that are not merged into main${dirty ? " and uncommitted changes" : ""}. Confirm the full branch name to delete it permanently.`
        );
        error.code = "UNMERGED_WORKTREE_CONFIRMATION_REQUIRED";
        error.unmergedCommitCount = discardedCommitCount;
        error.branchName = currentSource.branchName;
        throw error;
      }
    }
    await this.runGit(main.path, [
      "worktree", "remove", ...(dirty ? ["--force"] : []), currentSource.path
    ]);
    let branchDeleted = false;
    if (input.deleteBranch !== false && currentSource.branchName) {
      await this.runGit(main.path, ["branch", merged ? "-d" : "-D", currentSource.branchName]);
      branchDeleted = true;
    }
    const updated = await createGitWorkspaceSnapshot(main.path);
    this.store.upsertGitWorkspaceSnapshot(updated);
    return {
      removed: true,
      branchDeleted,
      forced: requiresForceConfirmation,
      discardedCommitCount,
      sourceWorktreeId,
      sourcePath: currentSource.path,
      sourceBranch: currentSource.branchName
    };
  }

  async restoreMissingWorktree(input) {
    const logical = this.requireLogicalRoute(input.logicalSessionId);
    const source = logical.activeWorkspaceId
      ? this.store.getGitWorktree(logical.activeWorkspaceId)
      : null;
    if (!source || source.isMain || !source.path || !source.branchName) {
      throw new Error("The missing workspace does not have a restorable Git branch.");
    }
    try {
      await access(source.path);
      throw new Error("The original workspace path still exists. Remove the conflict before rebuilding it.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const knownMain = this.store.listGitWorktrees(logical.repositoryId).find((worktree) => {
      return worktree.isMain && worktree.availability === "available";
    });
    if (!knownMain?.path) throw new Error("The repository's main worktree is unavailable.");
    const branchExists = await this.gitSucceeds(knownMain.path, [
      "show-ref", "--verify", `refs/heads/${source.branchName}`
    ]);
    if (!branchExists) {
      throw new Error(`The original branch ${source.branchName} no longer exists.`);
    }
    await this.runGit(knownMain.path, ["worktree", "prune"]);
    await mkdir(dirname(source.path), { recursive: true });
    try {
      await this.runGit(knownMain.path, ["worktree", "add", source.path, source.branchName]);
    } catch (error) {
      throw new Error(safeGitError(error, "Could not rebuild the missing worktree"));
    }
    const updated = await createGitWorkspaceSnapshot(knownMain.path);
    this.store.upsertGitWorkspaceSnapshot(updated);
    const restored = updated.worktrees.find((worktree) => worktree.path === source.path);
    if (!restored || restored.availability !== "available") {
      throw new Error("Git rebuilt the worktree, but Corptie could not validate it.");
    }
    const main = updated.worktrees.find((worktree) => worktree.isMain);
    const sharedAgentConfiguration = main
      ? await linkSharedAgentConfiguration({
          mainPath: main.canonicalPath || main.path,
          targetPath: restored.canonicalPath || restored.path,
          commonGitDir: updated.repository.commonGitDirCanonicalPath,
          execFile: this.execFile
        })
      : null;
    return { restored, sharedAgentConfiguration };
  }

  async sessionDeletionPlan(logicalSessionId) {
    const logical = this.requireLogicalRoute(logicalSessionId);
    const activeCwd = logical.activeBinding?.boundCwd;
    if (!logical.repositoryId || !activeCwd || !logical.activeBinding?.worktreeId) {
      return { requiresWorktreeMerge: false };
    }

    const snapshot = await createGitWorkspaceSnapshot(activeCwd);
    if (snapshot.repository.id !== logical.repositoryId) {
      throw new Error("The active workspace no longer belongs to the registered repository.");
    }
    this.store.upsertGitWorkspaceSnapshot(snapshot);
    const source = snapshot.worktrees.find((worktree) => {
      return worktree.worktreeId === logical.activeBinding.worktreeId;
    });
    if (!source || source.availability !== "available" || source.isMain) {
      return { requiresWorktreeMerge: false };
    }
    const main = snapshot.worktrees.find((worktree) => worktree.isMain);
    if (!main || main.availability !== "available") {
      throw new Error("The repository's main worktree is unavailable.");
    }
    const status = await this.gitOutput(source.path, ["status", "--short"]);
    const diffStat = await this.gitOutput(source.path, ["diff", "--stat", "HEAD"]);
    return {
      requiresWorktreeMerge: true,
      repositoryId: snapshot.repository.id,
      sourceWorktreeId: source.worktreeId,
      sourcePath: source.path,
      sourceBranch: source.branchName,
      mainWorktreeId: main.worktreeId,
      mainPath: main.path,
      mainBranch: main.branchName,
      hasUncommittedChanges: Boolean(status.trim()),
      statusSummary: status.trim(),
      diffStat: diffStat.trim()
    };
  }

  async mergeSessionWorktreeIntoMain(input) {
    const plan = await this.sessionDeletionPlan(input.logicalSessionId);
    if (!plan.requiresWorktreeMerge) {
      throw new Error("The Session is not bound to a non-main Git worktree.");
    }
    const mainStatus = await this.gitOutput(plan.mainPath, ["status", "--porcelain=v1"]);
    if (mainStatus.trim()) {
      throw new Error("The main worktree has uncommitted changes. Clean it before merging this Session's worktree.");
    }

    let committed = false;
    let commitMessage = null;
    if (plan.hasUncommittedChanges) {
      commitMessage = requiredCommitMessage(input.commitMessage);
      try {
        await this.runGit(plan.sourcePath, ["add", "--all"]);
        await this.runGit(plan.sourcePath, ["commit", "-m", commitMessage]);
        committed = true;
      } catch (error) {
        throw new Error(safeGitError(error, "Could not commit the Session worktree changes"));
      }
    }

    const sourceHead = (await this.gitOutput(plan.sourcePath, ["rev-parse", "--verify", "HEAD"])).trim();
    await this.assertCommitHasNoMainLinkedAgentConfiguration(plan.sourcePath, plan.mainPath, sourceHead);
    try {
      await this.runGit(plan.mainPath, ["merge", "--no-ff", "--no-edit", sourceHead]);
    } catch (error) {
      await this.runGit(plan.mainPath, ["merge", "--abort"]).catch(() => {});
      throw new Error(safeGitError(error, "Could not merge the Session worktree into main"));
    }
    const mainHead = (await this.gitOutput(plan.mainPath, ["rev-parse", "--verify", "HEAD"])).trim();
    return {
      merged: true,
      committed,
      commitMessage,
      sourceHead,
      mainHead,
      sourceWorktreeId: plan.sourceWorktreeId,
      sourceBranch: plan.sourceBranch,
      sourcePath: plan.sourcePath,
      mainPath: plan.mainPath
    };
  }

  requireLogicalRoute(logicalSessionId) {
    const logical = this.store.getLogicalSession(logicalSessionId);
    if (!logical?.activeBinding) {
      throw new Error(`Logical session ${logicalSessionId} has no active workspace route.`);
    }
    return logical;
  }

  async assertCommitHasNoMainLinkedAgentConfiguration(sourcePath, mainPath, revision) {
    const unsafePaths = [];
    for (const relativePath of DEFAULT_SHARED_AGENT_CONFIGURATION_PATHS) {
      const entry = await this.gitOutput(sourcePath, [
        "ls-tree", revision, "--", relativePath
      ]);
      if (!entry.startsWith("120000 ")) continue;
      const linkTarget = await this.gitOutput(sourcePath, [
        "show", `${revision}:${relativePath}`
      ]);
      const resolvedTarget = resolve(dirname(resolve(sourcePath, relativePath)), linkTarget.trim());
      if (resolvedTarget === resolve(mainPath, relativePath)) unsafePaths.push(relativePath);
    }
    if (unsafePaths.length === 0) return;
    const error = new Error(
      `The Worktree commit contains local Agent configuration links that would point back to themselves in the main Worktree: ${unsafePaths.join(", ")}. Remove these links from Git tracking before merging.`
    );
    error.code = "GIT_SHARED_AGENT_LINK_MERGE_BLOCKED";
    error.paths = unsafePaths;
    throw error;
  }

  async worktreeAddArguments(input, snapshot, targetPath) {
    if (input.detach === true) {
      const baseRef = await this.validatedCommitish(
        input.baseRef || "HEAD",
        snapshot.worktrees[0]?.path
      );
      return ["--detach", targetPath, baseRef];
    }
    const branch = requiredBranch(input.branch);
    await this.execFile("git", ["check-ref-format", "--branch", branch], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }).catch(() => {
      throw new Error(`Invalid Git branch name: ${branch}`);
    });
    if (snapshot.worktrees.some((worktree) => {
      return worktree.availability === "available" && worktree.branchName === branch;
    })) {
      throw new Error(`Branch ${branch} is already checked out in another worktree.`);
    }
    if (input.createBranch === false) {
      await this.validatedCommitish(branch, snapshot.worktrees[0]?.path);
      return [targetPath, branch];
    }
    const baseRef = await this.validatedCommitish(
      input.baseRef || "HEAD",
      snapshot.worktrees[0]?.path
    );
    return ["-b", branch, targetPath, baseRef];
  }

  async validatedCommitish(value, cwd) {
    const ref = typeof value === "string" && value.trim() ? value.trim() : "HEAD";
    if (ref.startsWith("-") || ref.includes("\0")) throw new Error("Invalid Git base ref.");
    try {
      await this.execFile("git", ["-C", cwd, "rev-parse", "--verify", `${ref}^{commit}`], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      });
    } catch {
      throw new Error(`Git base ref is not a commit: ${ref}`);
    }
    return ref;
  }

  async runGit(cwd, arguments_) {
    return this.execFile("git", ["-C", cwd, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
  }

  async gitOutput(cwd, arguments_) {
    try {
      const result = await this.runGit(cwd, arguments_);
      return String(result?.stdout ?? "");
    } catch (error) {
      throw new Error(safeGitError(error, `git ${arguments_[0]} failed`));
    }
  }

  async gitSucceeds(cwd, arguments_) {
    try {
      await this.runGit(cwd, arguments_);
      return true;
    } catch {
      return false;
    }
  }
}

function absolutePath(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("The worktree target path must be absolute.");
  }
  return resolve(value);
}

async function assertPathMissing(path) {
  try {
    await access(path);
    throw new Error(`The worktree target path already exists: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function changedFilesFromPorcelain(output) {
  const files = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (line.length < 4) continue;
    const path = line.slice(3).trim();
    if (!path) continue;
    files.push(path.includes(" -> ") ? path.split(" -> ").at(-1) : path);
  }
  return files;
}

function integrationGitError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredBranch(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A branch name is required unless detach is enabled.");
  }
  return value.trim();
}

function requiredCommitMessage(value) {
  const message = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!message) throw new Error("The Session did not generate a usable commit message.");
  if (message.includes("\0")) throw new Error("The generated commit message is invalid.");
  return message.slice(0, 120);
}

function safeGitError(error, fallback) {
  const stderr = String(error?.stderr ?? "").replace(/\s+/g, " ").trim();
  return stderr ? `${fallback}: ${stderr.slice(0, 600)}` : `${fallback}: ${error.message}`;
}
