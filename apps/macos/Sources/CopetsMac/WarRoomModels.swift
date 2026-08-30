import Foundation

// 控制台数据模型（15 Phase 5 净新增）。
// 独立于现有 Models.swift 巨石，对齐后端 entityHttpApi 返回的 snake_case JSON
// （Objective/WorkItem 字段名，见后端 corptieStore 的 objectives / work_items 表）。

struct Objective: Identifiable, Codable, Hashable {
    let id: String
    var name: String
    var description: String
    var idealState: String
    var status: String
    var priority: String?
    var targetDate: String?
    var tags: [String]
    var workspaceIds: [String]
    var relatedObjectiveIds: [String]
    var contributorAgentIds: [String]
    var createdAt: String
    var updatedAt: String
}

// 挂靠资源：Git 仓库（Objective 涉及修改的 Workspace）
struct GitRepository: Identifiable, Codable, Hashable {
    let id: String
    let path: String
    let name: String
    var discoveredAt: String?
    var lastValidatedAt: String?
}

struct WorkItem: Identifiable, Codable, Hashable {
    let id: String
    var objectiveId: String
    var title: String
    var description: String
    var acceptanceCriteria: String
    var priority: String
    var status: String
    var mainWorkspaceId: String?
    var mainAgentId: String?
    var currentSessionId: String?
    var executionStatus: String?
    var startStage: String? = nil
    var startFailureStage: String? = nil
    var startErrorCode: String? = nil
    var startError: String? = nil
    var startStartedAt: String? = nil
    var startStageUpdatedAt: String? = nil
    var startFailedAt: String? = nil
    var startProviderId: String? = nil
    var startAgentId: String? = nil
    var startWorktreeId: String? = nil
    var startWorktreePath: String? = nil
    var startWorktreeBranch: String? = nil
    var acceptanceAssessment: WorkItemAcceptanceAssessment?
    var completionSuggestion: WorkItemCompletionSuggestion?
    var completionSource: WorkItemCompletionSource? = nil
    var canceledAt: String? = nil
    var cancelReason: String? = nil
    var cancellationOperationId: String? = nil
    var resourceVersion: Int = 1
    var createdAt: String
    var updatedAt: String

    private enum CodingKeys: String, CodingKey {
        case id, objectiveId, title, description, acceptanceCriteria, priority, status
        case mainWorkspaceId, mainAgentId, currentSessionId, executionStatus
        case startStage, startFailureStage, startErrorCode, startError
        case startStartedAt, startStageUpdatedAt, startFailedAt, startProviderId, startAgentId
        case startWorktreeId, startWorktreePath, startWorktreeBranch
        case acceptanceAssessment, completionSuggestion, completionSource
        case canceledAt, cancelReason, cancellationOperationId, resourceVersion
        case createdAt, updatedAt
    }
}

extension WorkItem {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        objectiveId = try container.decode(String.self, forKey: .objectiveId)
        title = try container.decode(String.self, forKey: .title)
        description = try container.decode(String.self, forKey: .description)
        // Old databases contain NULL here. Treat absence, NULL, and a legacy
        // non-string value as an empty criterion instead of rejecting the
        // entire state snapshot.
        acceptanceCriteria = (try? container.decodeIfPresent(String.self, forKey: .acceptanceCriteria)) ?? nil ?? ""
        priority = try container.decode(String.self, forKey: .priority)
        status = try container.decode(String.self, forKey: .status)
        mainWorkspaceId = try container.decodeIfPresent(String.self, forKey: .mainWorkspaceId)
        mainAgentId = try container.decodeIfPresent(String.self, forKey: .mainAgentId)
        currentSessionId = try container.decodeIfPresent(String.self, forKey: .currentSessionId)
        executionStatus = try container.decodeIfPresent(String.self, forKey: .executionStatus)
        startStage = try container.decodeIfPresent(String.self, forKey: .startStage)
        startFailureStage = try container.decodeIfPresent(String.self, forKey: .startFailureStage)
        startErrorCode = try container.decodeIfPresent(String.self, forKey: .startErrorCode)
        startError = try container.decodeIfPresent(String.self, forKey: .startError)
        startStartedAt = try container.decodeIfPresent(String.self, forKey: .startStartedAt)
        startStageUpdatedAt = try container.decodeIfPresent(String.self, forKey: .startStageUpdatedAt)
        startFailedAt = try container.decodeIfPresent(String.self, forKey: .startFailedAt)
        startProviderId = try container.decodeIfPresent(String.self, forKey: .startProviderId)
        startAgentId = try container.decodeIfPresent(String.self, forKey: .startAgentId)
        startWorktreeId = try container.decodeIfPresent(String.self, forKey: .startWorktreeId)
        startWorktreePath = try container.decodeIfPresent(String.self, forKey: .startWorktreePath)
        startWorktreeBranch = try container.decodeIfPresent(String.self, forKey: .startWorktreeBranch)
        // A pre-contract collaboration object used this field for unrelated
        // metadata. Drop only that invalid optional field; keep the WorkItem.
        acceptanceAssessment = (try? container.decodeIfPresent(WorkItemAcceptanceAssessment.self, forKey: .acceptanceAssessment)) ?? nil
        completionSuggestion = (try? container.decodeIfPresent(WorkItemCompletionSuggestion.self, forKey: .completionSuggestion)) ?? nil
        completionSource = (try? container.decodeIfPresent(WorkItemCompletionSource.self, forKey: .completionSource)) ?? nil
        canceledAt = try container.decodeIfPresent(String.self, forKey: .canceledAt)
        cancelReason = try container.decodeIfPresent(String.self, forKey: .cancelReason)
        cancellationOperationId = try container.decodeIfPresent(String.self, forKey: .cancellationOperationId)
        resourceVersion = try container.decodeIfPresent(Int.self, forKey: .resourceVersion) ?? 1
        createdAt = try container.decode(String.self, forKey: .createdAt)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }
}

struct WorkItemCompletionSource: Codable, Hashable {
    let sourceType: String
    let operationId: String?
    let completedAt: String?
}

struct WorkItemCompletionIntentReceipt: Codable, Hashable {
    let receiptId: String
    let intentToken: String
    let workItemId: String
    let objectiveId: String
    let interactionId: String
    let uiSurface: String
    let issuedAt: String
    let expiresAt: String
    let purpose: String
}

struct WorkItemCompletionOperation: Codable, Hashable {
    let operationId: String
    let workItemId: String
    let objectiveId: String
    let result: String
    let sourceType: String
    let requestId: String
    let idempotencyKey: String
    let errorCode: String?
    let createdAt: String
}

struct WorkItemCompletionEnvelope: Codable {
    let workItem: WorkItem
    let operation: WorkItemCompletionOperation
    let idempotentReplay: Bool
}

/// Immutable payload captured at the user's click. Background retry owns this
/// value and never re-derives a target from navigation or current selection.
struct WorkItemCompletionSubmission: Equatable {
    let workItemId: String
    let objectiveId: String
    let displayedTitle: String
    let receipt: WorkItemCompletionIntentReceipt
    let requestId: String
    let idempotencyKey: String

    static func freeze(
        workItem: WorkItem,
        receipt: WorkItemCompletionIntentReceipt,
        requestId: String,
        idempotencyKey: String
    ) -> WorkItemCompletionSubmission? {
        guard receipt.workItemId == workItem.id,
              receipt.objectiveId == workItem.objectiveId,
              !requestId.isEmpty,
              !idempotencyKey.isEmpty else { return nil }
        return WorkItemCompletionSubmission(
            workItemId: workItem.id,
            objectiveId: workItem.objectiveId,
            displayedTitle: workItem.title,
            receipt: receipt,
            requestId: requestId,
            idempotencyKey: idempotencyKey
        )
    }
}

struct WorkItemAcceptanceEvidence: Codable, Hashable {
    let summary: String
    let reference: String
}

struct WorkItemAcceptanceResult: Codable, Hashable {
    let criterion: String
    let verdict: String
    let evidence: [WorkItemAcceptanceEvidence]
}

struct WorkItemAcceptanceAssessment: Codable, Hashable {
    let status: String
    let criteriaSnapshot: String
    let sourceSessionId: String
    let assessedAt: String
    let results: [WorkItemAcceptanceResult]
}

struct WorkItemCompletionSuggestion: Codable, Hashable {
    let recommended: Bool
    let sourceSessionId: String
    let assessedAt: String
    let criteriaSnapshot: String
    let results: [WorkItemAcceptanceResult]
}

struct WorkItemRetiredWorkspace: Codable, Hashable {
    let worktreeId: String
    let path: String
    let retiredAt: String
}

struct WorkItemWorktreeStatus: Decodable, Equatable {
    let status: String
    let sessionId: String?
    let repositoryId: String?
    let worktree: ProjectWorktreeStatus?
    let canReclaim: Bool
    let blocker: String?
    let detail: String?
    let retiredWorkspace: WorkItemRetiredWorkspace?
}

struct WorkItemDeletionRisk: Codable, Equatable, Identifiable {
    var id: String { code }
    let code: String
    let message: String
    let files: [String]?
    let commitCount: Int?
}

struct WorkItemDeletionWorktree: Codable, Equatable {
    let worktreeId: String
    let path: String
    let branchName: String?
    let isMain: Bool
    let dirty: Bool
    let mergedIntoMain: Bool
    let aheadOfMain: Int
}

struct WorkItemDeletionPlan: Codable, Equatable {
    let workItemId: String
    let status: String
    let retryable: Bool
    let associatedSessionCount: Int
    let worktree: WorkItemDeletionWorktree?
    let risks: [WorkItemDeletionRisk]
    let blockers: [WorkItemDeletionRisk]
}

struct WorkItemDeletionResult: Decodable {
    let ok: Bool
    let workItemId: String
}

// 后端响应 envelope：GET /objectives → { objectives: [...] }；GET /work-items → { workItems: [...] }
struct ObjectiveListEnvelope: Codable {
    let objectives: [Objective]
}

struct WorkItemListEnvelope: Codable {
    let workItems: [WorkItem]
}

// 后端响应 envelope：GET /repositories → { repositories: [...] }
struct RepositoryListEnvelope: Codable {
    let repositories: [GitRepository]
}

// 后端响应 envelope：POST /repositories/detect → { repository: {...} }
struct RepositoryDetectEnvelope: Codable {
    let repository: GitRepository
}

// 看板列（03 §14.3 混合看板：待办 / 进行中 / 评审 / 完成）
// TODO(接 L10n)：列标题与状态文案后续接入 AppLanguage，第一版硬编码中文。
enum WorkItemColumn: String, CaseIterable, Identifiable {
    case todo
    case inProgress
    case done

    var id: String { rawValue }

    @MainActor var title: String {
        switch self {
        case .todo: L10n("Not Started")
        case .inProgress: L10n("In Progress")
        case .done: L10n("Completed")
        }
    }

    var systemImage: String {
        switch self {
        case .todo: "circle"
        case .inProgress: "circle.dotted"
        case .done: "checkmark.circle"
        }
    }

    // 后端 status 字符串 → 看板列（容错：未知值归「待开始」）
    static func column(for status: String) -> WorkItemColumn {
        switch status {
        case "todo", "pending", "ready": .todo
        case "in_progress", "doing", "running": .inProgress
        case "done", "complete", "completed": .done
        default: .todo
        }
    }
}

// WorkItem 名下的 Session 轻量摘要（模块 F 下钻列表；避免 TaskSession 复杂解码）
struct WorkItemSessionSummary: Identifiable, Codable, Hashable {
    let id: String
    let title: String
    let status: String
    let updatedAt: String
}

enum WorkItemExecutionPresentation {
    @MainActor
    static func label(executionStatus: String?, sessionStatus: String?) -> String {
        switch sessionStatus ?? executionStatus {
        case "running": L10n("Running")
        case "blocked": L10n("Waiting for Input")
        case "completed", "complete", "done": L10n("Complete")
        case "failed", "start_failed": L10n("Failed to Start")
        case "paused": L10n("Paused")
        case "cancelled", "canceled": L10n("Interrupted")
        case "idle", nil: L10n("Not Started")
        default: L10n("Unknown")
        }
    }
}

enum WorkItemStartPresentation {
    static func isPartialFailure(_ workItem: WorkItem) -> Bool {
        workItem.startStage == "failed" && workItem.currentSessionId == nil
    }

    @MainActor
    static func stageLabel(_ stage: String?) -> String {
        switch stage {
        case "validating": L10n("Validating")
        case "preparingWorkspace": L10n("Preparing Worktree")
        case "creatingSession": L10n("Creating Worker Session")
        case "binding": L10n("Binding Session")
        case "running": L10n("Running")
        case "failed": L10n("Failed")
        default: L10n("Unknown Stage")
        }
    }
}

// 后端响应 envelope：GET /work-items/:id/sessions → { sessions: [...] }
struct WorkItemSessionListEnvelope: Codable {
    let sessions: [WorkItemSessionSummary]
}

// 后端响应 envelope：POST /sessions / POST /agents/:id/sessions → { session: TaskSession }
struct SessionCreateEnvelope: Codable {
    let session: TaskSession
}

struct WorkItemRestoreEnvelope: Decodable {
    let workItem: WorkItem
}

// 后端错误响应：关联校验失败时同时返回稳定 code、field 与 expected。
struct EntityErrorEnvelope: Codable {
    let error: String
    let code: String?
    let field: String?
    let expected: String?
    let deletion: WorkItemDeletionPlan?

    var displayMessage: String {
        guard let field, let expected else { return error }
        return "\(error)（字段：\(field)，期望：\(expected)）"
    }
}

enum RepositoryRegistrationResult {
    case success(GitRepository)
    case notGitRepository
    case failure(String)
}

// 执行/操作失败的结果（含错误码，供 UI 做针对性引导，如「未绑定仓库」给绑定入口）
struct EntityLaunchError: Error, LocalizedError {
    let message: String
    let code: String?

    var errorDescription: String? { message }
}

struct EntitySessionLaunchResult {
    let session: TaskSession?
    let error: EntityLaunchError?

    static func success(_ session: TaskSession) -> Self {
        Self(session: session, error: nil)
    }

    static func failure(message: String, code: String? = nil) -> Self {
        Self(session: nil, error: EntityLaunchError(message: message, code: code))
    }
}

struct EntityWorkItemRestoreResult {
    let workItem: WorkItem?
    let error: EntityLaunchError?

    static func success(_ workItem: WorkItem) -> Self {
        Self(workItem: workItem, error: nil)
    }

    static func failure(message: String, code: String? = nil) -> Self {
        Self(workItem: nil, error: EntityLaunchError(message: message, code: code))
    }
}

// Provider-neutral structured Memory. Optional lifecycle fields keep old server snapshots decodable.
struct MemoryItem: Identifiable, Codable, Hashable {
    let id: String
    let ownerType: String
    let ownerId: String
    let workItemId: String?
    let kind: String
    let content: String
    let sourceType: String
    let sourceSessionId: String?
    let sourceEventSequence: Int?
    let sourceEventSeqs: [Int]?
    let tags: [String]?
    let confidence: Double?
    let usageCount: Int?
    let lastAccessedAt: String?
    let promotionStatus: String?
    let promotedSkillId: String?
    let trustLevel: String?
    let expiresAt: String?
    let replacesMemoryId: String?
    let version: Int?
    let autoApplied: Bool?
    let appliedAt: String?
    let revokedAt: String?
    let createdAt: String
    let updatedAt: String?
}

enum WorkItemMemoryPresentationPolicy {
    static func shouldLoad(currentSessionId: String?) -> Bool {
        guard let currentSessionId else { return false }
        return !currentSessionId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// 后端响应 envelope：GET /memories?ownerType=&ownerId= → { memories: [...] }
struct MemoryListEnvelope: Codable {
    let memories: [MemoryItem]
}

struct MemoryEnvelope: Codable {
    let memory: MemoryItem
}

struct MemoryRecallAudit: Identifiable, Codable, Hashable {
    let id: String
    let sessionId: String?
    let phase: String
    let mode: String
    let reason: String
    let candidateIds: [String]
    let selectedIds: [String]
    let createdAt: String
}

struct MemoryRecallListEnvelope: Codable {
    let recalls: [MemoryRecallAudit]
}

struct MemoryAuditEntry: Identifiable, Codable, Hashable {
    let id: String
    let memoryId: String?
    let action: String
    let actorType: String
    let actorId: String?
    let reason: String?
    let rollbackOf: String?
    let createdAt: String
}

struct MemoryAuditListEnvelope: Codable {
    let audit: [MemoryAuditEntry]
}
