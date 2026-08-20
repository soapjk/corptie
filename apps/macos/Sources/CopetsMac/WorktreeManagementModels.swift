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

    var isActive: Bool { ["queued", "running", "cancellation_requested", "replanning"].contains(status) }
    var shouldPoll: Bool {
        isActive || ["running", "failed"].contains(conflictResolution?.status ?? "")
    }
    var requiresPlanRegeneration: Bool {
        phase == "plan_stale" || (status == "paused" && audit.last(where: { $0.code != nil })?.code == "PLAN_STALE")
    }
    var canStopAndRepreflight: Bool {
        ["queued", "running", "paused"].contains(status) && conflictResolution?.status != "running"
    }
    var hasMergeConflict: Bool {
        status == "paused" && plan.items.contains { $0.worktreeId == currentWorktreeId && $0.mergeStatus == "conflict" }
    }
}

struct WorktreeConflictResolution: Decodable, Equatable, Sendable {
    let status: String
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
    let commitMessage: String?
    let commitStatus: String
    let commitHead: String?
    let mergeStatus: String
    let mergeMainHead: String?
    let conflictFiles: [String]
    let error: String?
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
