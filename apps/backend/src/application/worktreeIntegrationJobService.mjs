import { createHash, randomUUID } from "node:crypto";

const ACTIVE_JOB_STATUSES = Object.freeze([
  "queued", "running", "paused", "cancellation_requested", "replanning"
]);
const DEFAULT_CANDIDATE_TTL_MS = 120_000;
const MAX_CANDIDATE_TTL_MS = 300_000;
const MAX_CACHED_CANDIDATES = 128;
const MAX_CACHED_CANDIDATES_PER_REPOSITORY = 8;
const PLAN_FINGERPRINT_VERSION = 1;
const START_REQUEST_FINGERPRINT_VERSION = 1;

export class WorktreeIntegrationJobError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message);
    this.name = "WorktreeIntegrationJobError";
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

// Repository-wide Git integration is a project capability. It deliberately has
// no Agent Provider dependency: Sessions and Tasks are presentation links.
export class WorktreeIntegrationJobService {
  constructor(options = {}) {
    this.store = options.store;
    this.inspectRepository = options.inspectRepository;
    this.inspectRepositorySummary = options.inspectRepositorySummary ?? options.inspectRepository;
    this.inspectGitHubPushStatus = options.inspectGitHubPushStatus ?? null;
    this.commitChanges = options.commitChanges;
    this.inspectCommitProtection = options.inspectCommitProtection;
    this.mergeSource = options.mergeSource;
    this.abortMerge = options.abortMerge;
    this.rebaseSource = options.rebaseSource ?? null;
    this.fastForwardSource = options.fastForwardSource ?? null;
    this.prepareConvergence = options.prepareConvergence ?? null;
    this.cleanupConvergence = options.cleanupConvergence ?? null;
    this.prepareConflictResolution = options.prepareConflictResolution;
    this.inspectConflictResolution = options.inspectConflictResolution;
    this.launchConflictResolution = options.launchConflictResolution;
    this.removeWorktree = options.removeWorktree;
    this.isSessionActive = options.isSessionActive ?? (() => false);
    this.onDeletionFailure = options.onDeletionFailure ?? (() => {});
    this.onEvent = options.onEvent ?? (() => {});
    this.activeJobs = new Set();
    this.activeConflictResolutions = new Map();
    this.integrationCandidates = new Map();
    this.repositoryStartOperations = new Map();
    this.candidateTtlMs = Math.max(1_000, Math.min(
      Number(options.candidateTtlMs) || DEFAULT_CANDIDATE_TTL_MS,
      MAX_CANDIDATE_TTL_MS
    ));
    this.now = options.now ?? (() => Date.now());
    this.maxConflictFallbackAttempts = Math.max(1, Math.min(Number(options.maxConflictFallbackAttempts) || 3, 10));
    for (const name of [
      "inspectRepository",
      "inspectCommitProtection",
      "commitChanges",
      "mergeSource",
      "abortMerge",
      "prepareConflictResolution",
      "inspectConflictResolution",
      "launchConflictResolution"
    ]) {
      if (typeof this[name] !== "function") throw new TypeError(`${name}() is required.`);
    }
    for (const name of [
      "getWorktreeIntegrationJobByIdempotencyKey",
      "createWorktreeIntegrationJobIdempotently"
    ]) {
      if (typeof this.store?.[name] !== "function") throw new TypeError(`store.${name}() is required.`);
    }
  }

  repositories() {
    return this.store.listGitRepositories().map((repository) => {
      const worktrees = this.store.listGitWorktrees(repository.id);
      const main = worktrees.find((worktree) => worktree.isMain && worktree.availability === "available")
        ?? worktrees.find((worktree) => worktree.isMain);
      return {
        ...repository,
        mainPath: main?.path ?? this.store.resolveWorkspacePath(repository.id),
        availability: main?.availability ?? "missing",
        worktreeCount: worktrees.filter((worktree) => worktree.availability === "available").length
      };
    });
  }

  async repository(repositoryId, options = {}) {
    const repository = this.#requireRepository(repositoryId);
    const inspection = await this.inspectRepositorySummary(repository.id, options);
    const project = this.#associate(inspection);
    return {
      repository: this.repositories().find((entry) => entry.id === repository.id),
      // GitHub inspection executes many Git commands per Worktree. Keep the
      // management inventory fast and load push state only for the Worktree
      // the user actually selects.
      project: {
        ...project,
        worktrees: project.worktrees.map((worktree) => ({ ...worktree, gitHubPush: null }))
      },
      latestJob: presentJob(this.store.getLatestWorktreeIntegrationJob(repository.id))
    };
  }

  async worktreeGitHubPushStatus(repositoryId, worktreeId) {
    const repository = this.#requireRepository(repositoryId);
    const worktree = this.store.listGitWorktrees(repository.id)
      .find((entry) => entry.worktreeId === worktreeId);
    if (!worktree) {
      throw new WorktreeIntegrationJobError(
        "WORKTREE_NOT_FOUND",
        "The selected Worktree no longer exists.",
        404
      );
    }
    return {
      repositoryId: repository.id,
      worktreeId: worktree.worktreeId,
      gitHubPush: await this.#gitHubPushStatus(worktree)
    };
  }

  async deleteWorktree(repositoryId, worktreeId) {
    const requestedRepositoryId = String(repositoryId ?? "").trim();
    const requestedWorktreeId = String(worktreeId ?? "").trim();
    try {
      const repository = this.#requireRepository(requestedRepositoryId);
      if (typeof this.removeWorktree !== "function") {
        throw new TypeError("removeWorktree() is required for Worktree deletion.");
      }
      const inspection = await this.inspectRepository(repository.id);
      const inspectedWorktree = inspection.worktrees.find((entry) => entry.worktreeId === requestedWorktreeId);
      if (!inspectedWorktree) {
        throw new WorktreeIntegrationJobError("WORKTREE_NOT_FOUND", "The selected Worktree no longer exists.", 404);
      }
      const deletionState = this.#deletionState(inspectedWorktree);
      const { worktree, blocker } = deletionState;
      if (blocker) {
        throw new WorktreeIntegrationJobError(blocker.code, blocker.reason, 409);
      }
      const removal = await this.removeWorktree({
        repositoryId: repository.id,
        mainPath: inspection.mainPath,
        worktreeId: worktree.worktreeId,
        ignoreLogicalSessionIds: deletionState.releasableLogicalSessionIds
      });
      return deletionResult(worktree, "removed", null, null, removal);
    } catch (error) {
      const reportedError = !(error instanceof WorktreeIntegrationJobError) && isDeletionBlockerCode(error?.code)
        ? new WorktreeIntegrationJobError(error.code, error.message, 409)
        : error;
      this.#reportDeletionFailure(requestedRepositoryId, requestedWorktreeId, reportedError);
      throw reportedError;
    }
  }

  async cleanupMergedWorktrees(repositoryId, input = {}) {
    const repository = this.#requireRepository(repositoryId);
    if (typeof this.removeWorktree !== "function") {
      throw new TypeError("removeWorktree() is required for Worktree cleanup.");
    }
    const inspection = await this.inspectRepository(repository.id);
    const removed = [];
    const skipped = [];
    const failed = [];
    const confirmedWorktreeIds = new Set(Array.isArray(input.worktreeIds)
      ? input.worktreeIds.map((value) => String(value).trim()).filter(Boolean)
      : []);
    const candidates = inspection.worktrees
      .filter((worktree) => !worktree.isMain)
      .map((worktree) => this.#deletionState(worktree))
      .sort((left, right) => `${left.worktree.branchName ?? ""}\0${left.worktree.path}`
        .localeCompare(`${right.worktree.branchName ?? ""}\0${right.worktree.path}`));
    for (const deletionState of candidates) {
      const { worktree, blocker } = deletionState;
      if (blocker) {
        skipped.push(deletionResult(worktree, "skipped", blocker.code, blocker.reason));
        continue;
      }
      if (!confirmedWorktreeIds.has(worktree.worktreeId)) {
        skipped.push(deletionResult(worktree, "skipped", "NOT_IN_CONFIRMED_SCOPE", "This Worktree was not included in the confirmed cleanup scope."));
        continue;
      }
      try {
        const removal = await this.removeWorktree({
          repositoryId: repository.id,
          mainPath: inspection.mainPath,
          worktreeId: worktree.worktreeId,
          ignoreLogicalSessionIds: deletionState.releasableLogicalSessionIds
        });
        removed.push(deletionResult(worktree, "removed", null, null, removal));
      } catch (error) {
        this.#reportDeletionFailure(repository.id, worktree.worktreeId, error);
        const target = isDeletionBlockerCode(error?.code) ? skipped : failed;
        target.push(deletionResult(
          worktree,
          target === skipped ? "skipped" : "failed",
          error?.code ?? "WORKTREE_DELETE_FAILED",
          error?.message ?? "The Worktree could not be removed."
        ));
      }
    }
    return {
      removed,
      skipped,
      failed,
      counts: { removed: removed.length, skipped: skipped.length, failed: failed.length }
    };
  }

  async preflight(repositoryId, options = {}) {
    const repository = this.#requireRepository(repositoryId);
    this.#assertNoActiveJob(repository.id, options.ignoreJobId, true);
    const built = await this.#buildPlan(repository, options);
    let job = this.store.createWorktreeIntegrationJob({
      repositoryId: repository.id,
      planFingerprint: built.planFingerprint,
      fingerprintVersion: PLAN_FINGERPRINT_VERSION,
      status: built.noWorkRequired ? "completed" : "awaiting_confirmation",
      phase: built.noWorkRequired ? "completed" : "preflight_complete",
      details: {
        plan: built.plan,
        currentWorktreeId: null,
        progress: progressFor(built.plan.items),
        audit: [{
          at: new Date().toISOString(),
          event: built.noWorkRequired ? "preflight_no_changes" : "preflight_created",
          planFingerprint: built.planFingerprint
        }]
      }
    });
    if (built.noWorkRequired) {
      job = this.store.updateWorktreeIntegrationJob(job.id, { completedAt: new Date().toISOString() });
    }
    return presentJob(job);
  }

  async #buildPlan(repository, options = {}, inspectionOptions = {}) {
    const branchOperation = normalizeBranchOperation(options);
    if (branchOperation) {
      const plan = await this.#buildBranchOperationPlan(repository, branchOperation, inspectionOptions);
      return { plan, planFingerprint: fingerprint(plan), noWorkRequired: false };
    }
    const inspection = this.#associate(await this.inspectRepository(repository.id, inspectionOptions));
    const ordered = [...inspection.worktrees].sort((left, right) => {
      if (left.isMain !== right.isMain) return left.isMain ? -1 : 1;
      return `${left.branchName ?? ""}\0${left.path}`.localeCompare(`${right.branchName ?? ""}\0${right.path}`);
    });
    const blockingRisks = [];
    let mergeOrdinal = 0;
    const items = [];
    const requiredWorktrees = ordered.filter((worktree) => (
      requiresIntegration(worktree) || risksFor(worktree).length > 0
    ));
    const includeMainContext = requiredWorktrees.some((worktree) => !worktree.isMain);
    const plannedWorktrees = ordered.filter((worktree) => (
      requiredWorktrees.some((required) => required.worktreeId === worktree.worktreeId)
        || (worktree.isMain && includeMainContext)
    ));
    for (const worktree of plannedWorktrees) {
      const ordinal = worktree.isMain ? 0 : ++mergeOrdinal;
      const risks = risksFor(worktree);
      // The integration task must never preserve main changes on the user's
      // behalf. A dirty main is a read-only blocker that the user resolves
      // outside this flow; only task Worktrees may receive a planned commit.
      const shouldCommit = !worktree.isMain && worktree.dirty === true;
      const commitProtection = shouldCommit
        ? withProtectedPathsDigest(await this.inspectCommitProtection(worktree.path))
        : null;
      if ((commitProtection?.localSymlinkPaths ?? []).length > 0) {
        risks.push({
          code: "GIT_LOCAL_AGENT_SYMLINK_NOT_COMMITTABLE",
          message: `Local Agent configuration links cannot be committed: ${commitProtection.localSymlinkPaths.join(", ")}.`
        });
      }
      blockingRisks.push(...risks.map((risk) => ({ worktreeId: worktree.worktreeId, ...risk })));
      const label = worktree.branchName ?? worktree.path.split("/").filter(Boolean).at(-1) ?? "Worktree";
      items.push({
        ordinal,
        worktreeId: worktree.worktreeId,
        path: worktree.path,
        branchName: worktree.branchName,
        isMain: worktree.isMain,
        availability: worktree.availability,
        sourceHeadBefore: worktree.headOid,
        statusSummary: worktree.statusSummary ?? "",
        changedFiles: worktree.changedFiles ?? [],
        dirty: worktree.dirty === true,
        aheadOfMain: worktree.aheadOfMain,
        behindMain: worktree.behindMain,
        mergedIntoMain: worktree.mergedIntoMain,
        associations: worktree.associations,
        risks,
        commitProtection,
        commitMessage: shouldCommit ? `Corptie: preserve changes in ${label}`.slice(0, 120) : null,
        commitStatus: shouldCommit ? "pending" : "not_needed",
        commitHead: null,
        // A dirty branch needs merging even when its current HEAD is already an
        // ancestor of main: the planned local commit will create a new source HEAD.
        mergeStatus: worktree.isMain
          ? "not_needed"
          : (worktree.dirty === true || worktree.mergedIntoMain !== true ? "pending" : "not_needed"),
        mergeMainHead: null,
        resolutionHead: null,
        conflictFiles: [...(worktree.conflictFiles ?? [])],
        error: null
      });
    }
    const plan = {
      repositoryId: repository.id,
      mainWorktreeId: inspection.mainWorktreeId,
      mainPath: inspection.mainPath,
      mainHeadBefore: inspection.mainHeadOid,
      inventoryVersion: inspection.inventoryVersion,
      validationSnapshot: planValidationSnapshot(inspection),
      mergeOrder: items.filter((item) => !item.isMain && item.mergeStatus === "pending").map((item) => item.worktreeId),
      blockingRisks,
      items
    };
    return {
      plan,
      planFingerprint: fingerprint(plan),
      noWorkRequired: items.length === 0
    };
  }

  async #buildBranchOperationPlan(repository, operation, inspectionOptions = {}) {
    const inspection = this.#associate(await this.inspectRepository(repository.id, inspectionOptions));
    const byId = new Map(inspection.worktrees.map((worktree) => [worktree.worktreeId, worktree]));
    const selectedIds = operation.type === "converge"
      ? operation.sourceWorktreeIds
      : [...operation.sourceWorktreeIds, operation.targetWorktreeId];
    const uniqueIds = [...new Set(selectedIds)];
    const missingId = uniqueIds.find((id) => !byId.has(id));
    if (missingId) {
      throw new WorktreeIntegrationJobError("WORKTREE_NOT_FOUND", `The selected Worktree no longer exists: ${missingId}.`, 404);
    }
    const target = byId.get(operation.targetWorktreeId);
    if (!target || target.isDetached || !target.branchName) {
      throw new WorktreeIntegrationJobError("TARGET_BRANCH_AMBIGUOUS", "Choose an available Worktree with a local branch as the target.", 409);
    }
    const sourceIds = operation.sourceWorktreeIds.filter((id) => id !== target.worktreeId);
    if (sourceIds.length === 0) {
      throw new WorktreeIntegrationJobError("SOURCE_WORKTREE_REQUIRED", "Select at least one source Worktree.");
    }
    const ordered = [target, ...sourceIds.map((id) => byId.get(id))];
    const blockingRisks = [];
    const items = [];
    for (const [index, worktree] of ordered.entries()) {
      const isTarget = worktree.worktreeId === target.worktreeId;
      const risks = risksForBranchOperation(worktree, { isTarget, operationType: operation.type });
      const shouldCommit = !isTarget && worktree.dirty === true;
      const commitProtection = shouldCommit
        ? withProtectedPathsDigest(await this.inspectCommitProtection(worktree.path))
        : null;
      if ((commitProtection?.localSymlinkPaths ?? []).length > 0) {
        risks.push({
          code: "GIT_LOCAL_AGENT_SYMLINK_NOT_COMMITTABLE",
          message: `Local Agent configuration links cannot be committed: ${commitProtection.localSymlinkPaths.join(", ")}.`
        });
      }
      blockingRisks.push(...risks.map((risk) => ({ worktreeId: worktree.worktreeId, ...risk })));
      const label = worktree.branchName ?? worktree.path.split("/").filter(Boolean).at(-1) ?? "Worktree";
      items.push({
        ordinal: isTarget ? 0 : index,
        worktreeId: worktree.worktreeId,
        path: worktree.path,
        branchName: worktree.branchName,
        isMain: isTarget,
        actualIsMain: worktree.isMain === true,
        isTarget,
        availability: worktree.availability,
        sourceHeadBefore: worktree.headOid,
        statusSummary: worktree.statusSummary ?? "",
        changedFiles: worktree.changedFiles ?? [],
        dirty: worktree.dirty === true,
        aheadOfMain: worktree.aheadOfMain,
        behindMain: worktree.behindMain,
        mergedIntoMain: worktree.mergedIntoMain,
        associations: worktree.associations,
        risks,
        commitProtection,
        commitMessage: shouldCommit ? `Corptie: preserve changes in ${label}`.slice(0, 120) : null,
        commitStatus: shouldCommit ? "pending" : "not_needed",
        commitHead: null,
        mergeStatus: isTarget ? "not_needed" : "pending",
        mergeMainHead: null,
        resolutionHead: null,
        convergenceStatus: operation.type === "converge" ? "pending" : "not_needed",
        conflictFiles: [...(worktree.conflictFiles ?? [])],
        error: null
      });
    }
    const plan = {
      repositoryId: repository.id,
      operationType: operation.type,
      syncMode: operation.type === "sync" ? "one_way" : (operation.type === "converge" ? "converge" : null),
      targetWorktreeId: target.worktreeId,
      targetBranchName: target.branchName,
      sourceWorktreeIds: sourceIds,
      mainWorktreeId: target.worktreeId,
      mainPath: target.path,
      mainHeadBefore: target.headOid,
      inventoryVersion: inspection.inventoryVersion,
      validationSnapshot: planValidationSnapshot(inspection),
      mergeOrder: sourceIds,
      blockingRisks,
      items
    };
    return plan;
  }

  async createCandidate(repositoryId, options = {}) {
    const repository = this.#requireRepository(repositoryId);
    const input = requestObject(options);
    const normalizedOptions = candidateOptions(input);
    const built = await this.#buildPlan(repository, normalizedOptions, {
      forceFresh: true,
      reason: "integration_candidate_generation"
    });
    return this.#cacheCandidate(repository.id, normalizedOptions, built);
  }

  async startCandidate(repositoryId, input = {}) {
    const repository = this.#requireRepository(repositoryId);
    input = requestObject(input);
    const idempotencyKey = requiredBoundedText(input.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED", 512);
    const requestedOptions = candidateOptions(input, { canonicalOnly: true });
    const commitProtectionDecisions = normalizeCommitProtectionDecisions(input.commitProtectionDecisions);
    const startRequestFingerprint = startRequestFingerprintFor(
      repository.id,
      input,
      requestedOptions,
      commitProtectionDecisions
    );
    return this.#serializeCandidateStart(
      repository.id,
      idempotencyKey,
      startRequestFingerprint,
      () => this.#startCandidate(
        repository,
        input,
        requestedOptions,
        idempotencyKey,
        startRequestFingerprint,
        commitProtectionDecisions
      )
    );
  }

  async #startCandidate(
    repository,
    input,
    requestedOptions,
    idempotencyKey,
    startRequestFingerprint,
    commitProtectionDecisions
  ) {
    const existing = this.store.getWorktreeIntegrationJobByIdempotencyKey?.(repository.id, idempotencyKey);
    if (existing) return presentJob(assertIdempotentReplay(existing, startRequestFingerprint));

    const candidateId = String(input.candidateId ?? input.id ?? "").trim();
    const candidateFingerprint = String(input.candidateFingerprint ?? input.planFingerprint ?? "").trim();
    if (!candidateId || !candidateFingerprint) {
      throw new WorktreeIntegrationJobError(
        "CANDIDATE_CONFIRMATION_REQUIRED",
        "Confirm the exact reviewed integration candidate before starting."
      );
    }
    const cached = this.integrationCandidates.get(candidateId);
    if (cached?.repositoryId === repository.id
      && canonicalStringify(cached.options) !== canonicalStringify(requestedOptions)) {
      throw new WorktreeIntegrationJobError(
        "CANDIDATE_OPTIONS_MISMATCH",
        "The integration operation does not match the reviewed candidate.",
        409
      );
    }
    if (!cached && branchCandidateId(candidateId) && !requestedOptions.operationType) {
      throw new WorktreeIntegrationJobError(
        "CANDIDATE_OPTIONS_REQUIRED",
        "Include the reviewed branch operation when confirming this candidate.",
        409
      );
    }
    const options = requestedOptions;
    const built = await this.#buildPlan(repository, options, {
      forceFresh: true,
      reason: "integration_candidate_confirmation"
    });
    const expired = !cached || cached.expiresAtMs <= this.now();
    const candidateMismatch = cached?.repositoryId !== repository.id
      || cached?.candidate.planFingerprint !== candidateFingerprint
      || cached?.candidate.id !== candidateId;
    if (expired || candidateMismatch || built.planFingerprint !== candidateFingerprint) {
      const freshCandidate = this.#cacheCandidate(repository.id, options, built);
      throw new WorktreeIntegrationJobError(
        "PLAN_REFRESH_REQUIRED",
        "Worktree state changed or the reviewed candidate expired. Review the refreshed candidate before starting.",
        409,
        {
          candidate: freshCandidate,
          diff: deterministicPlanDiff(cached?.candidate.plan ?? null, built.plan)
        }
      );
    }
    if ((built.plan.blockingRisks ?? []).length > 0) {
      throw new WorktreeIntegrationJobError(
        "PREFLIGHT_RISKS_UNRESOLVED",
        "Resolve the blocking Worktree risks and generate a new candidate.",
        409
      );
    }
    validateCommitProtectionDecisionBindings(
      built.plan,
      commitProtectionDecisions,
      candidateFingerprint,
      { requireBindings: true }
    );
    const boundCommitProtectionDecisions = bindCommitProtectionDecisions(
      built.plan,
      commitProtectionDecisions,
      candidateFingerprint
    );
    assertCommitProtectionDecisions(built.plan, boundCommitProtectionDecisions);
    this.#assertNoActiveJob(repository.id);

    const now = new Date(this.now()).toISOString();
    const noWorkRequired = built.noWorkRequired;
    const jobInput = {
      repositoryId: repository.id,
      planFingerprint: built.planFingerprint,
      fingerprintVersion: PLAN_FINGERPRINT_VERSION,
      idempotencyKey,
      startRequestFingerprint,
      startRequestFingerprintVersion: START_REQUEST_FINGERPRINT_VERSION,
      status: noWorkRequired ? "completed" : "queued",
      phase: noWorkRequired ? "completed" : "queued",
      confirmedAt: now,
      completedAt: noWorkRequired ? now : null,
      details: {
        plan: built.plan,
        currentWorktreeId: null,
        progress: progressFor(built.plan.items),
        commitProtectionDecisions: boundCommitProtectionDecisions,
        audit: [{
          at: now,
          event: noWorkRequired ? "candidate_confirmed_no_changes" : "candidate_confirmed",
          planFingerprint: built.planFingerprint,
          idempotencyKey
        }]
      }
    };
    let job;
    try {
      job = this.store.createWorktreeIntegrationJobIdempotently
        ? this.store.createWorktreeIntegrationJobIdempotently(jobInput)
        : this.store.createWorktreeIntegrationJob(jobInput);
    } catch (error) {
      if (error?.code === "IDEMPOTENCY_KEY_REUSED") {
        throw new WorktreeIntegrationJobError(
          "IDEMPOTENCY_KEY_REUSED",
          "This idempotency key was already used for a different integration start request.",
          409
        );
      }
      if (error?.code === "INTEGRATION_JOB_ACTIVE" || /idx_worktree_integration_jobs_active/i.test(error?.message ?? "")) {
        throw new WorktreeIntegrationJobError(
          "INTEGRATION_JOB_ACTIVE",
          "Resolve or complete the existing Worktree integration task first.",
          409
        );
      }
      throw error;
    }
    this.integrationCandidates.delete(candidateId);
    if (!noWorkRequired) this.#schedule(job.id);
    return presentJob(job);
  }

  async #serializeCandidateStart(
    repositoryId,
    idempotencyKey,
    startRequestFingerprint,
    operation
  ) {
    const inFlight = this.repositoryStartOperations.get(repositoryId);
    if (inFlight) {
      if (inFlight.idempotencyKey === idempotencyKey
        && inFlight.startRequestFingerprint === startRequestFingerprint) {
        return inFlight.promise;
      }
      throw new WorktreeIntegrationJobError(
        "INTEGRATION_CONFIRMATION_IN_PROGRESS",
        "Another integration confirmation is being checked for this repository. Retry shortly.",
        409,
        { retryable: true }
      );
    }
    const promise = Promise.resolve().then(operation);
    this.repositoryStartOperations.set(repositoryId, {
      idempotencyKey,
      startRequestFingerprint,
      promise
    });
    try {
      return await promise;
    } finally {
      if (this.repositoryStartOperations.get(repositoryId)?.promise === promise) {
        this.repositoryStartOperations.delete(repositoryId);
      }
    }
  }

  #cacheCandidate(repositoryId, options, built) {
    const generatedAtMs = this.now();
    const candidate = {
      id: `integration_candidate:${options.operationType ?? "default"}:${randomUUID()}`,
      repositoryId,
      planFingerprint: built.planFingerprint,
      fingerprint: built.planFingerprint,
      fingerprintVersion: PLAN_FINGERPRINT_VERSION,
      operationType: options.operationType ?? null,
      sourceWorktreeIds: options.sourceWorktreeIds ?? [],
      targetWorktreeId: options.targetWorktreeId ?? null,
      generatedAt: new Date(generatedAtMs).toISOString(),
      expiresAt: new Date(generatedAtMs + this.candidateTtlMs).toISOString(),
      ttlMs: this.candidateTtlMs,
      plan: built.plan,
      progress: progressFor(built.plan.items),
      noWorkRequired: built.noWorkRequired
    };
    this.integrationCandidates.set(candidate.id, {
      repositoryId,
      options,
      candidate,
      expiresAtMs: generatedAtMs + this.candidateTtlMs
    });
    this.#pruneCandidates(generatedAtMs, candidate.id);
    return candidate;
  }

  #pruneCandidates(now, keepId) {
    for (const [id, entry] of this.integrationCandidates) {
      if (id !== keepId && entry.expiresAtMs <= now) this.integrationCandidates.delete(id);
    }
    const kept = this.integrationCandidates.get(keepId);
    if (kept) {
      const repositoryCandidateIds = [...this.integrationCandidates]
        .filter(([, entry]) => entry.repositoryId === kept.repositoryId)
        .map(([id]) => id);
      while (repositoryCandidateIds.length > MAX_CACHED_CANDIDATES_PER_REPOSITORY) {
        const oldest = repositoryCandidateIds.shift();
        if (oldest !== keepId) this.integrationCandidates.delete(oldest);
      }
    }
    while (this.integrationCandidates.size > MAX_CACHED_CANDIDATES) {
      const oldest = this.integrationCandidates.keys().next().value;
      if (oldest === keepId && this.integrationCandidates.size === 1) break;
      this.integrationCandidates.delete(oldest);
    }
  }

  #assertNoActiveJob(repositoryId, ignoreJobId = null, includeAwaitingConfirmation = false) {
    const activeStatuses = includeAwaitingConfirmation
      ? ["awaiting_confirmation", ...ACTIVE_JOB_STATUSES]
      : ACTIVE_JOB_STATUSES;
    const active = this.store.listWorktreeIntegrationJobs(repositoryId)
      .find((job) => job.id !== ignoreJobId && activeStatuses.includes(job.status));
    if (active) {
      throw new WorktreeIntegrationJobError(
        "INTEGRATION_JOB_ACTIVE",
        "Resolve or complete the existing Worktree integration task first.",
        409
      );
    }
  }

  async confirm(jobId, input = {}) {
    const job = this.#requireJob(jobId);
    if (job.status !== "awaiting_confirmation") {
      throw new WorktreeIntegrationJobError("JOB_NOT_CONFIRMABLE", "This task is not awaiting confirmation.", 409);
    }
    if (input.confirmed !== true || input.planFingerprint !== job.planFingerprint) {
      throw new WorktreeIntegrationJobError(
        "EXPLICIT_CONFIRMATION_REQUIRED",
        "Confirm the exact reviewed plan fingerprint before starting."
      );
    }
    if ((job.details.plan?.blockingRisks ?? []).length > 0) {
      throw new WorktreeIntegrationJobError(
        "PREFLIGHT_RISKS_UNRESOLVED",
        "Resolve the blocking Worktree risks and run preflight again.",
        409
      );
    }
    const commitProtectionDecisions = normalizeCommitProtectionDecisions(input.commitProtectionDecisions);
    validateCommitProtectionDecisionBindings(
      job.details.plan,
      commitProtectionDecisions,
      job.planFingerprint
    );
    const boundCommitProtectionDecisions = bindCommitProtectionDecisions(
      job.details.plan,
      commitProtectionDecisions,
      job.planFingerprint
    );
    assertCommitProtectionDecisions(job.details.plan, boundCommitProtectionDecisions);
    const current = this.#associate(await this.inspectRepository(job.repositoryId));
    const mismatch = planInspectionMismatch(job.details.plan, current);
    if (mismatch) {
      return presentJob(this.#update(job, {
        phase: "plan_stale",
        error: mismatch.message,
        auditEvent: "plan_validation_failed",
        auditData: { code: mismatch.code }
      }));
    }
    this.#assertNoActiveJob(job.repositoryId, job.id);
    let updated;
    try {
      updated = this.#update(job, {
        status: "queued",
        phase: "queued",
        confirmedAt: new Date().toISOString(),
        details: { ...job.details, commitProtectionDecisions: boundCommitProtectionDecisions },
        auditEvent: "plan_confirmed"
      });
    } catch (error) {
      if (/worktree_integration_jobs\.repository_id|idx_worktree_integration_jobs_active/i
        .test(error?.message ?? "")) {
        throw new WorktreeIntegrationJobError(
          "INTEGRATION_JOB_ACTIVE",
          "Resolve or complete the existing Worktree integration task first.",
          409
        );
      }
      throw error;
    }
    this.#schedule(updated.id);
    return presentJob(updated);
  }

  get(jobId) {
    return presentJob(this.#reconcileConflictResolution(this.#requireJob(jobId)));
  }

  reconcileConflictResolutionSession(sessionId) {
    const id = String(sessionId ?? "").trim();
    if (!id) return [];
    const matchingJobs = this.store.listGitRepositories().flatMap((repository) =>
      this.store.listWorktreeIntegrationJobs(repository.id)
    ).filter((job) => (
      ["paused", "queued", "running"].includes(job.status)
        && job.details?.conflictResolution?.sessionId === id
    ));
    return matchingJobs.map((job) => presentJob(this.#reconcileConflictResolution(job)));
  }

  async cancel(jobId, input = {}) {
    let job = this.#requireJob(jobId);
    const replan = input.replan === true || job.details.replanAfterCancel === true;
    if (job.status === "canceled") {
      return presentJob(await this.#replacementPlan(job, replan));
    }
    if (["cancellation_requested", "replanning"].includes(job.status)) {
      if (replan && job.details.replanAfterCancel !== true) {
        job = this.#update(job, {
          details: { ...job.details, replanAfterCancel: true },
          auditEvent: "replan_requested"
        });
      }
      return presentJob(job);
    }
    if (!["awaiting_confirmation", "queued", "running", "paused"].includes(job.status)) {
      throw new WorktreeIntegrationJobError(
        "JOB_NOT_CANCELABLE",
        "Only a review, queued, running, or paused integration task can be stopped.",
        409
      );
    }
    if (job.status === "running" || this.activeJobs.has(job.id)) {
      return presentJob(this.#update(job, {
        status: "cancellation_requested",
        phase: "stopping",
        error: null,
        details: { ...job.details, replanAfterCancel: replan },
        auditEvent: "cancellation_requested"
      }));
    }
    return presentJob(await this.#finishCancellation(job, { replan }));
  }

  async #finishCancellation(job, { replan = false, conflictPreserved = false } = {}) {
    const conflictItem = job.details.plan.items.find((candidate) =>
      candidate.worktreeId === job.details.currentWorktreeId);
    const shouldRestoreTaskOwnedConflict = conflictItem?.mergeStatus === "conflict";
    if (replan || shouldRestoreTaskOwnedConflict) {
      try {
        const cleanup = await this.#abortConflictMergeForReplan(job);
        if (cleanup) {
          job = this.#update(job, {
            auditEvent: cleanup.aborted ? "conflict_merge_aborted" : "conflict_merge_cleanup_verified",
            auditData: { worktreeId: job.details.currentWorktreeId }
          });
          conflictPreserved = false;
        }
      } catch (error) {
        return this.#update(job, {
          status: "paused",
          phase: replan ? "replanning_cleanup_failed" : "cancellation_cleanup_failed",
          error: error.message,
          auditEvent: "conflict_merge_cleanup_failed",
          auditData: { code: error.code ?? "MERGE_CLEANUP_FAILED" }
        });
      }
    }
    const finalPhase = conflictPreserved ? "canceled_conflict_preserved" : "canceled";
    let canceled = this.#update(job, {
      status: replan ? "replanning" : "canceled",
      phase: replan ? "replanning" : finalPhase,
      error: conflictPreserved
        ? "The remaining steps were stopped. The merge conflict was preserved for review."
        : null,
      currentWorktreeId: null,
      completedAt: new Date().toISOString(),
      details: { ...job.details, replanAfterCancel: replan },
      auditEvent: "execution_canceled",
      auditData: conflictPreserved ? { code: "CONFLICT_PRESERVED" } : undefined
    });
    if (!replan) return canceled;
    let replacement;
    try {
      replacement = await this.#replacementPlan(canceled, true);
    } catch (error) {
      return this.#update(this.#requireJob(canceled.id), {
        status: "paused",
        phase: "replanning_failed",
        error: error.message,
        completedAt: null,
        auditEvent: "replacement_preflight_failed",
        auditData: { code: error.code ?? "PREFLIGHT_FAILED" }
      });
    }
    canceled = this.#update(this.#requireJob(canceled.id), {
      status: "canceled",
      phase: finalPhase,
      completedAt: new Date().toISOString(),
      auditEvent: "replacement_preflight_ready",
      auditData: { replacementJobId: replacement.id }
    });
    return replacement ?? canceled;
  }

  async #abortConflictMergeForReplan(job) {
    const item = job.details.plan.items.find((candidate) =>
      candidate.worktreeId === job.details.currentWorktreeId);
    if (item?.mergeStatus !== "conflict") return null;
    const sourceHead = item.commitHead ?? item.sourceHeadBefore;
    return this.abortMerge({
      repositoryId: job.repositoryId,
      mainPath: job.details.plan.executionPath ?? job.details.plan.mainPath,
      sourceHead,
      expectedMainHead: expectedMainHeadBefore(job.details.plan, item.worktreeId),
      jobId: job.id
    });
  }

  async #replacementPlan(canceled, replan) {
    if (!replan) return canceled;
    if (canceled.details.replacementJobId) {
      return this.store.getWorktreeIntegrationJob(canceled.details.replacementJobId) ?? canceled;
    }
    let replacement;
    try {
      const priorPlan = canceled.details.plan ?? {};
      const operationType = priorPlan.operationType === "merge" ? "batch_merge"
        : priorPlan.operationType === "sync" ? "one_way_sync"
          : priorPlan.operationType === "converge" ? "converge" : null;
      replacement = await this.preflight(canceled.repositoryId, {
        ignoreJobId: canceled.id,
        ...(operationType ? {
          operationType,
          sourceWorktreeIds: priorPlan.operationType === "converge"
            ? [priorPlan.targetWorktreeId, ...(priorPlan.sourceWorktreeIds ?? [])]
            : priorPlan.sourceWorktreeIds,
          targetWorktreeId: priorPlan.targetWorktreeId
        } : {})
      });
    } catch (error) {
      if (error.code !== "INTEGRATION_JOB_ACTIVE") throw error;
      replacement = this.store.listWorktreeIntegrationJobs(canceled.repositoryId)
        .find((candidate) => candidate.id !== canceled.id
          && ["awaiting_confirmation", "queued", "running", "paused"].includes(candidate.status));
      if (!replacement) throw error;
    }
    this.#update(canceled, {
      details: { ...canceled.details, replacementJobId: replacement.id },
      auditEvent: "replacement_preflight_created",
      auditData: { replacementJobId: replacement.id }
    });
    return replacement;
  }

  retry(jobId) {
    const job = this.#reconcileConflictResolution(this.#requireJob(jobId));
    if (job.status !== "paused") {
      throw new WorktreeIntegrationJobError("JOB_NOT_PAUSED", "Only a paused task can be retried.", 409);
    }
    if (job.details.conflictResolution?.status === "running") {
      throw new WorktreeIntegrationJobError(
        "CONFLICT_AGENT_RUNNING",
        "Wait for the conflict-resolution Agent to finish before retrying.",
        409
      );
    }
    const updated = this.#update(job, {
      status: "queued", phase: "retry_queued", error: null, auditEvent: "retry_requested"
    });
    this.#schedule(updated.id);
    return presentJob(updated);
  }

  async resolveConflictWithAgent(jobId) {
    const key = String(jobId);
    const active = this.activeConflictResolutions.get(key);
    if (active) return active;
    const operation = this.#resolveConflictWithAgent(key);
    this.activeConflictResolutions.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.activeConflictResolutions.get(key) === operation) {
        this.activeConflictResolutions.delete(key);
      }
    }
  }

  async #resolveConflictWithAgent(key) {
    let failureStage = "conflict_preflight";
    let retryCount = 0;
    try {
      let job = this.#requireJob(key);
      const item = job.details.plan.items.find((candidate) => candidate.worktreeId === job.details.currentWorktreeId);
      if (job.status !== "paused"
        || !["conflict", "conflict_resolution_preparing"].includes(job.phase)
        || item?.mergeStatus !== "conflict") {
        throw new WorktreeIntegrationJobError(
          "MERGE_CONFLICT_REQUIRED",
          "This integration task does not have an Agent-resolvable merge conflict.",
          409
        );
      }
      const previousAutomation = job.details.conflictAutomation;
      if (previousAutomation?.status !== "running") {
        job = this.#update(job, {
          details: {
            ...job.details,
            conflictAutomation: {
              ...previousAutomation,
              status: "running",
              scopeWorktreeIds: previousAutomation?.scopeWorktreeIds ?? [...job.details.plan.mergeOrder],
              completedWorktreeIds: completedMergeWorktreeIds(job.details.plan.items),
              currentWorktreeId: item.worktreeId,
              blockedWorktreeId: null,
              conflictFiles: [...(item.conflictFiles ?? [])],
              failureCode: null,
              failureReason: null,
              startedAt: previousAutomation?.startedAt ?? new Date().toISOString()
            }
          },
          auditEvent: previousAutomation?.status === "blocked"
            ? "conflict_automation_retried"
            : "conflict_automation_started",
          auditData: { worktreeId: item.worktreeId }
        });
      }
      const sourceHead = item.commitHead ?? item.sourceHeadBefore;
      const expectedMainHead = expectedMainHeadBefore(job.details.plan, item.worktreeId);
      const conflictKey = conflictResolutionKey(job, item, sourceHead, expectedMainHead);
      let resolution = job.details.conflictResolution;
      if (resolution && !conflictResolutionMatches(job, resolution, item, conflictKey)) {
        job = this.#update(job, {
          details: withoutConflictResolution(job.details),
          auditEvent: "stale_conflict_resolution_cleared",
          auditData: { worktreeId: item.worktreeId }
        });
        resolution = null;
      }
      if (resolution?.status === "failed") {
        job = this.#update(job, {
          details: withoutConflictResolution(job.details),
          auditEvent: "failed_conflict_resolution_cleared",
          auditData: { worktreeId: item.worktreeId }
        });
        resolution = null;
      }
      if (resolution?.sessionId) return presentJob(job);

      let workspace = resolution?.workspace ?? null;
      if (!workspace) {
        failureStage = "workspace_creation";
        let preparation;
        for (let attempt = 0; attempt < this.maxConflictFallbackAttempts; attempt += 1) {
          retryCount = attempt;
          try {
            preparation = await this.prepareConflictResolution({
              repositoryId: job.repositoryId,
              mainPath: job.details.plan.executionPath ?? job.details.plan.mainPath,
              jobId: job.id,
              sourceHead,
              expectedMainHead,
              conflictFiles: item.conflictFiles
            });
            break;
          } catch (error) {
            if (!isRecoverableConflictFallbackError(error)) throw error;
            if (attempt + 1 >= this.maxConflictFallbackAttempts) {
              throw conflictFallbackFailure(error, failureStage, attempt + 1);
            }
            job = this.#update(job, {
              auditEvent: "conflict_fallback_retry",
              auditData: {
                failureStage,
                retryCount: attempt + 1,
                code: error.code ?? "CONFLICT_WORKSPACE_PREPARE_FAILED"
              }
            });
          }
        }
        if (preparation.alreadyResolved) {
          job = this.#item(job, item.worktreeId, {
            mergeStatus: "recovered",
            mergeMainHead: preparation.mainHead,
            conflictFiles: [],
            error: null
          }, "conflict_resolution_ready", "merge_recovered_externally");
          const resumed = this.#update(job, {
            status: "queued",
            phase: "retry_queued",
            error: null,
            auditEvent: "external_conflict_resolution_detected"
          });
          this.#schedule(resumed.id);
          return presentJob(resumed);
        }
        if (preparation.readyForRetry) {
          const resumed = this.#update(job, {
            status: "queued",
            phase: "retry_queued",
            error: null,
            auditEvent: "resolved_merge_ready_for_retry"
          });
          this.#schedule(resumed.id);
          return presentJob(resumed);
        }
        workspace = preparation;
        job = this.#update(job, {
          phase: "conflict_resolution_preparing",
          details: {
            ...job.details,
            conflictResolution: {
              status: "preparing",
              worktreeId: item.worktreeId,
              conflictKey,
              workspace
            }
          },
          auditEvent: "conflict_workspace_created",
          auditData: {
            worktreeId: workspace.worktreeId,
            branchName: workspace.branchName,
            worktreePath: workspace.path,
            retryCount: retryCount + Number(workspace.retryCount ?? 0)
          }
        });
      }

      failureStage = "session_creation";
      let created;
      for (let attempt = 0; attempt < this.maxConflictFallbackAttempts; attempt += 1) {
        retryCount = attempt;
        try {
          created = await this.launchConflictResolution({
            job: presentJob(job),
            item,
            workspace,
            sourceHead,
            expectedMainHead: workspace.headOid ?? expectedMainHead
          });
          break;
        } catch (error) {
          if (!isRecoverableConflictFallbackError(error)) throw error;
          if (attempt + 1 >= this.maxConflictFallbackAttempts) {
            throw conflictFallbackFailure(error, failureStage, attempt + 1);
          }
          job = this.#update(job, {
            auditEvent: "conflict_fallback_retry",
            auditData: {
              failureStage,
              retryCount: attempt + 1,
              code: error.code ?? "CONFLICT_SESSION_CREATE_FAILED",
              branchName: workspace.branchName,
              worktreePath: workspace.path
            }
          });
        }
      }
      return presentJob(this.#update(job, {
        status: "paused",
        phase: "conflict_resolution_running",
        error: null,
        details: {
          ...job.details,
          conflictAutomation: {
            ...job.details.conflictAutomation,
            taskId: created.taskId,
            sessionId: created.sessionId,
            sessionName: created.sessionName ?? null,
            agentId: created.agentId,
            agentName: created.agentName,
            workspaceId: workspace.worktreeId,
            workspacePath: workspace.path
          },
          conflictResolution: {
            status: "running",
            worktreeId: item.worktreeId,
            conflictKey,
            workspace,
            taskId: created.taskId,
            sessionId: created.sessionId,
            sessionName: created.sessionName ?? null,
            agentId: created.agentId,
            agentName: created.agentName,
            retryCount
          }
        },
        auditEvent: "conflict_agent_started",
        auditData: {
          worktreeId: workspace.worktreeId,
          sessionName: created.sessionName ?? null,
          branchName: workspace.branchName,
          worktreePath: workspace.path,
          retryCount,
          failureStage: null,
          reusedPlanSession: created.reused === true
        }
      }));
    } catch (error) {
      const job = this.store.getWorktreeIntegrationJob(key);
      if (job) {
        const item = job.details.plan.items.find((candidate) => candidate.worktreeId === job.details.currentWorktreeId);
        const existingResolution = job.details.conflictResolution;
        this.#update(job, {
          status: "paused",
          phase: "conflict",
          error: error.message,
          details: {
            ...job.details,
            ...(existingResolution?.workspace && !existingResolution.sessionId ? {
              conflictResolution: { ...existingResolution, status: "failed" }
            } : {}),
            conflictAutomation: blockedConflictAutomation(job, item, error)
          },
          auditEvent: "conflict_agent_failed",
          auditData: {
            code: error.code ?? "CONFLICT_AGENT_FAILED",
            failureStage: error.failureStage ?? failureStage,
            retryCount: error.retryCount ?? retryCount,
            sessionName: existingResolution?.sessionName ?? null,
            branchName: item?.branchName ?? null,
            worktreePath: item?.path ?? null
          }
        });
      }
      throw error;
    }
  }

  async recover() {
    const jobs = this.store.listRecoverableWorktreeIntegrationJobs();
    for (const job of jobs) {
      if (["cancellation_requested", "replanning"].includes(job.status)) {
        await this.#finishCancellation(job, { replan: job.details.replanAfterCancel === true });
        continue;
      }
      if (job.status === "paused" && job.details.conflictAutomation?.status === "running") {
        const reconciled = this.#reconcileConflictResolution(job);
        if (reconciled.status === "paused"
          && ["conflict", "conflict_resolution_preparing"].includes(reconciled.phase)) {
          this.#scheduleAutomaticConflictResolution(reconciled.id);
        }
        continue;
      }
      this.#update(job, { status: "queued", phase: "recovery_queued", auditEvent: "backend_recovered" });
      this.#schedule(job.id);
    }
    return jobs.length;
  }

  #schedule(jobId) {
    setImmediate(() => this.#run(jobId).catch((error) => {
      const job = this.store.getWorktreeIntegrationJob(jobId);
      if (job && !["paused", "completed", "canceled", "cancellation_requested"].includes(job.status)) {
        this.#pause(job, error);
      }
    }));
  }

  async #run(jobId) {
    if (this.activeJobs.has(jobId)) return;
    this.activeJobs.add(jobId);
    try {
      let job = this.#requireJob(jobId);
      if (job.status === "cancellation_requested") {
        await this.#finishCancellation(job, { replan: job.details.replanAfterCancel === true });
        return;
      }
      if (!['queued', 'running'].includes(job.status)) return;
      job = this.#update(job, { status: "running", phase: "validating", auditEvent: "execution_started" });
      let items = job.details.plan.items;
      const completedAny = items.some((item) => ["completed", "recovered"].includes(item.commitStatus)
        || ["completed", "already_integrated", "recovered"].includes(item.mergeStatus))
        || job.details.conflictResolution?.status === "ready"
        || job.details.convergenceWorkspace != null;
      if (!completedAny) {
        const current = await this.inspectRepository(job.repositoryId, {
          forceFresh: true,
          reason: "integration_execution_validation"
        });
        const mismatch = planInspectionMismatch(job.details.plan, current);
        if (mismatch) {
          throw new WorktreeIntegrationJobError(
            mismatch.code, mismatch.message, 409
          );
        }
      }

      for (const item of items) {
        if (item.commitStatus === "not_needed" || ["completed", "recovered"].includes(item.commitStatus)) continue;
        if (await this.#stopIfRequested(jobId)) return;
        await this.#assertWorktreeIdle(job.repositoryId, item.worktreeId);
        job = this.#item(job, item.worktreeId, { commitStatus: "running", error: null }, "committing", "commit_started");
        let result;
        let commitInputItem = item;
        for (let attempt = 0; attempt < this.maxConflictFallbackAttempts; attempt += 1) {
          await this.#assertCommitProtectionBinding(job, commitInputItem);
          try {
            result = await this.commitChanges({
              path: commitInputItem.path,
              expectedHead: commitInputItem.sourceHeadBefore,
              expectedStatusSummary: commitInputItem.statusSummary,
              commitMessage: commitInputItem.commitMessage,
              protectionDecision: job.details.commitProtectionDecisions?.[item.worktreeId]?.decision ?? null,
              neverRemindPrivateFiles: job.details.commitProtectionDecisions?.[item.worktreeId]?.neverRemind === true,
              jobId
            });
            break;
          } catch (error) {
            if (!isRecoverableConflictFallbackError(error) || attempt + 1 >= this.maxConflictFallbackAttempts) {
              throw conflictFallbackFailure(error, "worktree_commit", attempt + 1);
            }
            const refreshed = await this.#refreshWorktreeItem(job, item.worktreeId);
            job = refreshed.job;
            commitInputItem = refreshed.item;
            job = this.#update(job, {
              auditEvent: "integration_stage_retry",
              auditData: {
                failureStage: "worktree_commit",
                retryCount: attempt + 1,
                code: error.code ?? "WORKTREE_COMMIT_FAILED",
                branchName: commitInputItem.branchName,
                worktreePath: commitInputItem.path
              }
            });
          }
        }
        job = this.#item(job, item.worktreeId, {
          commitStatus: result.recovered ? "recovered" : (result.committed ? "completed" : "not_needed"),
          commitHead: result.headOid,
          error: null
        }, "committing", "commit_completed");
        items = job.details.plan.items;
        if (await this.#stopIfRequested(jobId)) return;
      }

      if (job.details.plan.operationType === "sync") {
        if (typeof this.rebaseSource !== "function") {
          throw new WorktreeIntegrationJobError("SYNC_UNSUPPORTED", "This backend cannot synchronize Worktrees yet.", 501);
        }
        const targetHead = job.details.plan.mainHeadBefore;
        for (let item of items) {
          if (item.isMain || ["completed", "already_integrated", "recovered"].includes(item.mergeStatus)) continue;
          if (await this.#stopIfRequested(jobId)) return;
          const refreshed = await this.#refreshWorktreeItem(job, item.worktreeId, { requireClean: true });
          job = refreshed.job;
          item = refreshed.item;
          job = this.#item(job, item.worktreeId, { mergeStatus: "running", error: null }, "rebasing", "rebase_started");
          try {
            const result = await this.rebaseSource({
              path: item.path,
              targetHead,
              expectedSourceHead: item.commitHead ?? item.sourceHeadBefore,
              jobId
            });
            job = this.#item(job, item.worktreeId, {
              mergeStatus: result.alreadySynchronized ? "already_integrated" : "completed",
              mergeMainHead: result.headOid,
              conflictFiles: [],
              error: null
            }, "rebasing", "rebase_completed");
          } catch (error) {
            job = this.#item(job, item.worktreeId, {
              mergeStatus: error.code === "REBASE_CONFLICT" ? "conflict" : "failed",
              conflictFiles: error.conflictFiles ?? [],
              error: error.message
            }, "paused", "rebase_paused");
            this.#pause(job, error);
            return;
          }
          items = job.details.plan.items;
        }
      }

      if (job.details.plan.operationType === "converge") {
        if (typeof this.prepareConvergence !== "function") {
          throw new WorktreeIntegrationJobError("CONVERGENCE_UNSUPPORTED", "This backend cannot prepare an isolated convergence Worktree yet.", 501);
        }
        let workspace = job.details.convergenceWorkspace;
        if (!workspace) {
          workspace = await this.prepareConvergence({
            repositoryId: job.repositoryId,
            workingDirectory: job.details.plan.mainPath,
            baseHead: job.details.plan.mainHeadBefore,
            jobId
          });
          job = this.#update(job, {
            phase: "preparing_convergence",
            details: {
              ...job.details,
              convergenceWorkspace: workspace,
              plan: { ...job.details.plan, executionPath: workspace.path }
            },
            auditEvent: "convergence_workspace_prepared"
          });
        }
      }

      let expectedMainHead = items.find((item) => item.isMain)?.commitHead
        ?? job.details.plan.mainHeadBefore;
      for (let item of job.details.plan.operationType === "sync" ? [] : items) {
        if (item.isMain || item.mergeStatus === "not_needed"
          || ["completed", "already_integrated", "recovered"].includes(item.mergeStatus)) {
          if (item.mergeMainHead) expectedMainHead = item.mergeMainHead;
          continue;
        }
        if (await this.#stopIfRequested(jobId)) return;
        const refreshed = await this.#refreshWorktreeItem(job, item.worktreeId, { requireClean: true });
        job = refreshed.job;
        item = refreshed.item;
        items = job.details.plan.items;
        let sourceHead = item.resolutionHead ?? item.commitHead ?? item.sourceHeadBefore;
        const resolution = job.details.conflictResolution;
        const originalSourceHead = item.commitHead ?? item.sourceHeadBefore;
        const expectedResolutionMainHead = expectedMainHeadBefore(job.details.plan, item.worktreeId);
        const expectedConflictKey = conflictResolutionKey(
          job, item, originalSourceHead, expectedResolutionMainHead
        );
        if (!item.resolutionHead
          && resolution?.status === "ready"
          && resolution.worktreeId === item.worktreeId
          && resolution.conflictKey === expectedConflictKey) {
          const verified = await this.inspectConflictResolution({
            repositoryId: job.repositoryId,
            mainPath: job.details.plan.executionPath ?? job.details.plan.mainPath,
            workspace: resolution.workspace,
            sourceHead: originalSourceHead,
            expectedMainHead: expectedResolutionMainHead
          });
          sourceHead = verified.resolvedHead;
          job = this.#item(job, item.worktreeId, {
            resolutionHead: verified.resolvedHead,
            conflictFiles: [],
            error: null
          }, "validating_resolution", "conflict_resolution_verified", {
            auditData: {
              sessionName: resolution.sessionName ?? null,
              branchName: resolution.workspace.branchName,
              worktreePath: resolution.workspace.path,
              retryCount: resolution.retryCount ?? 0,
              failureStage: "completed"
            }
          });
        }
        await this.#assertWorktreeIdle(job.repositoryId, item.worktreeId);
        job = this.#item(
          job,
          item.worktreeId,
          { mergeStatus: "running", error: null },
          "merging",
          "merge_started",
          { clearConflictResolution: true }
        );
        try {
          let result;
          for (let attempt = 0; attempt < this.maxConflictFallbackAttempts; attempt += 1) {
            try {
              result = await this.mergeSource({
                mainPath: job.details.plan.executionPath ?? job.details.plan.mainPath,
                sourceHead,
                expectedMainHead,
                jobId
              });
              break;
            } catch (error) {
              if (error.code === "MERGE_CONFLICT") throw error;
              if (!isRecoverableConflictFallbackError(error) || attempt + 1 >= this.maxConflictFallbackAttempts) {
                throw conflictFallbackFailure(error, "merge_source", attempt + 1);
              }
              const inspection = await this.inspectRepository(job.repositoryId);
              const main = inspection.worktrees.find((candidate) =>
                candidate.worktreeId === (job.details.plan.targetWorktreeId ?? job.details.plan.mainWorktreeId)
              );
              if (main?.availability === "available" && main.dirty !== true && !main.operationState) {
                expectedMainHead = main.headOid;
              }
              job = this.#update(job, {
                auditEvent: "integration_stage_retry",
                auditData: {
                  failureStage: "merge_source",
                  retryCount: attempt + 1,
                  code: error.code ?? "MERGE_FAILED",
                  branchName: item.branchName,
                  worktreePath: item.path
                }
              });
            }
          }
          expectedMainHead = result.mainHead;
          job = this.#item(job, item.worktreeId, {
            mergeStatus: result.alreadyMerged ? "already_integrated" : (result.recovered ? "recovered" : "completed"),
            mergeMainHead: result.mainHead,
            conflictFiles: [],
            error: null
          }, "merging", "merge_completed");
        } catch (error) {
          job = this.#item(job, item.worktreeId, {
            mergeStatus: error.code === "MERGE_CONFLICT" ? "conflict" : "failed",
            conflictFiles: error.conflictFiles ?? [],
            error: error.message
          }, "paused", "merge_paused");
          const latest = this.#requireJob(jobId);
          if (latest.status === "cancellation_requested") {
            await this.#finishCancellation(latest, {
              replan: latest.details.replanAfterCancel === true,
              conflictPreserved: error.code === "MERGE_CONFLICT"
            });
            return;
          }
          const paused = this.#pause(job, error);
          if (error.code === "MERGE_CONFLICT"
            && paused.details.conflictAutomation?.status === "running") {
            this.#scheduleAutomaticConflictResolution(paused.id);
          }
          return;
        }
        items = job.details.plan.items;
        if (await this.#stopIfRequested(jobId)) return;
      }
      if (job.details.plan.operationType === "converge") {
        if (typeof this.fastForwardSource !== "function") {
          throw new WorktreeIntegrationJobError("CONVERGENCE_UNSUPPORTED", "This backend cannot converge Worktrees yet.", 501);
        }
        const resultHead = expectedMainHead;
        items = job.details.plan.items;
        for (let item of items) {
          if (item.convergenceStatus === "completed") continue;
          if (await this.#stopIfRequested(jobId)) return;
          job = this.#item(job, item.worktreeId, { convergenceStatus: "running", error: null }, "fast_forwarding", "convergence_started");
          try {
            await this.fastForwardSource({
              path: item.path,
              targetHead: resultHead,
              expectedSourceHead: item.commitHead ?? item.sourceHeadBefore,
              jobId
            });
            job = this.#item(job, item.worktreeId, {
              convergenceStatus: "completed",
              mergeMainHead: resultHead,
              error: null
            }, "fast_forwarding", "convergence_completed");
          } catch (error) {
            job = this.#item(job, item.worktreeId, {
              convergenceStatus: "failed",
              error: error.message
            }, "partial_completed", "convergence_partial");
            this.#pause(job, error);
            return;
          }
        }
        if (typeof this.cleanupConvergence === "function" && job.details.convergenceWorkspace) {
          await this.cleanupConvergence({
            repositoryId: job.repositoryId,
            workingDirectory: job.details.plan.mainPath,
            workspace: job.details.convergenceWorkspace,
            expectedHead: resultHead,
            jobId
          });
          job = this.#update(job, {
            details: { ...job.details, convergenceWorkspace: null },
            auditEvent: "convergence_workspace_cleaned"
          });
        }
      }
      this.#update(job, {
        status: "completed",
        phase: "completed",
        completedAt: new Date().toISOString(),
        error: null,
        currentWorktreeId: null,
        details: job.details.conflictAutomation ? {
          ...job.details,
          conflictAutomation: {
            ...job.details.conflictAutomation,
            status: "completed",
            completedWorktreeIds: completedMergeWorktreeIds(job.details.plan.items),
            currentWorktreeId: null,
            blockedWorktreeId: null,
            conflictFiles: [],
            failureCode: null,
            failureReason: null,
            completedAt: new Date().toISOString()
          }
        } : job.details,
        auditEvent: "execution_completed"
      });
    } catch (error) {
      const job = this.store.getWorktreeIntegrationJob(jobId);
      if (job?.status === "cancellation_requested") {
        await this.#finishCancellation(job, { replan: job.details.replanAfterCancel === true });
      } else if (job) {
        this.#pause(job, error);
      }
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  async #stopIfRequested(jobId) {
    const latest = this.#requireJob(jobId);
    if (latest.status !== "cancellation_requested") return false;
    await this.#finishCancellation(latest, { replan: latest.details.replanAfterCancel === true });
    return true;
  }

  async #assertCommitProtectionBinding(job, item) {
    const decision = job.details.commitProtectionDecisions?.[item.worktreeId];
    if (!decision?.protectedPathsDigest) return;
    const current = await this.inspectCommitProtection(item.path);
    if (protectedPathsDigest(current) === decision.protectedPathsDigest
      && decision.candidateFingerprint === job.planFingerprint) return;
    throw new WorktreeIntegrationJobError(
      "PLAN_STALE",
      `Protected files changed in ${item.branchName ?? item.path} after confirmation. Generate and review a fresh candidate.`,
      409
    );
  }

  async #assertWorktreeIdle(repositoryId, worktreeId) {
    const inspection = this.#associate(await this.inspectRepository(repositoryId));
    const worktree = inspection.worktrees.find((candidate) => candidate.worktreeId === worktreeId);
    const activeSessions = (worktree?.associations ?? []).filter((association) => association.active === true);
    if (activeSessions.length === 0) return;
    throw new WorktreeIntegrationJobError(
      "ACTIVE_SESSION_IN_PROGRESS",
      `Stop the active Session before integrating ${worktree.branchName ?? worktree.path}.`,
      409
    );
  }

  async #refreshWorktreeItem(job, worktreeId, { requireClean = false } = {}) {
    const inspection = this.#associate(await this.inspectRepository(job.repositoryId));
    const current = inspection.worktrees.find((candidate) => candidate.worktreeId === worktreeId);
    const recorded = job.details.plan.items.find((candidate) => candidate.worktreeId === worktreeId);
    if (!current || current.availability !== "available" || current.path !== recorded?.path
      || current.branchName !== recorded?.branchName || current.operationState
      || (current.conflictFiles ?? []).length > 0) {
      const error = new WorktreeIntegrationJobError(
        "WORKTREE_RECHECK_UNSAFE",
        `Could not safely refresh ${recorded?.branchName ?? worktreeId}; its identity or Git operation changed. All existing data was preserved.`,
        409
      );
      error.recoverable = false;
      throw error;
    }
    if (requireClean && current.dirty === true) {
      const error = new WorktreeIntegrationJobError(
        "WORKTREE_RECHECK_DIRTY",
        `${recorded?.branchName ?? worktreeId} gained uncommitted changes while integration was running. The changes were preserved; commit them or generate a fresh plan before retrying.`,
        409
      );
      error.recoverable = false;
      throw error;
    }
    const nextStatusSummary = current.statusSummary ?? "";
    if (current.headOid === recorded.sourceHeadBefore
      && nextStatusSummary === recorded.statusSummary
      && (current.dirty === true) === (recorded.dirty === true)) {
      return { job, item: recorded };
    }
    const items = job.details.plan.items.map((item) => item.worktreeId === worktreeId ? {
      ...item,
      sourceHeadBefore: current.headOid,
      statusSummary: nextStatusSummary,
      changedFiles: current.changedFiles ?? [],
      dirty: current.dirty === true
    } : item);
    const updated = this.#update(job, {
      details: { ...job.details, plan: { ...job.details.plan, items } },
      auditEvent: "worktree_state_refreshed",
      auditData: { worktreeId, branchName: current.branchName, worktreePath: current.path }
    });
    return {
      job: updated,
      item: updated.details.plan.items.find((candidate) => candidate.worktreeId === worktreeId)
    };
  }

  #pause(job, error) {
    const currentItem = job.details.plan.items.find((item) => item.worktreeId === job.details.currentWorktreeId);
    const automation = job.details.conflictAutomation;
    const shouldBlockAutomation = automation?.status === "running" && error.code !== "MERGE_CONFLICT";
    const updated = this.#update(job, {
      status: "paused",
      phase: error.code === "MERGE_CONFLICT" ? "conflict" : "failed",
      error: error.message,
      details: automation ? {
        ...job.details,
        conflictAutomation: shouldBlockAutomation
          ? blockedConflictAutomation(job, currentItem, error)
          : {
              ...automation,
              currentWorktreeId: currentItem?.worktreeId ?? null,
              completedWorktreeIds: completedMergeWorktreeIds(job.details.plan.items),
              conflictFiles: [...(currentItem?.conflictFiles ?? [])]
            }
      } : job.details,
      auditEvent: "execution_paused",
      auditData: { code: error.code ?? "INTEGRATION_FAILED" }
    });
    this.onEvent("WorktreeIntegrationJobPaused", { job: presentJob(updated) });
    return updated;
  }

  #scheduleAutomaticConflictResolution(jobId) {
    setImmediate(() => this.resolveConflictWithAgent(jobId).catch(() => {
      // #resolveConflictWithAgent persists a concrete blocked state. The UI
      // obtains it through the existing job endpoint without an unhandled task.
    }));
  }

  #item(job, worktreeId, patch, phase, event, { clearConflictResolution = false, auditData = {} } = {}) {
    const latest = this.store.getWorktreeIntegrationJob(job.id) ?? job;
    const items = latest.details.plan.items.map((item) => item.worktreeId === worktreeId ? { ...item, ...patch } : item);
    const details = clearConflictResolution
      ? withoutConflictResolution(latest.details)
      : latest.details;
    return this.#update(latest, {
      phase,
      details: { ...details, plan: { ...details.plan, items }, progress: progressFor(items) },
      currentWorktreeId: worktreeId,
      auditEvent: event,
      auditData: { worktreeId, ...auditData }
    });
  }

  #update(job, patch) {
    const at = new Date().toISOString();
    const stored = this.store.getWorktreeIntegrationJob(job.id) ?? job;
    let details = patch.details ?? stored.details;
    if (Object.prototype.hasOwnProperty.call(patch, "currentWorktreeId")) {
      details = { ...details, currentWorktreeId: patch.currentWorktreeId };
    }
    if (patch.auditEvent) {
      details = {
        ...details,
        audit: [...(details.audit ?? []), { at, event: patch.auditEvent, ...(patch.auditData ?? {}) }]
      };
    }
    const updated = this.store.updateWorktreeIntegrationJob(job.id, { ...patch, details });
    this.onEvent("WorktreeIntegrationJobChanged", { job: presentJob(updated) });
    return updated;
  }

  #reconcileConflictResolution(job) {
    const resolution = job.details.conflictResolution;
    const item = job.details.plan.items.find((candidate) => candidate.worktreeId === job.details.currentWorktreeId);
    const sourceHead = item ? (item.commitHead ?? item.sourceHeadBefore) : null;
    const expectedMainHead = item ? expectedMainHeadBefore(job.details.plan, item.worktreeId) : null;
    const conflictKey = item ? conflictResolutionKey(job, item, sourceHead, expectedMainHead) : null;
    if (resolution && !conflictResolutionMatches(job, resolution, item, conflictKey)) {
      return this.#update(job, {
        details: withoutConflictResolution(job.details),
        auditEvent: "stale_conflict_resolution_cleared",
        auditData: { worktreeId: job.details.currentWorktreeId }
      });
    }
    if (!["running", "failed"].includes(resolution?.status) || !resolution.sessionId) return job;
    const session = this.store.getSession(resolution.sessionId);
    if (!session) return job;
    const nextStatus = session.status === "complete"
      ? "ready"
      : (["failed", "cancelled"].includes(session.status) ? "failed" : "running");
    if (nextStatus === resolution.status) return job;
    const updated = this.#update(job, {
      status: nextStatus === "ready" ? "queued" : "paused",
      phase: nextStatus === "ready" ? "conflict_resolution_resume_queued" : "conflict",
      error: nextStatus === "failed" ? "The conflict-resolution Agent stopped before completing." : null,
      details: {
        ...job.details,
        conflictResolution: { ...resolution, status: nextStatus, sessionStatus: session.status },
        ...(nextStatus === "failed" && job.details.conflictAutomation ? {
          conflictAutomation: blockedConflictAutomation(
            job,
            item,
            Object.assign(new Error("The conflict-resolution Agent stopped before completing."), {
              code: "CONFLICT_AGENT_STOPPED"
            })
          )
        } : {})
      },
      auditEvent: nextStatus === "ready" ? "conflict_agent_completed" : "conflict_agent_stopped",
      auditData: {
        worktreeId: job.details.currentWorktreeId,
        ...(nextStatus === "ready" ? { automaticResume: true } : {})
      }
    });
    if (nextStatus === "ready") this.#schedule(updated.id);
    return updated;
  }

  #associate(inspection) {
    return {
      ...inspection,
      worktrees: inspection.worktrees.map((worktree) => this.#deletionState(worktree).worktree)
    };
  }

  async #gitHubPushStatus(worktree) {
    if (worktree.availability !== "available") {
      return {
        available: false,
        pending: false,
        dirty: false,
        unpushedCommitCount: 0,
        branch: worktree.branchName ?? null,
        destinationUrl: null,
        error: "This Worktree is unavailable and cannot be pushed."
      };
    }
    if (typeof this.inspectGitHubPushStatus !== "function") return null;
    return this.inspectGitHubPushStatus({ workingDirectory: worktree.path });
  }

  #deletionState(inspectedWorktree) {
    const associationState = this.#associationState(inspectedWorktree);
    const worktree = { ...inspectedWorktree, associations: associationState.associations };
    const blocker = worktreeDeletionBlocker(worktree);
    return {
      worktree: { ...worktree, deletionBlocker: blocker },
      blocker,
      releasableLogicalSessionIds: associationState.releasableLogicalSessionIds
    };
  }

  #associationState(worktree) {
    const releasableLogicalSessionIds = [];
    const associations = (worktree.sessions ?? []).map((association) => {
      const session = association.sessionId ? this.store.getSession(association.sessionId) : null;
      const logical = association.logicalSessionId && this.store.getLogicalSession
        ? this.store.getLogicalSession(association.logicalSessionId)
        : null;
      const taskId = association.taskId ?? session?.taskId ?? logical?.taskId ?? null;
      const task = taskId ? this.store.getTask(taskId) : null;
      const active = session ? this.isSessionActive(session) : association.active === true;
      if (isCompletedTask(task)) {
        // One resolution path drives both detail presentation and deletion. A
        // completed Task releases only a settled, identifiable Session route.
        if (!active && association.logicalSessionId) {
          releasableLogicalSessionIds.push(association.logicalSessionId);
          return null;
        }
        return {
          ...association,
          active,
          taskId: null,
          taskTitle: null
        };
      }
      return {
        ...association,
        active,
        taskId: task?.id ?? taskId,
        taskTitle: task?.title ?? null
      };
    }).filter(Boolean);
    return { associations, releasableLogicalSessionIds };
  }

  #reportDeletionFailure(repositoryId, worktreeId, error) {
    this.onDeletionFailure({
      repositoryId,
      worktreeId,
      code: error?.code ?? "WORKTREE_DELETE_FAILED",
      reason: error?.message ?? "The Worktree could not be removed."
    });
  }

  #requireRepository(repositoryId) {
    const repository = this.store.getGitRepository(String(repositoryId ?? "").trim());
    if (!repository) throw new WorktreeIntegrationJobError("REPOSITORY_NOT_FOUND", "Repository not found.", 404);
    return repository;
  }

  #requireJob(jobId) {
    const job = this.store.getWorktreeIntegrationJob(String(jobId ?? "").trim());
    if (!job) throw new WorktreeIntegrationJobError("INTEGRATION_JOB_NOT_FOUND", "Integration task not found.", 404);
    return job;
  }
}

function isCompletedTask(task) {
  const status = String(task?.status ?? "").trim().toLowerCase();
  return new Set(["done", "complete", "completed"]).has(status);
}

export function worktreeDeletionBlocker(worktree) {
  if (worktree.isMain) return blocker("MAIN_WORKTREE", "The main Worktree cannot be deleted.");
  if (worktree.availability !== "available") return blocker("WORKTREE_UNAVAILABLE", "This Worktree is unavailable and cannot be removed safely.");
  if (worktree.isLocked) return blocker("WORKTREE_LOCKED", worktree.lockReason || "This Worktree is locked by another operation.");
  if (worktree.isPrunable) return blocker("WORKTREE_PRUNABLE", worktree.pruneReason || "This Worktree has invalid or prunable Git metadata.");
  if (worktree.operationState) return blocker("GIT_OPERATION_IN_PROGRESS", `A ${worktree.operationState} operation is in progress in this Worktree.`);
  if ((worktree.conflictFiles ?? []).length > 0) return blocker("UNRESOLVED_CONFLICTS", "This Worktree contains unresolved conflicts.");
  if (worktree.dirty !== false) return blocker("UNCOMMITTED_CHANGES", worktree.dirty === true
    ? "This Worktree has uncommitted changes. Commit or discard them before deleting it."
    : "Corptie could not verify that this Worktree has no uncommitted changes.");
  if (worktree.mergedIntoMain !== true) return blocker("NOT_MERGED_INTO_MAIN", "This Worktree has commits that are not merged into main.");
  if (worktree.isDetached || !worktree.branchName) return blocker("WORKTREE_BRANCH_AMBIGUOUS", "The branch for this Worktree cannot be determined safely.");
  const associations = worktree.associations ?? [];
  const taskAssociations = associations.filter((association) => association.taskId);
  if (taskAssociations.length > 0) {
    const labels = associationLabels(taskAssociations, "taskTitle", "taskId");
    return blocker(
      "TASK_ASSOCIATED",
      `This Worktree is still associated with ${pluralizedAssociation("Task", labels)}. Complete or move ${labels.length === 1 ? "it" : "them"} before deleting the Worktree.`
    );
  }
  if (associations.length > 0) {
    const labels = associationLabels(associations, "title", "sessionId", "logicalSessionId");
    return blocker(
      "WORKTREE_IN_USE",
      `This Worktree is still used by ${pluralizedAssociation("Session", labels)}. Switch or remove ${labels.length === 1 ? "it" : "them"} before deleting the Worktree.`
    );
  }
  return null;
}

function blocker(code, reason) {
  return { code, reason };
}

function associationLabels(associations, titleKey, idKey, fallbackIdKey = null) {
  return [...new Set(associations.map((association) => {
    const id = association[idKey] ?? (fallbackIdKey ? association[fallbackIdKey] : null);
    const title = association[titleKey];
    return title && id ? `“${title}” (${id})` : (title ?? id ?? "an unknown association");
  }))];
}

function pluralizedAssociation(kind, labels) {
  return `${kind}${labels.length === 1 ? "" : "s"} ${labels.join(", ")}`;
}

function deletionResult(worktree, status, code, reason, removal = null) {
  return {
    worktreeId: worktree.worktreeId,
    branchName: worktree.branchName ?? null,
    path: worktree.path,
    status,
    code,
    reason,
    removal
  };
}

function isDeletionBlockerCode(code) {
  return new Set([
    "MAIN_WORKTREE", "WORKTREE_UNAVAILABLE", "WORKTREE_LOCKED", "WORKTREE_PRUNABLE",
    "GIT_OPERATION_IN_PROGRESS", "UNRESOLVED_CONFLICTS", "UNCOMMITTED_CHANGES",
    "NOT_MERGED_INTO_MAIN", "WORKTREE_BRANCH_AMBIGUOUS", "TASK_ASSOCIATED",
    "WORKTREE_IN_USE"
  ]).has(code);
}

function risksFor(worktree) {
  const risks = [];
  if (worktree.isMain && worktree.dirty === true) {
    risks.push({
      code: "MAIN_UNCOMMITTED_CHANGES",
      message: "main has uncommitted changes. Corptie will not switch, commit, clean, or overwrite them."
    });
  }
  if (worktree.availability !== "available") risks.push({ code: "WORKTREE_UNAVAILABLE", message: "Worktree is unavailable." });
  if (worktree.isLocked) risks.push({ code: "WORKTREE_LOCKED", message: worktree.lockReason || "Worktree is locked." });
  if (worktree.isPrunable) risks.push({ code: "WORKTREE_PRUNABLE", message: worktree.pruneReason || "Worktree metadata is prunable." });
  if (worktree.operationState) risks.push({ code: "GIT_OPERATION_IN_PROGRESS", message: `${worktree.operationState} is already in progress.` });
  if (!worktree.isMain && (worktree.isDetached || !worktree.branchName)) {
    risks.push({ code: "WORKTREE_BRANCH_AMBIGUOUS", message: "A non-main Worktree must have an attributable branch." });
  }
  if ((worktree.conflictFiles ?? []).length > 0) risks.push({ code: "UNRESOLVED_CONFLICTS", message: "Worktree has unresolved conflict files." });
  const activeSessions = (worktree.associations ?? []).filter((association) => association.active === true);
  if (activeSessions.length > 0) {
    const labels = activeSessions.map((association) => association.title ?? association.sessionId ?? association.logicalSessionId);
    risks.push({
      code: "ACTIVE_SESSION_IN_PROGRESS",
      message: `Active Sessions are still modifying this Worktree: ${labels.join(", ")}.`
    });
  }
  return risks;
}

function risksForBranchOperation(worktree, { isTarget, operationType }) {
  const risks = risksFor({ ...worktree, isMain: false });
  if (isTarget && worktree.dirty === true) {
    risks.push({
      code: "TARGET_UNCOMMITTED_CHANGES",
      message: `${worktree.branchName ?? worktree.path} has uncommitted changes. Preserve them before using this branch as the operation target.`
    });
  }
  if (operationType === "sync" && isTarget && worktree.headOid == null) {
    risks.push({ code: "TARGET_HEAD_MISSING", message: "The synchronization target has no commit." });
  }
  return risks;
}

function withProtectedPathsDigest(commitProtection) {
  if (!commitProtection) return null;
  return {
    ...commitProtection,
    protectedPathsDigest: protectedPathsDigest(commitProtection)
  };
}

function validateCommitProtectionDecisionBindings(
  plan,
  decisions,
  candidateFingerprint,
  { requireBindings = false } = {}
) {
  for (const [worktreeId, decision] of Object.entries(decisions)) {
    const item = plan.items.find((candidate) => candidate.worktreeId === worktreeId);
    if (!item) {
      throw new WorktreeIntegrationJobError(
        "COMMIT_PROTECTION_DECISION_INVALID",
        `The protected-file decision references an unknown Worktree: ${worktreeId}.`,
        409
      );
    }
    if ((requireBindings && decision.candidateFingerprint !== candidateFingerprint)
      || (decision.candidateFingerprint != null
        && decision.candidateFingerprint !== candidateFingerprint)) {
      throw new WorktreeIntegrationJobError(
        "COMMIT_PROTECTION_DECISION_STALE",
        `The protected-file decision for ${item.branchName ?? item.path} belongs to a different candidate.`,
        409
      );
    }
    const expectedDigest = item.commitProtection?.protectedPathsDigest
      ?? protectedPathsDigest(item.commitProtection);
    if ((requireBindings && decision.protectedPathsDigest !== expectedDigest)
      || (decision.protectedPathsDigest != null
        && decision.protectedPathsDigest !== expectedDigest)) {
      throw new WorktreeIntegrationJobError(
        "COMMIT_PROTECTION_DECISION_STALE",
        `The protected-file decision for ${item.branchName ?? item.path} no longer matches its reviewed paths.`,
        409
      );
    }
  }
}

function bindCommitProtectionDecisions(plan, decisions, candidateFingerprint) {
  return Object.fromEntries(Object.entries(decisions).map(([worktreeId, decision]) => {
    const item = plan.items.find((candidate) => candidate.worktreeId === worktreeId);
    return [worktreeId, {
      ...decision,
      candidateFingerprint,
      protectedPathsDigest: protectedPathsDigest(item?.commitProtection)
    }];
  }));
}

function protectedPathsDigest(commitProtection) {
  return fingerprintValue({
    protectedPaths: [...(commitProtection?.protectedPaths ?? [])].sort(),
    localSymlinkPaths: [...(commitProtection?.localSymlinkPaths ?? [])].sort()
  });
}

function startRequestFingerprintFor(repositoryId, input, options, decisions) {
  return fingerprintValue({
    version: START_REQUEST_FINGERPRINT_VERSION,
    repositoryId,
    candidateId: String(input.candidateId ?? input.id ?? "").trim(),
    candidateFingerprint: String(input.candidateFingerprint ?? input.planFingerprint ?? "").trim(),
    options,
    commitProtectionDecisions: Object.fromEntries(Object.entries(decisions).sort(([left], [right]) =>
      left.localeCompare(right)))
  });
}

function assertIdempotentReplay(job, startRequestFingerprint) {
  if (job.startRequestFingerprint === startRequestFingerprint) return job;
  throw new WorktreeIntegrationJobError(
    "IDEMPOTENCY_KEY_REUSED",
    "This idempotency key was already used for a different integration start request.",
    409
  );
}

function requestObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorktreeIntegrationJobError(
      "INVALID_REQUEST_BODY",
      "The request body must be a JSON object."
    );
  }
  return value;
}

function candidateOptions(value = {}, { canonicalOnly = false } = {}) {
  const rawType = String(value.operationType ?? "").trim();
  const hasSources = Array.isArray(value.sourceWorktreeIds)
    ? value.sourceWorktreeIds.length > 0
    : value.sourceWorktreeIds != null;
  const hasTarget = String(value.targetWorktreeId ?? "").trim().length > 0;
  if (!rawType) {
    if (hasSources || hasTarget) {
      throw new WorktreeIntegrationJobError(
        "BRANCH_OPERATION_INVALID",
        "Include a canonical operationType with branch-operation Worktree identifiers."
      );
    }
    return {};
  }
  if (canonicalOnly && !["merge", "sync", "converge"].includes(rawType)) {
    throw new WorktreeIntegrationJobError(
      "BRANCH_OPERATION_INVALID",
      "Use the canonical merge, sync, or converge operation type when starting a candidate."
    );
  }
  const operation = normalizeBranchOperation(value);
  return {
    operationType: operation.type,
    sourceWorktreeIds: operation.sourceWorktreeIds,
    targetWorktreeId: operation.targetWorktreeId
  };
}

function branchCandidateId(candidateId) {
  return /^integration_candidate:(?:merge|sync|converge):/.test(candidateId);
}

function requiredBoundedText(value, code, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength) {
    throw new WorktreeIntegrationJobError(code, "A stable idempotency key is required.");
  }
  return text;
}

function assertCommitProtectionDecisions(plan, decisions) {
  for (const item of plan.items) {
    if (item.commitProtection?.requiresDecision !== true) continue;
    const decision = decisions[item.worktreeId]?.decision;
    if (decision !== "ignore" && decision !== "include") {
      throw new WorktreeIntegrationJobError(
        "GIT_COMMIT_PROTECTION_REQUIRED",
        `Choose how to handle protected files in ${item.branchName ?? item.path} before confirming.`,
        409
      );
    }
  }
}

function deterministicPlanDiff(previousPlan, nextPlan) {
  const previousItems = new Map((previousPlan?.items ?? []).map((item) => [item.worktreeId, item]));
  const nextItems = new Map((nextPlan?.items ?? []).map((item) => [item.worktreeId, item]));
  const previousIds = [...previousItems.keys()].sort();
  const nextIds = [...nextItems.keys()].sort();
  const addedWorktreeIds = nextIds.filter((id) => !previousItems.has(id));
  const removedWorktreeIds = previousIds.filter((id) => !nextItems.has(id));
  const comparedFields = [
    "path", "branchName", "availability", "sourceHeadBefore", "statusSummary", "changedFiles",
    "dirty", "aheadOfMain", "behindMain", "mergedIntoMain", "risks", "commitProtection",
    "commitMessage", "commitStatus", "mergeStatus"
  ];
  const changedWorktrees = previousIds.filter((id) => nextItems.has(id)).flatMap((worktreeId) => {
    const before = previousItems.get(worktreeId);
    const after = nextItems.get(worktreeId);
    const changes = comparedFields.flatMap((field) => canonicalStringify(before[field]) === canonicalStringify(after[field])
      ? []
      : [{ field, before: before[field] ?? null, after: after[field] ?? null }]);
    return changes.length > 0 ? [{ worktreeId, changes }] : [];
  });
  const beforeRisks = sortedRisks(previousPlan?.blockingRisks ?? []);
  const afterRisks = sortedRisks(nextPlan?.blockingRisks ?? []);
  const beforeOrder = [...(previousPlan?.mergeOrder ?? [])];
  const afterOrder = [...(nextPlan?.mergeOrder ?? [])];
  const risksChanged = canonicalStringify(beforeRisks) !== canonicalStringify(afterRisks);
  const orderChanged = canonicalStringify(beforeOrder) !== canonicalStringify(afterOrder);
  const contextFields = [
    "repositoryId", "operationType", "syncMode", "targetWorktreeId", "targetBranchName",
    "sourceWorktreeIds", "mainWorktreeId", "mainPath", "mainHeadBefore", "inventoryVersion",
    "validationSnapshot", "executionPath"
  ];
  const contextChanges = contextFields.flatMap((field) => (
    canonicalStringify(previousPlan?.[field]) === canonicalStringify(nextPlan?.[field])
      ? []
      : [{ field, before: previousPlan?.[field] ?? null, after: nextPlan?.[field] ?? null }]
  ));
  const changed = canonicalStringify(previousPlan) !== canonicalStringify(nextPlan);
  const hasDetailedChange = addedWorktreeIds.length > 0 || removedWorktreeIds.length > 0
    || changedWorktrees.length > 0 || risksChanged || orderChanged || contextChanges.length > 0;
  return {
    addedWorktreeIds,
    removedWorktreeIds,
    changedWorktrees,
    contextChanges,
    reason: changed && !hasDetailedChange ? "plan_changed" : null,
    risks: { changed: risksChanged, before: beforeRisks, after: afterRisks },
    mergeOrder: { changed: orderChanged, before: beforeOrder, after: afterOrder },
    changed
  };
}

function sortedRisks(risks) {
  return [...risks].map((risk) => ({ ...risk })).sort((left, right) =>
    `${left.worktreeId ?? ""}\0${left.code ?? ""}\0${left.message ?? ""}`
      .localeCompare(`${right.worktreeId ?? ""}\0${right.code ?? ""}\0${right.message ?? ""}`));
}

function normalizeBranchOperation(value) {
  const rawType = String(value?.operationType ?? "").trim();
  if (!rawType) return null;
  const type = rawType === "merge" || rawType === "batch_merge" ? "merge"
    : rawType === "sync" || rawType === "one_way_sync" ? "sync"
      : rawType === "converge" ? "converge" : null;
  if (!type) {
    throw new WorktreeIntegrationJobError("BRANCH_OPERATION_INVALID", "Choose merge, one-way synchronization, or convergence.");
  }
  const sourceWorktreeIds = Array.isArray(value.sourceWorktreeIds)
    ? [...new Set(value.sourceWorktreeIds.map((id) => String(id ?? "").trim()).filter(Boolean))]
    : [];
  const targetWorktreeId = String(value.targetWorktreeId ?? "").trim();
  if (!targetWorktreeId) {
    throw new WorktreeIntegrationJobError("TARGET_WORKTREE_REQUIRED", "Choose the target or base Worktree.");
  }
  if (sourceWorktreeIds.length === 0) {
    throw new WorktreeIntegrationJobError("SOURCE_WORKTREE_REQUIRED", "Select at least one source Worktree.");
  }
  return { type, sourceWorktreeIds, targetWorktreeId };
}

function normalizeCommitProtectionDecisions(value) {
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(value.flatMap((entry) => {
    const worktreeId = String(entry?.worktreeId ?? "").trim();
    const decision = String(entry?.decision ?? "").trim();
    if (!worktreeId || !["ignore", "include"].includes(decision)) return [];
    const normalized = { decision, neverRemind: entry?.neverRemind === true };
    const candidateFingerprint = String(entry?.candidateFingerprint ?? "").trim();
    const pathsDigest = String(entry?.protectedPathsDigest ?? "").trim();
    if (candidateFingerprint) normalized.candidateFingerprint = candidateFingerprint;
    if (pathsDigest) normalized.protectedPathsDigest = pathsDigest;
    return [[worktreeId, normalized]];
  }));
}

function requiresIntegration(worktree) {
  if (worktree.isMain) return false;
  if (worktree.dirty === true) return true;
  return worktree.mergedIntoMain !== true;
}

function planValidationSnapshot(inspection) {
  return [...inspection.worktrees]
    .sort((left, right) => left.worktreeId.localeCompare(right.worktreeId))
    .map((worktree) => ({
      worktreeId: worktree.worktreeId,
      path: worktree.path,
      headOid: worktree.headOid,
      branchName: worktree.branchName,
      availability: worktree.availability,
      dirty: worktree.dirty === true,
      statusSummary: worktree.statusSummary ?? "",
      isLocked: worktree.isLocked === true,
      operationState: worktree.operationState ?? null,
      conflictFiles: [...(worktree.conflictFiles ?? [])].sort(),
      activeSessionIds: (worktree.associations ?? [])
        .filter((association) => association.active === true)
        .map((association) => association.logicalSessionId)
        .sort()
    }));
}

function planMatchesInspection(plan, inspection) {
  if (plan.validationSnapshot) {
    return JSON.stringify(plan.validationSnapshot) === JSON.stringify(planValidationSnapshot(inspection));
  }
  const currentShape = plan.items.map((item) => {
    const worktree = inspection.worktrees.find((entry) => entry.worktreeId === item.worktreeId);
    return { id: item.worktreeId, head: worktree?.headOid, status: worktree?.statusSummary ?? "" };
  });
  const expectedShape = plan.items.map((item) => ({
    id: item.worktreeId, head: item.sourceHeadBefore, status: item.statusSummary
  }));
  return JSON.stringify(currentShape) === JSON.stringify(expectedShape);
}

function planInspectionMismatch(plan, inspection) {
  if (planMatchesInspection(plan, inspection)) return null;
  const expectedMain = (plan.validationSnapshot ?? []).find((entry) => entry.worktreeId === plan.mainWorktreeId);
  const currentMain = inspection.worktrees.find((entry) => entry.worktreeId === plan.mainWorktreeId);
  if (currentMain?.dirty === true && expectedMain?.dirty !== true) {
    return {
      code: "MAIN_DIRTY",
      message: "main gained uncommitted changes after preflight. Nothing was changed; return to Worktree Management, preserve those changes manually, then generate a new plan."
    };
  }
  const currentConflict = inspection.worktrees.find((entry) => (
    !entry.isMain && (entry.conflictFiles ?? []).length > 0
  ));
  if (currentConflict) {
    return {
      code: "WORKTREE_CHANGES_CHANGED",
      message: `Task Worktree ${currentConflict.branchName ?? currentConflict.path} has unresolved changes after preflight. Nothing was changed; resolve them in that Worktree, then generate a new plan.`
    };
  }
  return {
    code: "PLAN_STALE",
    message: "Worktree state changed after preflight. Nothing was changed; return to Worktree Management and generate a new plan."
  };
}

function expectedMainHeadBefore(plan, worktreeId) {
  let head = plan.items.find((item) => item.isMain)?.commitHead ?? plan.mainHeadBefore;
  for (const item of plan.items) {
    if (item.worktreeId === worktreeId) return head;
    if (item.mergeMainHead) head = item.mergeMainHead;
  }
  return head;
}

function conflictResolutionKey(job, item, sourceHead, expectedMainHead) {
  return legacyFingerprint({
    jobId: job.id,
    worktreeId: item.worktreeId,
    sourceHead,
    expectedMainHead,
    conflictFiles: [...(item.conflictFiles ?? [])].sort()
  });
}

function conflictResolutionMatches(job, resolution, item, conflictKey) {
  return ["paused", "queued", "running"].includes(job.status)
    && item?.mergeStatus === "conflict"
    && resolution?.worktreeId === item.worktreeId
    && resolution?.conflictKey === conflictKey;
}

function withoutConflictResolution(details) {
  const { conflictResolution: _discarded, ...remaining } = details;
  return remaining;
}

function progressFor(items) {
  const commitDone = items.filter((item) => ["not_needed", "completed", "recovered"].includes(item.commitStatus)).length;
  const mergeItems = items.filter((item) => !item.isMain);
  const mergeDone = mergeItems.filter((item) => ["not_needed", "completed", "already_integrated", "recovered"].includes(item.mergeStatus)).length;
  const convergenceItems = items.filter((item) => item.convergenceStatus && item.convergenceStatus !== "not_needed");
  const convergenceDone = convergenceItems.filter((item) => item.convergenceStatus === "completed").length;
  const total = items.length + mergeItems.length + convergenceItems.length;
  const completed = commitDone + mergeDone + convergenceDone;
  return { completed, total, fraction: total ? completed / total : 1 };
}

function completedMergeWorktreeIds(items) {
  return items
    .filter((item) => !item.isMain
      && ["not_needed", "completed", "already_integrated", "recovered"].includes(item.mergeStatus))
    .map((item) => item.worktreeId);
}

function blockedConflictAutomation(job, item, error) {
  const automation = job.details.conflictAutomation ?? {};
  return {
    ...automation,
    status: "blocked",
    scopeWorktreeIds: automation.scopeWorktreeIds ?? [...(job.details.plan.mergeOrder ?? [])],
    completedWorktreeIds: completedMergeWorktreeIds(job.details.plan.items),
    currentWorktreeId: item?.worktreeId ?? job.details.currentWorktreeId ?? null,
    blockedWorktreeId: item?.worktreeId ?? job.details.currentWorktreeId ?? null,
    conflictFiles: [...(item?.conflictFiles ?? [])],
    failureCode: error?.code ?? "CONFLICT_AGENT_FAILED",
    failureReason: error?.message ?? "The conflict could not be resolved automatically."
  };
}

function legacyFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fingerprint(value) {
  return fingerprintValue({ version: PLAN_FINGERPRINT_VERSION, plan: value });
}

function fingerprintValue(value) {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecoverableConflictFallbackError(error) {
  if (error?.recoverable === false) return false;
  return new Set([
    "SESSION_TITLE_CONFLICT",
    "SESSION_CREATION_IN_PROGRESS",
    "INTEGRATION_WORKSPACE_NAME_OCCUPIED",
    "INTEGRATION_WORKSPACE_CREATE_RETRYABLE",
    "INTEGRATION_WORKSPACE_INVENTORY_STALE",
    "WORKTREE_COMMIT_FAILED",
    "MERGE_COMMIT_FAILED",
    "MERGE_FAILED",
    "PLAN_STALE",
    "WORKTREE_HEAD_CHANGED",
    "WORKTREE_CHANGES_CHANGED",
    "MAIN_HEAD_CHANGED",
    "MAIN_DIRTY"
  ]).has(error?.code) || error?.code == null;
}

function conflictFallbackFailure(cause, failureStage, retryCount) {
  const error = new WorktreeIntegrationJobError(
    "CONFLICT_FALLBACK_RETRY_EXHAUSTED",
    `Conflict handling failed during ${failureStage} after ${retryCount} attempt(s). Root cause: ${cause?.message ?? "unknown error"}. Preserved all branches, Worktrees, commits, and uncommitted changes. Recovery: re-check Git status and retry this conflict task; if the reported state is still present, preserve the named changes before continuing.`,
    cause?.statusCode ?? 409
  );
  error.cause = cause;
  error.failureStage = failureStage;
  error.retryCount = retryCount;
  error.rootCauseCode = cause?.code ?? "UNKNOWN";
  return error;
}

export function presentJob(job) {
  if (!job) return null;
  return { ...job, ...job.details, details: undefined };
}
