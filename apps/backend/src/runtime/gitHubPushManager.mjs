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
    this.confirmationLifetimeMs = options.confirmationLifetimeMs ?? 5 * 60_000;
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
      remoteName: "origin",
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

  async confirm(input) {
    this.pruneExpired();
    const confirmation = this.confirmations.get(input.confirmationToken);
    if (!confirmation || confirmation.sessionId !== input.sessionId) {
      throw new Error("The GitHub push confirmation is missing or expired. Review the push details again.");
    }
    this.confirmations.delete(input.confirmationToken);
    let inspection = await this.inspect(confirmation.canonicalPath);
    if (inspection.identity.worktreeId !== confirmation.worktreeId
      || inspection.fingerprint !== confirmation.fingerprint) {
      throw new Error("The Worktree or push contents changed after confirmation. Review the push details again.");
    }
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
      commitMessage = await input.generateCommitMessage({
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
    if (!inspection.upstream) pushArguments.push("--set-upstream");
    pushArguments.push("origin", `HEAD:refs/heads/${inspection.branch}`);
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

  async inspect(workingDirectory) {
    const identity = await inspectGitWorkspace(workingDirectory, { execFile: this.execFile });
    const [branch, remoteUrl, statusRaw, statusSummary, diffStat] = await Promise.all([
      this.gitOutput(identity.canonicalPath, ["symbolic-ref", "--quiet", "--short", "HEAD"])
        .then((value) => value.trim()),
      this.gitOutput(identity.canonicalPath, ["remote", "get-url", "origin"])
        .then((value) => value.trim()),
      this.gitOutput(identity.canonicalPath, ["status", "--porcelain=v1", "-z"]),
      this.gitOutput(identity.canonicalPath, ["status", "--short"]),
      this.gitOutput(identity.canonicalPath, ["diff", "--stat", "HEAD"])
    ]);
    if (!branch) throw new Error("Detached HEAD Worktrees cannot be pushed with this action.");
    const destination = this.resolveDestination(remoteUrl);
    const changedFiles = parsePorcelainPaths(statusRaw);
    const upstream = await this.optionalGitOutput(identity.canonicalPath, [
      "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"
    ]).then((value) => value?.trim() || null);
    const originBranchRef = `refs/remotes/origin/${branch}`;
    const hasOriginBranch = await this.gitSucceeds(identity.canonicalPath, [
      "rev-parse", "--verify", originBranchRef
    ]);
    const baseRef = upstream || (hasOriginBranch ? originBranchRef : null);
    const commitsToPush = await this.commitList(identity.canonicalPath, baseRef);
    const committedFiles = await this.filesForPush(identity.canonicalPath, baseRef);
    const filesToPush = [...new Set([...committedFiles, ...changedFiles])].sort();
    const headOid = (await this.gitOutput(identity.canonicalPath, ["rev-parse", "HEAD"])).trim();
    const dirty = Boolean(statusRaw);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      worktreeId: identity.worktreeId,
      headOid,
      branch,
      remoteUrl,
      statusRaw,
      upstream
    })).digest("hex");
    return {
      identity,
      branch,
      remoteUrl,
      destination,
      statusRaw,
      statusSummary: statusSummary.trim(),
      diffStat: diffStat.trim(),
      changedFiles,
      filesToPush,
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

  async filesForPush(cwd, baseRef) {
    const output = baseRef
      ? await this.gitOutput(cwd, ["diff", "--name-only", "-z", `${baseRef}...HEAD`])
      : await this.gitOutput(cwd, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]);
    return output.split("\0").filter(Boolean).sort();
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
