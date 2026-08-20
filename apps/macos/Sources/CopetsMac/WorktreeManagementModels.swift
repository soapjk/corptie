import Foundation

struct ManagedRepository: Identifiable, Decodable, Equatable, Sendable {
    let id: String
    let path: String
    let name: String
    let discoveredAt: String
    let lastValidatedAt: String
    let mainPath: String?
    let availability: String
    let worktreeCount: Int
}

struct ManagedRepositoryListEnvelope: Decodable, Sendable {
    let repositories: [ManagedRepository]
}

struct ManagedRepositoryDetail: Decodable, Sendable {
    let repository: ManagedRepository
    let project: ManagedGitProject
    let latestJob: WorktreeIntegrationJob?
}

struct ProjectDevelopmentServiceStatus: Decodable, Equatable, Sendable {
    let projectId: String
    let toolset: ProjectToolsetStatus
    let service: ProjectServiceStatus
}

enum WorktreeListLoadState: Equatable {
    case idle
    case loading
    case loaded
    case failed(String)
}

struct WorktreeLoadMetrics: Equatable, Sendable {
    let repositoryId: String
    let repositoryListMilliseconds: Int
    let detailMilliseconds: Int
    let serviceMilliseconds: Int
    let listAvailableMilliseconds: Int
    let cacheHit: Bool
}

struct ManagedGitProject: Decodable, Sendable {
    let repositoryId: String
    let inventoryVersion: String
    let mainWorktreeId: String
    let mainPath: String
    let mainBranch: String?
    let mainHeadOid: String
    let pendingWorktreeCount: Int
    let worktrees: [ManagedWorktree]
}

struct ManagedWorktree: Identifiable, Decodable, Equatable, Sendable {
    var id: String { worktreeId }
    let worktreeId: String
    let path: String
    let isMain: Bool
    let availability: String
    let headOid: String?
    let branchName: String?
    let isDetached: Bool
    let isLocked: Bool
    let lockReason: String?
    let isPrunable: Bool?
    let pruneReason: String?
    let state: String
    let dirty: Bool?
    let statusSummary: String?
    let diffStat: String?
    let changedFiles: [String]
    let operationState: String?
    let conflictFiles: [String]
    let mergedIntoMain: Bool?
    let synchronizedWithMain: Bool?
    let aheadOfMain: Int?
    let behindMain: Int?
    let pendingIntegration: Bool
    let associations: [ManagedWorktreeAssociation]
}

struct ManagedWorktreeDeletionBlocker: Equatable, Sendable {
    let code: String
    let reason: String
}

enum ManagedWorktreeDeletionPolicy {
    static func blocker(for worktree: ManagedWorktree) -> ManagedWorktreeDeletionBlocker? {
        if worktree.isMain { return .init(code: "MAIN_WORKTREE", reason: "The main Worktree cannot be deleted.") }
        if worktree.availability != "available" { return .init(code: "WORKTREE_UNAVAILABLE", reason: "This Worktree is unavailable and cannot be removed safely.") }
        if worktree.isLocked { return .init(code: "WORKTREE_LOCKED", reason: worktree.lockReason ?? "This Worktree is locked by another operation.") }
        if worktree.isPrunable == true { return .init(code: "WORKTREE_PRUNABLE", reason: worktree.pruneReason ?? "This Worktree has invalid or prunable Git metadata.") }
        if let operation = worktree.operationState { return .init(code: "GIT_OPERATION_IN_PROGRESS", reason: "A \(operation) operation is in progress in this Worktree.") }
        if !worktree.conflictFiles.isEmpty { return .init(code: "UNRESOLVED_CONFLICTS", reason: "This Worktree contains unresolved conflicts.") }
        if worktree.dirty != false {
            return .init(
                code: "UNCOMMITTED_CHANGES",
                reason: worktree.dirty == true
                    ? "This Worktree has uncommitted changes. Commit or discard them before deleting it."
                    : "Corptie could not verify that this Worktree has no uncommitted changes."
            )
        }
        if worktree.mergedIntoMain != true { return .init(code: "NOT_MERGED_INTO_MAIN", reason: "This Worktree has commits that are not merged into main.") }
        if worktree.isDetached || worktree.branchName == nil { return .init(code: "WORKTREE_BRANCH_AMBIGUOUS", reason: "The branch for this Worktree cannot be determined safely.") }
        if worktree.associations.contains(where: { $0.workItemId != nil }) { return .init(code: "WORK_ITEM_ASSOCIATED", reason: "This Worktree is associated with a WorkItem and cannot be deleted.") }
        if !worktree.associations.isEmpty { return .init(code: "WORKTREE_IN_USE", reason: "This Worktree is being used by a Session. Switch or remove the Session before deleting it.") }
        return nil
    }

    static func eligibleWorktrees(from worktrees: [ManagedWorktree]) -> [ManagedWorktree] {
        worktrees.filter { blocker(for: $0) == nil }
    }
}

struct WorktreeDeletionResultEnvelope: Decodable, Sendable {
    let result: WorktreeDeletionResult
}

struct WorktreeCleanupResultEnvelope: Decodable, Sendable {
    let result: WorktreeCleanupResult
}

struct WorktreeDeletionResult: Decodable, Equatable, Sendable, Identifiable {
    var id: String { worktreeId }
    let worktreeId: String
    let branchName: String?
    let path: String
    let status: String
    let code: String?
    let reason: String?
}

struct WorktreeCleanupCounts: Decodable, Equatable, Sendable {
    let removed: Int
    let skipped: Int
    let failed: Int
}

struct WorktreeCleanupResult: Decodable, Equatable, Sendable, Identifiable {
    var id: String { "\(counts.removed):\(counts.skipped):\(counts.failed):\(removed.map(\.worktreeId).joined(separator: ","))" }
    let removed: [WorktreeDeletionResult]
    let skipped: [WorktreeDeletionResult]
    let failed: [WorktreeDeletionResult]
    let counts: WorktreeCleanupCounts
}

struct WorktreeCleanupProgress: Equatable, Sendable {
    let total: Int
    let currentIndex: Int
    let completed: Int
    let branchName: String
    let path: String
    let command: String

    var fraction: Double {
        guard total > 0 else { return 0 }
        return Double(completed) / Double(total)
    }

    static func deleting(
        _ worktree: ManagedWorktree,
        mainPath: String,
        currentIndex: Int,
        total: Int
    ) -> WorktreeCleanupProgress {
        let remove = "git -C \(shellQuote(mainPath)) worktree remove \(shellQuote(worktree.path))"
        let deleteBranch = worktree.branchName.map {
            "git -C \(shellQuote(mainPath)) branch -d \(shellQuote($0))"
        }
        return WorktreeCleanupProgress(
            total: total,
            currentIndex: currentIndex,
            completed: max(0, currentIndex - 1),
            branchName: worktree.branchName ?? worktree.path,
            path: worktree.path,
            command: [remove, deleteBranch].compactMap { $0 }.joined(separator: " && ")
        )
    }

    private static func shellQuote(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}

struct ManagedWorktreeAssociation: Decodable, Equatable, Sendable {
    let logicalSessionId: String
    let sessionId: String?
    let title: String?
    let active: Bool
    let workItemId: String?
    let workItemTitle: String?
}

struct WorktreeIntegrationJobEnvelope: Decodable, Sendable {
    let job: WorktreeIntegrationJob
}

struct WorktreeIntegrationJob: Identifiable, Decodable, Equatable, Sendable {
    let id: String
    let repositoryId: String
    let status: String
    let phase: String
    let planFingerprint: String
    let error: String?
    let createdAt: String
    let updatedAt: String
    let confirmedAt: String?
    let completedAt: String?
    let plan: WorktreeIntegrationPlan
    let currentWorktreeId: String?
    let progress: WorktreeIntegrationProgress
    let audit: [WorktreeIntegrationAuditEvent]
    let conflictResolution: WorktreeConflictResolution?
    let commitProtectionDecisions: [String: WorktreePersistedCommitProtectionDecision]?

    var currentConflictResolution: WorktreeConflictResolution? {
        guard let currentWorktreeId,
              conflictResolution?.worktreeId == currentWorktreeId else { return nil }
        return conflictResolution
    }

    var isActive: Bool { ["queued", "running", "cancellation_requested", "replanning"].contains(status) }
    var shouldPoll: Bool {
        isActive || ["running", "failed"].contains(currentConflictResolution?.status ?? "")
    }
    var requiresPlanRegeneration: Bool {
        let code = audit.last(where: { $0.code != nil })?.code
        return WorktreeIntegrationRecoveryPolicy.requiresRepreflight(status: status, phase: phase, auditCode: code)
    }
    var canStopAndRepreflight: Bool {
        ["awaiting_confirmation", "queued", "running", "paused"].contains(status)
            && currentConflictResolution?.status != "running"
    }
    var hasMergeConflict: Bool {
        status == "paused" && plan.items.contains { $0.worktreeId == currentWorktreeId && $0.mergeStatus == "conflict" }
    }
}

enum WorktreeIntegrationRecoveryPolicy {
    private static let stateDriftCodes: Set<String> = [
        "PLAN_STALE", "MAIN_HEAD_CHANGED", "MAIN_DIRTY",
        "WORKTREE_HEAD_CHANGED", "WORKTREE_CHANGES_CHANGED", "UNRELATED_MERGE_IN_PROGRESS"
    ]

    static func requiresRepreflight(status: String, phase: String, auditCode: String?) -> Bool {
        phase == "plan_stale" || (status == "paused" && auditCode.map(stateDriftCodes.contains) == true)
    }
}

struct WorktreeConflictResolution: Decodable, Equatable, Sendable {
    let status: String
    let worktreeId: String?
    let conflictKey: String?
    let workspace: WorktreeConflictResolutionWorkspace
    let workItemId: String?
    let sessionId: String?
    let agentId: String?
    let agentName: String?
    let sessionStatus: String?
}

struct WorktreeConflictResolutionWorkspace: Decodable, Equatable, Sendable {
    let worktreeId: String
    let path: String
    let branchName: String?
    let headOid: String?
}

struct WorktreeIntegrationPlan: Decodable, Equatable, Sendable {
    let repositoryId: String
    let mainWorktreeId: String
    let mainPath: String
    let mainHeadBefore: String
    let inventoryVersion: String
    let mergeOrder: [String]
    let blockingRisks: [WorktreeIntegrationRisk]
    let items: [WorktreeIntegrationItem]

    var preflightState: WorktreeIntegrationPreflightState {
        WorktreeIntegrationPreflightState(risks: blockingRisks)
    }
}

enum WorktreeIntegrationPreflightState: Equatable, Sendable {
    case ready
    case taskConflict
    case mainUncommittedChanges
    case taskConflictAndMainUncommittedChanges
    case otherBlockingRisks

    init(risks: [WorktreeIntegrationRisk]) {
        let hasMainChanges = risks.contains { $0.code == "MAIN_UNCOMMITTED_CHANGES" }
        let hasTaskConflict = risks.contains { $0.code == "UNRESOLVED_CONFLICTS" && $0.worktreeId != nil }
        let hasOther = risks.contains { risk in
            risk.code != "MAIN_UNCOMMITTED_CHANGES"
                && !(risk.code == "UNRESOLVED_CONFLICTS" && risk.worktreeId != nil)
        }
        switch (hasMainChanges, hasTaskConflict, hasOther) {
        case (false, false, false): self = .ready
        case (true, true, _): self = .taskConflictAndMainUncommittedChanges
        case (true, false, false): self = .mainUncommittedChanges
        case (false, true, false): self = .taskConflict
        default: self = .otherBlockingRisks
        }
    }
}

struct WorktreeIntegrationItem: Identifiable, Decodable, Equatable, Sendable {
    var id: String { worktreeId }
    let ordinal: Int
    let worktreeId: String
    let path: String
    let branchName: String?
    let isMain: Bool
    let availability: String
    let sourceHeadBefore: String?
    let statusSummary: String
    let changedFiles: [String]
    let dirty: Bool
    let aheadOfMain: Int?
    let behindMain: Int?
    let mergedIntoMain: Bool?
    let associations: [ManagedWorktreeAssociation]
    let risks: [WorktreeIntegrationRisk]
    let commitProtection: GitCommitProtectionStatus?
    let commitMessage: String?
    let commitStatus: String
    let commitHead: String?
    let mergeStatus: String
    let mergeMainHead: String?
    let conflictFiles: [String]
    let error: String?
}

struct WorktreeCommitProtectionDecision: Equatable, Sendable {
    let worktreeId: String
    let decision: String
    let neverRemind: Bool
}

struct WorktreePersistedCommitProtectionDecision: Decodable, Equatable, Sendable {
    let decision: String
    let neverRemind: Bool
}

struct WorktreeIntegrationRisk: Decodable, Equatable, Sendable {
    let worktreeId: String?
    let code: String
    let message: String
}

struct WorktreeIntegrationProgress: Decodable, Equatable, Sendable {
    let completed: Int
    let total: Int
    let fraction: Double
}

struct WorktreeIntegrationAuditEvent: Decodable, Equatable, Sendable {
    let at: String
    let event: String
    let worktreeId: String?
    let code: String?
}

struct WorktreeManagementSelection: Equatable {
    var repositoryId: String?
    var worktreeId: String?

    mutating func reconcile(repositories: [ManagedRepository], worktrees: [ManagedWorktree] = []) {
        if !repositories.contains(where: { $0.id == repositoryId }) {
            repositoryId = repositories.first?.id
            worktreeId = nil
        }
        if !worktrees.contains(where: { $0.worktreeId == worktreeId }) {
            worktreeId = worktrees.first(where: \.isMain)?.worktreeId ?? worktrees.first?.worktreeId
        }
    }

    mutating func select(
        target: WorktreeNavigationTarget,
        worktrees: [ManagedWorktree]
    ) -> Bool {
        if let worktreeId = target.worktreeId,
           let worktree = worktrees.first(where: { $0.worktreeId == worktreeId }) {
            self.worktreeId = worktree.worktreeId
            return true
        }
        if let worktreePath = target.worktreePath {
            let normalized = URL(fileURLWithPath: worktreePath).standardizedFileURL.path
            if let worktree = worktrees.first(where: {
                URL(fileURLWithPath: $0.path).standardizedFileURL.path == normalized
            }) {
                self.worktreeId = worktree.worktreeId
                return true
            }
            return false
        }
        return target.worktreeId == nil
    }
}

struct IndividualWorktreeOperationPreparation: Equatable, Sendable {
    let commitMessage: String?
    let protection: GitCommitProtectionStatus?
}
