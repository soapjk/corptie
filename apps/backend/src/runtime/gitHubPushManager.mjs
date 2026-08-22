import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectGitWorkspace } from "../utils/gitWorktreeInventory.mjs";

const execFileAsync = promisify(execFile);

export class GitHubPushManager {
  constructor(options = {}) {
    this.execFile = options.execFile ?? execFileAsync;
    this.now = options.now ?? (() => Date.now());
    this.createToken = options.createToken ?? randomUUID;
    this.resolveDestination = options.resolveDestination ?? resolveGitHubDestination;
    this.commitProtection = options.commitProtection ?? null;
    this.confirmations = new Map();
    this.activeBranchPushes = new Set();
    this.confirmationLifetimeMs = options.confirmationLifetimeMs ?? 5 * 60_000;
  }

  async branchStatus(input) {
    try {
      const inspection = await this.inspect(input.workingDirectory);
      const expectedUpstream = `${inspection.remoteName}/${inspection.branch}`;
      return {
        available: true,
        pending: inspection.commitsToPush.length > 0 || inspection.upstream !== expectedUpstream,
        dirty: inspection.dirty,
        unpushedCommitCount: inspection.commitsToPush.length,
        branch: inspection.branch,
        destinationUrl: inspection.destination.url,
        error: null
      };
    } catch (error) {
      return {
        available: false,
        pending: false,
        dirty: false,
        unpushedCommitCount: 0,
        branch: null,
        destinationUrl: null,
        error: understandablePushError(error)
      };
    }
  }

  // Pushes only commits that already exist on the selected local branch. This
  // deliberately never stages, commits, force-pushes, creates a repository, or
  // creates a pull request.
  async pushBranch(input) {
    const inspection = await this.inspect(input.workingDirectory);
    const key = inspection.identity.canonicalPath;
    if (this.activeBranchPushes.has(key)) {
      throw new Error("A GitHub push is already in progress for this Worktree.");
    }
    const expectedUpstream = `${inspection.remoteName}/${inspection.branch}`;
    if (inspection.commitsToPush.length === 0 && inspection.upstream === expectedUpstream) {
      throw new Error("This branch is already up to date with GitHub.");
    }
    this.activeBranchPushes.add(key);
    try {
      const pushArguments = ["push"];
      if (inspection.upstream !== expectedUpstream) pushArguments.push("--set-upstream");
      pushArguments.push(inspection.remoteName, `HEAD:refs/heads/${inspection.branch}`);
      const pushed = await this.runGit(inspection.identity.canonicalPath, pushArguments);
      const headOid = (await this.gitOutput(inspection.identity.canonicalPath, ["rev-parse", "HEAD"])).trim();
      return {
        pushed: true,
        committed: false,
        commitMessage: null,
        headOid,
        branch: inspection.branch,
        destinationUrl: inspection.destination.url,
        stdout: pushed.stdout.trim(),
        stderr: pushed.stderr.trim()
      };
    } catch (error) {
      throw new Error(`GitHub push failed: ${understandablePushError(error)}`);
    } finally {
      this.activeBranchPushes.delete(key);
    }
  }

  async prepare(input) {
    this.pruneExpired();
    const inspection = await this.inspect(input.workingDirectory);
    if (!inspection.dirty && inspection.commitsToPush.length === 0) {
      throw new Error("There are no changes or commits to push to GitHub.");
    }
    const commitProtection = inspection.dirty && this.commitProtection
      ? await this.commitProtection.inspect(inspection.identity.canonicalPath)
      : null;
    const confirmationToken = this.createToken();
    const expiresAtMs = this.now() + this.confirmationLifetimeMs;
    this.confirmations.set(confirmationToken, {
      sessionId: input.sessionId,
      worktreeId: inspection.identity.worktreeId,
      canonicalPath: inspection.identity.canonicalPath,
      fingerprint: inspection.fingerprint,
      expiresAtMs
    });
    return {
      confirmationToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
      repository: inspection.destination.repository,
      destinationService: "GitHub",
      remoteName: inspection.remoteName,
      remoteUrl: inspection.remoteUrl,
      destinationUrl: inspection.destination.url,
      branch: inspection.branch,
      includesSourceCode: true,
      visibility: "Uses the existing GitHub repository access settings; Corptie does not change visibility.",
      retention: "Pushed commits remain in the GitHub repository history until removed according to repository and GitHub retention policies.",
      action: inspection.dirty
        ? "Generate a commit message, commit all current Worktree changes, and push the branch to GitHub."
        : "Push the current branch commits to GitHub.",
      dirty: inspection.dirty,
      changedFiles: inspection.changedFiles,
      filesToPush: inspection.filesToPush,
      addedFiles: inspection.addedFiles,
      modifiedFiles: inspection.modifiedFiles,
      deletedFiles: inspection.deletedFiles,
      commitsToPush: inspection.commitsToPush,
      statusSummary: inspection.statusSummary,
      commitProtection
    };
  }

  async status(input) {
    try {
      const inspection = await this.inspect(input.workingDirectory);
      return {
        available: true,
        pending: inspection.dirty || inspection.commitsToPush.length > 0,
        dirty: inspection.dirty,
        unpushedCommitCount: inspection.commitsToPush.length,
        branch: inspection.branch,
        destinationUrl: inspection.destination.url,
        error: null
      };
    } catch (error) {
      return {
        available: false,
        pending: false,
        dirty: false,
        unpushedCommitCount: 0,
        branch: null,
        destinationUrl: null,
        error: error.message
      };
    }
  }

  async generateCommitMessage(input) {
    this.pruneExpired();
    const { confirmation, inspection } = await this.validatedConfirmation(input);
    if (!inspection.dirty) {
      throw new Error("The Worktree has no uncommitted changes that need a commit message.");
    }
    return input.generateCommitMessage({
      sourceBranch: inspection.branch,
      sourcePath: confirmation.canonicalPath,
      statusSummary: inspection.statusSummary,
      diffStat: inspection.diffStat
    });
  }

  async confirm(input) {
    this.pruneExpired();
    const { confirmation, inspection: validatedInspection } = await this.validatedConfirmation(input);
    this.confirmations.delete(input.confirmationToken);
    let inspection = validatedInspection;
    let expectedFingerprint = confirmation.fingerprint;

    if (inspection.dirty && this.commitProtection) {
      const protection = await this.commitProtection.inspect(confirmation.canonicalPath);
      if (protection.requiresDecision) {
        await this.commitProtection.resolve(confirmation.canonicalPath, {
          decision: input.privateFilesDecision,
          neverRemind: input.neverRemindPrivateFiles === true
        });
        inspection = await this.inspect(confirmation.canonicalPath);
        expectedFingerprint = inspection.fingerprint;
      }
    }

    let commitMessage = null;
    if (inspection.dirty) {
      commitMessage = requiredCommitMessage(input.commitMessage)
        ?? await input.generateCommitMessage({
          sourceBranch: inspection.branch,
          sourcePath: inspection.identity.canonicalPath,
          statusSummary: inspection.statusSummary,
          diffStat: inspection.diffStat
        });
      const afterMessage = await this.inspect(confirmation.canonicalPath);
      if (afterMessage.fingerprint !== expectedFingerprint) {
        throw new Error("The Worktree changed while generating the commit message. Review the push details again.");
      }
      await this.runGit(confirmation.canonicalPath, ["add", "--all"]);
      await this.runGit(confirmation.canonicalPath, ["commit", "-m", commitMessage]);
      inspection = await this.inspect(confirmation.canonicalPath);
      if (inspection.dirty) {
        throw new Error("The Worktree still has uncommitted changes after the commit; nothing was pushed.");
      }
    }

    const pushArguments = ["push"];
    if (inspection.upstream !== `${inspection.remoteName}/${inspection.branch}`) {
      pushArguments.push("--set-upstream");
    }
    pushArguments.push(inspection.remoteName, `HEAD:refs/heads/${inspection.branch}`);
    const pushed = await this.runGit(confirmation.canonicalPath, pushArguments);
    const headOid = (await this.gitOutput(confirmation.canonicalPath, ["rev-parse", "HEAD"])).trim();
    return {
      pushed: true,
      committed: Boolean(commitMessage),
      commitMessage,
      headOid,
      branch: inspection.branch,
      destinationUrl: inspection.destination.url,
      stdout: pushed.stdout.trim(),
      stderr: pushed.stderr.trim()
    };
  }

  async validatedConfirmation(input) {
    const confirmation = this.confirmations.get(input.confirmationToken);
    if (!confirmation || confirmation.sessionId !== input.sessionId) {
      throw new Error("The GitHub push confirmation is missing or expired. Review the push details again.");
    }
    const inspection = await this.inspect(confirmation.canonicalPath);
    if (inspection.identity.worktreeId !== confirmation.worktreeId
      || inspection.fingerprint !== confirmation.fingerprint) {
      throw new Error("The Worktree or push contents changed after confirmation. Review the push details again.");
    }
    return { confirmation, inspection };
  }

  async inspect(workingDirectory) {
    const identity = await inspectGitWorkspace(workingDirectory, { execFile: this.execFile });
    const [branch, remote, statusRaw, statusSummary, diffStat] = await Promise.all([
      this.gitOutput(identity.canonicalPath, ["symbolic-ref", "--quiet", "--short", "HEAD"])
        .then((value) => value.trim()),
      this.resolveGitHubRemote(identity.canonicalPath),
      this.gitOutput(identity.canonicalPath, ["status", "--porcelain=v1", "-z"]),
      this.gitOutput(identity.canonicalPath, ["status", "--short"]),
      this.gitOutput(identity.canonicalPath, ["diff", "--stat", "HEAD"])
    ]);
    if (!branch) throw new Error("Detached HEAD Worktrees cannot be pushed with this action.");
    const { remoteName, remoteUrl, destination } = remote;
    const changedFiles = parsePorcelainPaths(statusRaw);
    const upstream = await this.optionalGitOutput(identity.canonicalPath, [
      "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"
    ]).then((value) => value?.trim() || null);
    const remoteBranchRef = `refs/remotes/${remoteName}/${branch}`;
    const hasRemoteBranch = await this.gitSucceeds(identity.canonicalPath, [
      "rev-parse", "--verify", remoteBranchRef
    ]);
    const expectedUpstream = `${remoteName}/${branch}`;
    const baseRef = upstream === expectedUpstream
      ? upstream
      : (hasRemoteBranch ? remoteBranchRef : null);
    const commitsToPush = await this.commitList(identity.canonicalPath, baseRef);
    const fileChanges = await this.fileChangesForPush(identity.canonicalPath, baseRef);
    const addedFiles = fileChanges.added;
    const modifiedFiles = fileChanges.modified;
    const deletedFiles = fileChanges.deleted;
    const filesToPush = [...new Set([...addedFiles, ...modifiedFiles, ...deletedFiles])].sort();
    const headOid = (await this.gitOutput(identity.canonicalPath, ["rev-parse", "HEAD"])).trim();
    const dirty = Boolean(statusRaw);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      worktreeId: identity.worktreeId,
      headOid,
      branch,
      remoteName,
      remoteUrl,
      statusRaw,
      upstream
    })).digest("hex");
    return {
      identity,
      branch,
      remoteName,
      remoteUrl,
      destination,
      statusRaw,
      statusSummary: statusSummary.trim(),
      diffStat: diffStat.trim(),
      changedFiles,
      filesToPush,
      addedFiles,
      modifiedFiles,
      deletedFiles,
      commitsToPush,
      upstream,
      dirty,
      fingerprint
    };
  }

  async commitList(cwd, baseRef) {
    const range = baseRef ? `${baseRef}..HEAD` : "HEAD";
    const output = await this.gitOutput(cwd, ["log", "--format=%H%x00%s%x00", range]);
    const fields = output.split("\0").filter(Boolean);
    const commits = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      commits.push({ oid: fields[index], subject: fields[index + 1] });
    }
    return commits;
  }

  async resolveGitHubRemote(cwd) {
    const names = (await this.gitOutput(cwd, ["remote"]))
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    const candidates = [];
    for (const remoteName of names) {
      const remoteUrl = (await this.gitOutput(cwd, ["remote", "get-url", remoteName])).trim();
      try {
        candidates.push({ remoteName, remoteUrl, destination: this.resolveDestination(remoteUrl) });
      } catch {
        // A repository may also have non-GitHub remotes. They are not eligible
        // for this explicitly GitHub-scoped action.
      }
    }
    const origin = candidates.find((candidate) => candidate.remoteName === "origin");
    if (origin) return origin;
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) {
      throw new Error("No supported GitHub remote is configured for this repository.");
    }
    throw new Error("More than one GitHub remote is configured. Rename the intended destination to origin before pushing.");
  }

  async fileChangesForPush(cwd, baseRef) {
    if (!baseRef) {
      const [tracked, untracked] = await Promise.all([
        this.gitOutput(cwd, ["ls-files", "-z"]),
        this.gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
      ]);
      return {
        added: [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort(),
        modified: [],
        deleted: []
      };
    }

    const [diffOutput, untrackedOutput] = await Promise.all([
      this.gitOutput(cwd, ["diff", "--name-status", "-z", "--no-renames", baseRef]),
      this.gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
    ]);
    const changes = parseNameStatusChanges(diffOutput);
    changes.added.push(...untrackedOutput.split("\0").filter(Boolean));
    return {
      added: [...new Set(changes.added)].sort(),
      modified: [...new Set(changes.modified)].sort(),
      deleted: [...new Set(changes.deleted)].sort()
    };
  }

  pruneExpired() {
    const now = this.now();
    for (const [token, confirmation] of this.confirmations) {
      if (confirmation.expiresAtMs <= now) this.confirmations.delete(token);
    }
  }

  async runGit(cwd, arguments_) {
    try {
      const result = await this.execFile("git", ["-C", cwd, ...arguments_], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024
      });
      return { stdout: String(result?.stdout ?? ""), stderr: String(result?.stderr ?? "") };
    } catch (error) {
      const detail = String(error?.stderr || error?.stdout || error?.message || "Git command failed").trim();
      throw new Error(detail);
    }
  }

  async gitOutput(cwd, arguments_) {
    return this.runGit(cwd, arguments_).then((result) => result.stdout);
  }

  async optionalGitOutput(cwd, arguments_) {
    try {
      return await this.gitOutput(cwd, arguments_);
    } catch {
      return null;
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

export function resolveGitHubDestination(remoteUrl) {
  const value = String(remoteUrl ?? "").trim();
  const match = value.match(/^(?:git@github\.com:|https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!match) throw new Error("The origin remote is not a supported GitHub repository URL.");
  const owner = match[1];
  const repositoryName = match[2];
  return {
    repository: `${owner}/${repositoryName}`,
    url: `https://github.com/${owner}/${repositoryName}`
  };
}

export function parsePorcelainPaths(output) {
  const fields = String(output ?? "").split("\0");
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (path) paths.push(path);
    if (/[RC]/.test(code) && fields[index + 1]) {
      paths.push(fields[index + 1]);
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

export function parseNameStatusChanges(output) {
  const fields = String(output ?? "").split("\0").filter(Boolean);
  const changes = { added: [], modified: [], deleted: [] };
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index].charAt(0);
    const path = fields[index + 1];
    if (!path) continue;
    if (status === "A") changes.added.push(path);
    else if (status === "D") changes.deleted.push(path);
    else changes.modified.push(path);
  }
  return changes;
}

function requiredCommitMessage(value) {
  const message = typeof value === "string" ? value.trim() : "";
  if (!message) return null;
  if (message.includes("\0")) throw new Error("The commit message is invalid.");
  return message;
}

function understandablePushError(error) {
  const detail = String(error?.message ?? error ?? "The Git command failed.").trim();
  if (/No such remote|No remote configured to list refs from/i.test(detail)) {
    return "No supported GitHub remote is configured for this repository.";
  }
  if (/Could not resolve host|Could not read from remote repository/i.test(detail)) {
    return "GitHub could not be reached or the repository access credentials were rejected.";
  }
  if (/Authentication failed|Permission denied \(publickey\)|Repository not found/i.test(detail)) {
    return "GitHub authentication failed or this account cannot access the configured repository.";
  }
  if (/non-fast-forward|fetch first|rejected/i.test(detail)) {
    return "GitHub rejected the push because the remote branch has newer commits. Fetch and integrate them before pushing again.";
  }
  return detail;
}
