import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createdAtFromOrNow } from "../../utils/timestamps.mjs";

export class WorkspaceRepository {
  constructor({ getDatabase, selectAll, selectOne, scheduleSave, getSshWorkspaces }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
    this.getSshWorkspaces = getSshWorkspaces;
  }

  get db() {
    return this.getDatabase();
  }

  upsertGitWorkspaceSnapshot(snapshot) {
    const repository = snapshot?.repository;
    if (!repository?.id || !repository.commonGitDirCanonicalPath) {
      throw new Error("A valid Git repository snapshot is required.");
    }
    const observedAt = snapshot.observedAt || new Date().toISOString();
    const existingRepo = this.selectOne(
      "SELECT workspace_id, common_git_dir FROM git_repositories WHERE repository_id = ?",
      [repository.id]
    );
    const existingWorktrees = this.selectAll(
      `SELECT repository_id, worktree_id, path, canonical_path, git_dir, is_main, availability,
              head_oid, branch_ref, branch_name, detached, locked, lock_reason,
              prunable, prune_reason, inventory_version, observed_at
              , resource_version
       FROM git_worktrees WHERE repository_id = ?`,
      [repository.id]
    );
    if (existingRepo?.common_git_dir === repository.commonGitDirCanonicalPath
      && gitWorkspaceSnapshotPersistenceMatches(snapshot, existingWorktrees)) {
      return existingWorktrees
        .sort(compareGitWorktreeRows)
        .map(presentGitWorktreeRow);
    }
    this.db.run("BEGIN IMMEDIATE");
    try {
      const rootPath = snapshot.worktrees?.find((entry) => entry.isMain)?.canonicalPath
        ?? snapshot.worktrees?.find((entry) => entry.isMain)?.path
        ?? repository.commonGitDirCanonicalPath.replace(/\/\.git$/, "");
      const existingWorkspace = this.selectOne(
        "SELECT workspace_id FROM workspaces WHERE canonical_root_path = ?",
        [rootPath]
      );
      const workspaceId = existingRepo?.workspace_id
        ?? existingWorkspace?.workspace_id
        ?? workspaceIdForRepository(repository.id);
      this.db.run(
        `INSERT INTO workspaces (
          workspace_id, kind, ownership, root_path, canonical_root_path, status, created_at, updated_at
        ) VALUES (?, 'linkedLocal', 'userManaged', ?, ?, 'ready', ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          root_path=excluded.root_path,
          canonical_root_path=excluded.canonical_root_path,
          status='ready',
          updated_at=excluded.updated_at`,
        [workspaceId, rootPath, rootPath, observedAt, observedAt]
      );
      // Change-detection: the frontend polls workspace status every few seconds,
      // and each poll previously rewrote `last_validated_at` with a fresh
      // timestamp, bumping the state_sync_clock revision via the git_repositories
      // trigger and fanning a change-set back to every client even when nothing
      // about the repository changed. Persist the repository row only when it is
      // new or its canonical git dir actually moved; a routine re-validation that
      // changes nothing must stay a silent no-op.
      if (!existingRepo || existingRepo.common_git_dir !== repository.commonGitDirCanonicalPath) {
        this.db.run(
          `INSERT INTO git_repositories (
            repository_id, workspace_id, common_git_dir, discovered_at, last_validated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(repository_id) DO UPDATE SET
            workspace_id=excluded.workspace_id,
            common_git_dir=excluded.common_git_dir,
            last_validated_at=excluded.last_validated_at`,
          [
            repository.id,
            workspaceId,
            repository.commonGitDirCanonicalPath,
            repository.discoveredAt || observedAt,
            repository.lastValidatedAt || observedAt
          ]
        );
      }
      this.db.run(
        `UPDATE git_worktrees
         SET availability = 'missing', observed_at = ?, inventory_version = ?
         WHERE repository_id = ?`,
        [observedAt, snapshot.inventoryVersion, repository.id]
      );
      for (const worktree of snapshot.worktrees ?? []) {
        const prior = worktree.gitDirCanonicalPath ? null : this.selectOne(
          "SELECT worktree_id FROM git_worktrees WHERE repository_id = ? AND path = ?",
          [repository.id, worktree.path]
        );
        const worktreeId = prior?.worktree_id ?? worktree.worktreeId;
        this.db.run(
          `INSERT INTO git_worktrees (
            worktree_id, repository_id, path, canonical_path, git_dir, is_main,
            availability, head_oid, branch_ref, branch_name, detached, locked,
            lock_reason, prunable, prune_reason, inventory_version, observed_at, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(worktree_id) DO UPDATE SET
            path=excluded.path,
            canonical_path=excluded.canonical_path,
            git_dir=excluded.git_dir,
            is_main=excluded.is_main,
            availability=excluded.availability,
            head_oid=excluded.head_oid,
            branch_ref=excluded.branch_ref,
            branch_name=excluded.branch_name,
            detached=excluded.detached,
            locked=excluded.locked,
            lock_reason=excluded.lock_reason,
            prunable=excluded.prunable,
            prune_reason=excluded.prune_reason,
            inventory_version=excluded.inventory_version,
            observed_at=excluded.observed_at,
            dedicated=CASE
              WHEN git_worktrees.availability<>'available' AND excluded.availability='available'
                AND EXISTS (
                  SELECT 1 FROM work_session_startup_operations startup
                  WHERE startup.startup_operation_id=git_worktrees.created_by_startup_operation_id
                    AND startup.state IN ('failed_compensated','failed_manual_cleanup')
                )
              THEN 0 ELSE git_worktrees.dedicated END,
            created_by_startup_operation_id=CASE
              WHEN git_worktrees.availability<>'available' AND excluded.availability='available'
                AND EXISTS (
                  SELECT 1 FROM work_session_startup_operations startup
                  WHERE startup.startup_operation_id=git_worktrees.created_by_startup_operation_id
                    AND startup.state IN ('failed_compensated','failed_manual_cleanup')
                )
              THEN NULL ELSE git_worktrees.created_by_startup_operation_id END,
            resource_version=git_worktrees.resource_version+1,
            raw_json=excluded.raw_json`,
          [
            worktreeId,
            repository.id,
            worktree.path,
            worktree.canonicalPath,
            worktree.gitDirCanonicalPath,
            worktree.isMain ? 1 : 0,
            worktree.availability,
            worktree.headOid,
            worktree.branchRef,
            worktree.branchName,
            worktree.isDetached ? 1 : 0,
            worktree.isLocked ? 1 : 0,
            worktree.lockReason,
            worktree.isPrunable ? 1 : 0,
            worktree.pruneReason,
            snapshot.inventoryVersion,
            worktree.observedAt || observedAt,
            JSON.stringify(worktree)
          ]
        );
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.listGitWorktrees(repository.id);
  }

  listGitRepositories() {
    return this.selectAll("SELECT * FROM git_repositories ORDER BY discovered_at ASC").map((row) => {
      const path = row.common_git_dir ?? "";
      const segments = path.split("/").filter(Boolean);
      let name = segments[segments.length - 1] ?? "";
      // common_git_dir 通常指向 <repo>/.git，basename 为 ".git"，展示名取仓库目录名
      if (name === ".git" || name === "worktrees") {
        name = segments[segments.length - 2] ?? name;
      }
      return {
        id: row.repository_id,
        workspaceId: row.workspace_id,
        path,
        name: name || row.repository_id,
        discoveredAt: row.discovered_at,
        lastValidatedAt: row.last_validated_at
      };
    });
  }

  createWorkspace(input = {}) {
    const workspaceId = input.workspaceId ?? `workspace:${randomUUID()}`;
    const kind = input.kind ?? "managedLocal";
    const ownership = input.ownership ?? "corptieManaged";
    const status = input.status ?? (input.rootPath ? "ready" : "pending");
    const rootPath = input.rootPath ? resolve(input.rootPath) : null;
    const canonicalRootPath = input.canonicalRootPath
      ? resolve(input.canonicalRootPath)
      : rootPath;
    const now = createdAtFromOrNow();
    this.db.run(
      `INSERT INTO workspaces (
        workspace_id, kind, ownership, root_path, canonical_root_path, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, kind, ownership, rootPath, canonicalRootPath, status, now, now]
    );
    this.scheduleSave();
    return this.getWorkspace(workspaceId);
  }

  listWorkspaces() {
    const rows = this.selectAll("SELECT * FROM workspaces ORDER BY created_at DESC");
    const locations = rows.some((row) => row.kind === "cloud") ? this.sshWorkspaces.locations() : new Map();
    return rows.map((row) => this.presentWorkspace(row, locations.get(row.workspace_id) ?? null));
  }

  getWorkspace(workspaceId) {
    const row = this.selectOne("SELECT * FROM workspaces WHERE workspace_id = ?", [workspaceId]);
    return row ? this.presentWorkspace(row) : null;
  }

  get sshWorkspaces() {
    return this.getSshWorkspaces();
  }

  presentWorkspace(row, resolvedLocation) {
    const workspace = workspaceFromRow(row);
    if (row.kind !== "cloud") return workspace;
    const location = resolvedLocation === undefined ? this.sshWorkspaces.location(row.workspace_id) : resolvedLocation;
    if (!location) return workspace;
    return { ...workspace, kind: "sshRemote", rootPath: location.rootPath,
      canonicalRootPath: location.rootPath, location };
  }

  getGitRepositoryForWorkspace(workspaceId) {
    const row = this.selectOne(
      "SELECT repository_id FROM git_repositories WHERE workspace_id = ?",
      [workspaceId]
    );
    return row ? this.getGitRepository(row.repository_id) : null;
  }

  resolveWorkspaceRoot(workspaceId) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) return null;
    if (workspace.location?.transport === "ssh") {
      const error = new Error("SSH Workspace paths require the remote Workspace execution service; local path resolution is forbidden.");
      error.code = "REMOTE_WORKSPACE_LOCAL_PATH_FORBIDDEN";
      error.statusCode = 409;
      throw error;
    }
    return workspace.canonicalRootPath ?? workspace.rootPath ?? null;
  }

  getGitRepository(repositoryId) {
    const row = this.selectOne(
      "SELECT * FROM git_repositories WHERE repository_id = ?",
      [repositoryId]
    );
    return row ? {
      id: row.repository_id,
      workspaceId: row.workspace_id,
      commonGitDirCanonicalPath: row.common_git_dir,
      discoveredAt: row.discovered_at,
      lastValidatedAt: row.last_validated_at
    } : null;
  }

  // 解析仓库的真实工作目录（cwd）：优先主 worktree 的 path，退回 common_git_dir 去掉 /.git 后缀。
  resolveWorkspacePath(repositoryId) {
    const worktree = this.selectOne(
      "SELECT path FROM git_worktrees WHERE repository_id = ? AND is_main = 1 LIMIT 1",
      [repositoryId]
    );
    if (worktree?.path) return worktree.path;
    const repo = this.getGitRepository(repositoryId);
    if (!repo?.commonGitDirCanonicalPath) return null;
    return repo.commonGitDirCanonicalPath.replace(/\/\.git$/, "") || null;
  }

  listGitWorktrees(repositoryId) {
    return this.selectAll(
      "SELECT * FROM git_worktrees WHERE repository_id = ? ORDER BY is_main DESC, path ASC",
      [repositoryId]
    ).map(presentGitWorktreeRow);
  }

  listAllGitWorktrees() {
    return this.selectAll(
      "SELECT worktree_id FROM git_worktrees ORDER BY availability ASC, path ASC"
    ).map((row) => this.getGitWorktree(row.worktree_id));
  }

  getGitWorktree(worktreeId) {
    const row = this.selectOne(
      "SELECT * FROM git_worktrees WHERE worktree_id = ?",
      [worktreeId]
    );
    return row ? {
      worktreeId: row.worktree_id,
      repositoryId: row.repository_id,
      path: row.path,
      canonicalPath: row.canonical_path,
      gitDirCanonicalPath: row.git_dir,
      isMain: Boolean(row.is_main),
      availability: row.availability,
      headOid: row.head_oid,
      branchRef: row.branch_ref,
      branchName: row.branch_name,
      isDetached: Boolean(row.detached),
      isLocked: Boolean(row.locked),
      lockReason: row.lock_reason,
      isPrunable: Boolean(row.prunable),
      pruneReason: row.prune_reason,
      inventoryVersion: row.inventory_version,
      dedicated: Boolean(row.dedicated),
      createdByStartupOperationId: row.created_by_startup_operation_id ?? null,
      resourceVersion: Number(row.resource_version ?? 1),
      observedAt: row.observed_at
    } : null;
  }
}

function workspaceFromRow(row) {
  return {
    workspaceId: row.workspace_id,
    kind: row.kind,
    ownership: row.ownership,
    rootPath: row.root_path ?? null,
    canonicalRootPath: row.canonical_root_path ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function workspaceIdForRepository(repositoryId) {
  return `workspace:${createHash("sha256").update(repositoryId).digest("hex").slice(0, 24)}`;
}

function gitWorkspaceSnapshotPersistenceMatches(snapshot, rows) {
  const worktrees = snapshot.worktrees ?? [];
  if (rows.length !== worktrees.length) return false;
  const byId = new Map(rows.map((row) => [row.worktree_id, row]));
  return worktrees.every((worktree) => {
    const row = byId.get(worktree.worktreeId)
      ?? (worktree.gitDirCanonicalPath == null
        ? rows.find((candidate) => candidate.path === worktree.path)
        : null);
    if (!row) return false;
    return row.path === worktree.path
      && row.canonical_path === (worktree.canonicalPath ?? null)
      && row.git_dir === (worktree.gitDirCanonicalPath ?? null)
      && Number(row.is_main) === (worktree.isMain ? 1 : 0)
      && row.availability === worktree.availability
      && row.head_oid === (worktree.headOid ?? null)
      && row.branch_ref === (worktree.branchRef ?? null)
      && row.branch_name === (worktree.branchName ?? null)
      && Number(row.detached) === (worktree.isDetached ? 1 : 0)
      && Number(row.locked) === (worktree.isLocked ? 1 : 0)
      && row.lock_reason === (worktree.lockReason ?? null)
      && Number(row.prunable) === (worktree.isPrunable ? 1 : 0)
      && row.prune_reason === (worktree.pruneReason ?? null)
      && row.inventory_version === snapshot.inventoryVersion;
  });
}

function compareGitWorktreeRows(left, right) {
  if (Boolean(left.is_main) !== Boolean(right.is_main)) return left.is_main ? -1 : 1;
  return String(left.path).localeCompare(String(right.path));
}

function presentGitWorktreeRow(row) {
  return {
    worktreeId: row.worktree_id,
    repositoryId: row.repository_id,
    path: row.path,
    canonicalPath: row.canonical_path,
    gitDirCanonicalPath: row.git_dir,
    isMain: Boolean(row.is_main),
    availability: row.availability,
    headOid: row.head_oid,
    branchRef: row.branch_ref,
    branchName: row.branch_name,
    isDetached: Boolean(row.detached),
    isLocked: Boolean(row.locked),
    lockReason: row.lock_reason,
    isPrunable: Boolean(row.prunable),
    pruneReason: row.prune_reason,
    inventoryVersion: row.inventory_version,
    dedicated: Boolean(row.dedicated),
    createdByStartupOperationId: row.created_by_startup_operation_id ?? null,
    resourceVersion: Number(row.resource_version ?? 1),
    observedAt: row.observed_at
  };
}
