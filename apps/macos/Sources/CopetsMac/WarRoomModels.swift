import Foundation
import CryptoKit

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

struct StartupBindingReceipt: Codable, Hashable {
    let schemaVersion: Int
    let status: String
    let startupOperationId: String
    let objectiveId: String
    let workItemId: String
    let logicalSessionId: String
    let repositoryId: String
    let worktreeId: String
    let canonicalWorktreePath: String
    let headIdentity: StartupHeadIdentity
    let providerBindingId: String
    let bindingGeneration: Int
    let sourceCommitOid: String
    let sourceTreeOid: String
    let baseRef: String?
    let repositoryInventoryVersion: String
    let workspaceResourceVersion: Int
    let resourceVersion: Int
    let providerContextHash: String
    let phaseTimestamps: StartupPhaseTimestamps
    let compensation: StartupCompensation
    let error: String?
    let receiptHash: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case schemaVersion, status, startupOperationId, objectiveId, workItemId, logicalSessionId
        case repositoryId, worktreeId, canonicalWorktreePath, headIdentity, providerBindingId
        case bindingGeneration, sourceCommitOid, sourceTreeOid, baseRef, repositoryInventoryVersion
        case workspaceResourceVersion, resourceVersion, providerContextHash, phaseTimestamps
        case compensation, error, receiptHash
    }

    init(from decoder: Decoder) throws {
        try rejectUnknownStartupKeys(decoder, allowed: Set(CodingKeys.allCases.map(\.rawValue)), context: "StartupBindingReceipt")
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        status = try container.decode(String.self, forKey: .status)
        guard schemaVersion == 2, status == "ready" else {
            throw DecodingError.dataCorruptedError(
                forKey: .status, in: container,
                debugDescription: "Unsupported StartupBindingReceipt schema/status"
            )
        }
        startupOperationId = try container.decode(String.self, forKey: .startupOperationId)
        objectiveId = try container.decode(String.self, forKey: .objectiveId)
        workItemId = try container.decode(String.self, forKey: .workItemId)
        logicalSessionId = try container.decode(String.self, forKey: .logicalSessionId)
        repositoryId = try container.decode(String.self, forKey: .repositoryId)
        worktreeId = try container.decode(String.self, forKey: .worktreeId)
        canonicalWorktreePath = try container.decode(String.self, forKey: .canonicalWorktreePath)
        headIdentity = try container.decode(StartupHeadIdentity.self, forKey: .headIdentity)
        providerBindingId = try container.decode(String.self, forKey: .providerBindingId)
        bindingGeneration = try container.decode(Int.self, forKey: .bindingGeneration)
        sourceCommitOid = try container.decode(String.self, forKey: .sourceCommitOid)
        sourceTreeOid = try container.decode(String.self, forKey: .sourceTreeOid)
        guard container.contains(.baseRef), container.contains(.error) else {
            throw DecodingError.keyNotFound(
                container.contains(.baseRef) ? CodingKeys.error : CodingKeys.baseRef,
                .init(codingPath: decoder.codingPath, debugDescription: "StartupBindingReceipt nullable fields must be present")
            )
        }
        baseRef = try container.decodeIfPresent(String.self, forKey: .baseRef)
        repositoryInventoryVersion = try container.decode(String.self, forKey: .repositoryInventoryVersion)
        workspaceResourceVersion = try container.decode(Int.self, forKey: .workspaceResourceVersion)
        resourceVersion = try container.decode(Int.self, forKey: .resourceVersion)
        providerContextHash = try container.decode(String.self, forKey: .providerContextHash)
        phaseTimestamps = try container.decode(StartupPhaseTimestamps.self, forKey: .phaseTimestamps)
        compensation = try container.decode(StartupCompensation.self, forKey: .compensation)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        receiptHash = try container.decode(String.self, forKey: .receiptHash)
        guard error == nil, bindingGeneration > 0, workspaceResourceVersion > 0, resourceVersion > 0,
              startupOperationId.hasPrefix("startup:"), objectiveId.hasPrefix("objective:"),
              workItemId.hasPrefix("work_item:"), repositoryId.hasPrefix("repository:"),
              worktreeId.hasPrefix("worktree:"), providerBindingId.hasPrefix("startup-binding:"),
              logicalSessionId.hasPrefix("session:") || logicalSessionId.hasPrefix("logical:"),
              canonicalWorktreePath.hasPrefix("/"),
              sourceCommitOid.range(of: #"^[0-9a-f]{40,64}$"#, options: .regularExpression) != nil,
              sourceTreeOid.range(of: #"^[0-9a-f]{40,64}$"#, options: .regularExpression) != nil,
              providerContextHash.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil,
              receiptHash.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
            throw DecodingError.dataCorruptedError(
                forKey: .receiptHash, in: container,
                debugDescription: "StartupBindingReceipt required identity fields are invalid"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(status, forKey: .status)
        try container.encode(startupOperationId, forKey: .startupOperationId)
        try container.encode(objectiveId, forKey: .objectiveId)
        try container.encode(workItemId, forKey: .workItemId)
        try container.encode(logicalSessionId, forKey: .logicalSessionId)
        try container.encode(repositoryId, forKey: .repositoryId)
        try container.encode(worktreeId, forKey: .worktreeId)
        try container.encode(canonicalWorktreePath, forKey: .canonicalWorktreePath)
        try container.encode(headIdentity, forKey: .headIdentity)
        try container.encode(providerBindingId, forKey: .providerBindingId)
        try container.encode(bindingGeneration, forKey: .bindingGeneration)
        try container.encode(sourceCommitOid, forKey: .sourceCommitOid)
        try container.encode(sourceTreeOid, forKey: .sourceTreeOid)
        if let baseRef { try container.encode(baseRef, forKey: .baseRef) }
        else { try container.encodeNil(forKey: .baseRef) }
        try container.encode(repositoryInventoryVersion, forKey: .repositoryInventoryVersion)
        try container.encode(workspaceResourceVersion, forKey: .workspaceResourceVersion)
        try container.encode(resourceVersion, forKey: .resourceVersion)
        try container.encode(providerContextHash, forKey: .providerContextHash)
        try container.encode(phaseTimestamps, forKey: .phaseTimestamps)
        try container.encode(compensation, forKey: .compensation)
        if let receiptError = error { try container.encode(receiptError, forKey: .error) }
        else { try container.encodeNil(forKey: .error) }
        try container.encode(receiptHash, forKey: .receiptHash)
    }

    func hasValidHash() -> Bool {
        guard let encoded = try? JSONEncoder().encode(self),
              let decoded = try? JSONSerialization.jsonObject(with: encoded),
              var object = decoded as? [String: Any] else { return false }
        object.removeValue(forKey: "receiptHash")
        guard let canonical = try? JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys, .withoutEscapingSlashes]
        ) else { return false }
        return SHA256.hash(data: canonical).map { String(format: "%02x", $0) }.joined() == receiptHash
    }
}

enum StartupHeadIdentity: Codable, Hashable {
    case branch(String)
    case detached(String)

    private enum CodingKeys: String, CodingKey { case kind, branch, commitOid }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "branch":
            try rejectUnknownStartupKeys(decoder, allowed: ["kind", "branch"], context: "StartupHeadIdentity.branch")
            let branch = try container.decode(String.self, forKey: .branch)
            guard !branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw DecodingError.dataCorruptedError(forKey: .branch, in: container, debugDescription: "Branch identity is empty")
            }
            self = .branch(branch)
        case "detached":
            try rejectUnknownStartupKeys(decoder, allowed: ["kind", "commitOid"], context: "StartupHeadIdentity.detached")
            let commitOid = try container.decode(String.self, forKey: .commitOid)
            guard commitOid.range(of: #"^[0-9a-f]{40,64}$"#, options: .regularExpression) != nil else {
                throw DecodingError.dataCorruptedError(forKey: .commitOid, in: container, debugDescription: "Detached identity OID is invalid")
            }
            self = .detached(commitOid)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: container, debugDescription: "Unknown Startup head identity kind"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .branch(let branch):
            try container.encode("branch", forKey: .kind)
            try container.encode(branch, forKey: .branch)
        case .detached(let commitOid):
            try container.encode("detached", forKey: .kind)
            try container.encode(commitOid, forKey: .commitOid)
        }
    }
}

struct StartupPhaseTimestamps: Codable, Hashable {
    let allocatedAt: String
    let worktreePreparedAt: String
    let sessionBoundAt: String
    let providerBoundAt: String
    let readyAt: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case allocatedAt, worktreePreparedAt, sessionBoundAt, providerBoundAt, readyAt
    }

    init(from decoder: Decoder) throws {
        try rejectUnknownStartupKeys(decoder, allowed: Set(CodingKeys.allCases.map(\.rawValue)), context: "StartupPhaseTimestamps")
        let container = try decoder.container(keyedBy: CodingKeys.self)
        allocatedAt = try container.decode(String.self, forKey: .allocatedAt)
        worktreePreparedAt = try container.decode(String.self, forKey: .worktreePreparedAt)
        sessionBoundAt = try container.decode(String.self, forKey: .sessionBoundAt)
        providerBoundAt = try container.decode(String.self, forKey: .providerBoundAt)
        readyAt = try container.decode(String.self, forKey: .readyAt)
    }
}

struct StartupCompensation: Codable, Hashable {
    let attempted: Bool
    let result: String
    let completedSteps: [String]
    let failedStep: String?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case attempted, result, completedSteps, failedStep
    }

    init(from decoder: Decoder) throws {
        try rejectUnknownStartupKeys(decoder, allowed: Set(CodingKeys.allCases.map(\.rawValue)), context: "StartupCompensation")
        let container = try decoder.container(keyedBy: CodingKeys.self)
        attempted = try container.decode(Bool.self, forKey: .attempted)
        result = try container.decode(String.self, forKey: .result)
        guard ["not_required", "completed", "manual_required"].contains(result) else {
            throw DecodingError.dataCorruptedError(
                forKey: .result, in: container, debugDescription: "Unknown startup compensation result"
            )
        }
        completedSteps = try container.decode([String].self, forKey: .completedSteps)
        guard container.contains(.failedStep) else {
            throw DecodingError.keyNotFound(CodingKeys.failedStep, .init(codingPath: decoder.codingPath, debugDescription: "failedStep must be present"))
        }
        failedStep = try container.decodeIfPresent(String.self, forKey: .failedStep)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(attempted, forKey: .attempted)
        try container.encode(result, forKey: .result)
        try container.encode(completedSteps, forKey: .completedSteps)
        if let failedStep { try container.encode(failedStep, forKey: .failedStep) }
        else { try container.encodeNil(forKey: .failedStep) }
    }
}

struct WorkItemStartupReady: Codable {
    let status: String
    let idempotentReplay: Bool
    let receipt: StartupBindingReceipt

    init(from decoder: Decoder) throws {
        try rejectUnknownStartupKeys(decoder, allowed: ["status", "idempotentReplay", "receipt"], context: "WorkItemStartupReady")
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(String.self, forKey: .status)
        guard status == "ready" else {
            throw DecodingError.dataCorruptedError(forKey: .status, in: container, debugDescription: "Startup is not ready")
        }
        idempotentReplay = try container.decode(Bool.self, forKey: .idempotentReplay)
        receipt = try container.decode(StartupBindingReceipt.self, forKey: .receipt)
        guard receipt.hasValidHash() else {
            throw DecodingError.dataCorruptedError(forKey: .receipt, in: container, debugDescription: "Startup receipt hash mismatch")
        }
    }
}

private struct StartupAnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

private func rejectUnknownStartupKeys(
    _ decoder: Decoder,
    allowed: Set<String>,
    context: String
) throws {
    let keys = try decoder.container(keyedBy: StartupAnyCodingKey.self).allKeys.map(\.stringValue)
    let unknown = Set(keys).subtracting(allowed)
    guard unknown.isEmpty else {
        throw DecodingError.dataCorrupted(
            .init(codingPath: decoder.codingPath, debugDescription: "Unknown \(context) fields: \(unknown.sorted().joined(separator: ", "))")
        )
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

struct WorkSessionCreateEnvelope: Codable {
    let session: TaskSession
    let start: WorkItemStartupReady
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
