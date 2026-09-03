import Foundation
import CryptoKit

// 统一控制台数据模型，对齐后端 entityHttpApi 的 canonical camelCase DTO。

struct Work: Identifiable, Codable, Hashable {
    let id: String
    let workspaceId: String
    var name: String
    var description: String
    var avatarPath: String? = nil
    var status: String
    var profile: String
    var tags: [String]
    var contributorAgentIds: [String]
    var primaryAgentId: String? = nil
    var createdAt: String
    var updatedAt: String
}

// 挂靠资源：Git 仓库（Work 涉及修改的 Workspace）
struct GitRepository: Identifiable, Codable, Hashable {
    let id: String
    let workspaceId: String
    let path: String
    let name: String
    var discoveredAt: String?
    var lastValidatedAt: String?
}

struct WorkspaceResource: Identifiable, Codable, Hashable {
    let workspaceId: String
    let kind: String
    let ownership: String
    let rootPath: String
    let canonicalRootPath: String
    let status: String
    var createdAt: String?
    var updatedAt: String?

    var id: String { workspaceId }
}

struct WorkspaceRegistrationEnvelope: Decodable, Hashable {
    let workspace: WorkspaceResource
    let repository: GitRepository?
    let gitCapability: String
}

struct WorkspaceListEnvelope: Decodable {
    let workspaces: [WorkspaceResource]
}

func repositoryIDs(for work: Work?, in repositories: [GitRepository]) -> [String] {
    guard let work else { return [] }
    return repositories.filter { $0.workspaceId == work.workspaceId }.map(\.id)
}

struct CorptieTask: Identifiable, Codable, Hashable {
    let id: String
    var workId: String
    var title: String
    var description: String
    var goal: String = ""
    var acceptanceCriteria: String
    var verificationCriteria: String = ""
    var priority: String
    var lifecycleState: String
    var mainAgentId: String?
    var currentSessionId: String?
    var executionStatus: String?
    var acceptanceAssessment: CorptieTaskAcceptanceAssessment?
    var completionSuggestion: CorptieTaskCompletionSuggestion?
    var completionSource: CorptieTaskCompletionSource? = nil
    var creationOrigin: CorptieTaskCreationOrigin? = nil
    var resourceVersion: Int = 1
    var currentSnapshotId: String? = nil
    var revision: Int = 1
    var createdAt: String
    var updatedAt: String
}

struct CorptieTaskSnapshot: Identifiable, Codable, Hashable {
    let id: String
    let taskId: String
    let version: Int
    let title: String
    let description: String
    let goal: String
    let acceptanceCriteria: String
    let verificationCriteria: String
    let acceptanceAssessment: CorptieTaskAcceptanceAssessment?
    let completionEvidence: [CorptieTaskAcceptanceEvidence]
    let executionSummary: String
    let sourceMessageId: String?
    let createdBySessionId: String
    let contentHash: String
    let createdAt: String
}

struct CorptieTaskSnapshotListEnvelope: Codable {
    let snapshots: [CorptieTaskSnapshot]
}

struct CorptieTaskRevisionEnvelope: Codable {
    let task: CorptieTask
    let snapshot: CorptieTaskSnapshot
}

struct CorptieTaskCreationOrigin: Codable, Hashable {
    let taskId: String
    let originType: String
    let creatorSessionId: String?
    let creationContextTaskId: String?
    let creationContextMessageId: String?
    let operationId: String?
    let createdAt: String
}

struct CorptieTaskCompletionSource: Codable, Hashable {
    let sourceType: String
    let operationId: String?
    let completedAt: String?
}

struct CorptieTaskCompletionIntentReceipt: Codable, Hashable {
    let receiptId: String
    let intentToken: String
    let taskId: String
    let workId: String
    let interactionId: String
    let uiSurface: String
    let issuedAt: String
    let expiresAt: String
    let purpose: String
}

struct CorptieTaskCompletionOperation: Codable, Hashable {
    let operationId: String
    let taskId: String
    let workId: String
    let result: String
    let sourceType: String
    let requestId: String
    let idempotencyKey: String
    let errorCode: String?
    let createdAt: String
}

struct CorptieTaskCompletionEnvelope: Codable {
    let task: CorptieTask
    let operation: CorptieTaskCompletionOperation
    let idempotentReplay: Bool
}

/// Immutable payload captured at the user's click. Background retry owns this
/// value and never re-derives a target from navigation or current selection.
struct CorptieTaskCompletionSubmission: Equatable {
    let taskId: String
    let workId: String
    let displayedTitle: String
    let receipt: CorptieTaskCompletionIntentReceipt
    let requestId: String
    let idempotencyKey: String

    static func freeze(
        task: CorptieTask,
        receipt: CorptieTaskCompletionIntentReceipt,
        requestId: String,
        idempotencyKey: String
    ) -> CorptieTaskCompletionSubmission? {
        guard receipt.taskId == task.id,
              receipt.workId == task.workId,
              !requestId.isEmpty,
              !idempotencyKey.isEmpty else { return nil }
        return CorptieTaskCompletionSubmission(
            taskId: task.id,
            workId: task.workId,
            displayedTitle: task.title,
            receipt: receipt,
            requestId: requestId,
            idempotencyKey: idempotencyKey
        )
    }
}

struct CorptieTaskAcceptanceEvidence: Codable, Hashable {
    let summary: String
    let reference: String
}

struct CorptieTaskAcceptanceResult: Codable, Hashable {
    let criterion: String
    let verdict: String
    let evidence: [CorptieTaskAcceptanceEvidence]
}

struct CorptieTaskAcceptanceAssessment: Codable, Hashable {
    let status: String
    let criteriaSnapshot: String
    let sourceSessionId: String
    let assessedAt: String
    let results: [CorptieTaskAcceptanceResult]
}

struct CorptieTaskCompletionSuggestion: Codable, Hashable {
    let recommended: Bool
    let sourceSessionId: String
    let assessedAt: String
    let criteriaSnapshot: String
    let results: [CorptieTaskAcceptanceResult]
}

struct CorptieTaskRetiredWorkspace: Codable, Hashable {
    let worktreeId: String
    let path: String
    let retiredAt: String
}

struct CorptieTaskWorktreeStatus: Decodable, Equatable {
    let status: String
    let sessionId: String?
    let repositoryId: String?
    let worktree: ProjectWorktreeStatus?
    let canReclaim: Bool
    let blocker: String?
    let detail: String?
    let retiredWorkspace: CorptieTaskRetiredWorkspace?
}

struct CorptieTaskDeletionRisk: Codable, Equatable, Identifiable {
    var id: String { code }
    let code: String
    let message: String
    let files: [String]?
    let commitCount: Int?
}

struct CorptieTaskDeletionWorktree: Codable, Equatable {
    let worktreeId: String
    let path: String
    let branchName: String?
    let isMain: Bool
    let dirty: Bool
    let mergedIntoMain: Bool
    let aheadOfMain: Int
}

struct CorptieTaskDeletionArtifact: Codable, Equatable, Identifiable {
    var id: String { artifactId }
    let artifactId: String
    let title: String
    let visibility: String?
    let status: String?
}

enum CorptieTaskArtifactDisposition: String, CaseIterable, Identifiable {
    case delete
    case work
    case retain

    var id: String { rawValue }
}

struct CorptieTaskDeletionPlan: Codable, Equatable {
    let taskId: String
    let status: String
    let retryable: Bool
    let associatedSessionCount: Int
    let artifacts: [CorptieTaskDeletionArtifact]?
    let worktree: CorptieTaskDeletionWorktree?
    let risks: [CorptieTaskDeletionRisk]
    let blockers: [CorptieTaskDeletionRisk]
}

struct CorptieTaskDeletionResult: Decodable {
    let ok: Bool
    let taskId: String
}

// 后端响应 envelope：GET /works → { works: [...] }；GET /tasks → { tasks: [...] }
struct WorkListEnvelope: Codable {
    let works: [Work]
}

struct CorptieTaskListEnvelope: Codable {
    let tasks: [CorptieTask]
    let hasMore: Bool?
    let nextCursor: String?
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
enum CorptieTaskColumn: String, CaseIterable, Identifiable {
    case todo
    case inProgress
    case done

    var id: String { rawValue }

    @MainActor var title: String {
        switch self {
        case .todo: L10n("Preparing")
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

    // 后端 status 字符串 → 看板列（容错：未知值归「准备中」）
    static func column(for status: String) -> CorptieTaskColumn {
        switch status {
        case "todo", "pending", "ready": .todo
        case "in_progress", "doing", "running": .inProgress
        case "done", "complete", "completed": .done
        default: .todo
        }
    }
}

// CorptieTask 名下的 Session 轻量摘要（模块 F 下钻列表；避免 TaskSession 复杂解码）
struct CorptieTaskSessionSummary: Identifiable, Codable, Hashable {
    let id: String
    let title: String
    let status: String
    let updatedAt: String
}

enum CorptieTaskExecutionPresentation {
    @MainActor
    static func label(executionStatus: String?, sessionStatus: String?) -> String {
        switch sessionStatus ?? executionStatus {
        case "running": L10n("Running")
        case "blocked": L10n("Waiting for Input")
        case "completed", "complete", "done": L10n("Complete")
        case "failed", "start_failed": L10n("Failed to Start")
        case "paused": L10n("Paused")
        case "cancelled", "canceled": L10n("Interrupted")
        case "idle", nil: L10n("Preparing")
        default: L10n("Unknown")
        }
    }
}

struct StartupBindingReceipt: Codable, Hashable {
    let schemaVersion: Int
    let status: String
    let startupOperationId: String
    let workId: String
    let taskId: String
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
    let toolContractHash: String
    let instructionSourcesHash: String
    let phaseTimestamps: StartupPhaseTimestamps
    let compensation: StartupCompensation
    let error: String?
    let receiptHash: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case schemaVersion, status, startupOperationId, workId, taskId, logicalSessionId
        case repositoryId, worktreeId, canonicalWorktreePath, headIdentity, providerBindingId
        case bindingGeneration, sourceCommitOid, sourceTreeOid, baseRef, repositoryInventoryVersion
        case workspaceResourceVersion, resourceVersion, providerContextHash, toolContractHash
        case instructionSourcesHash, phaseTimestamps
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
        workId = try container.decode(String.self, forKey: .workId)
        taskId = try container.decode(String.self, forKey: .taskId)
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
        toolContractHash = try container.decode(String.self, forKey: .toolContractHash)
        instructionSourcesHash = try container.decode(String.self, forKey: .instructionSourcesHash)
        phaseTimestamps = try container.decode(StartupPhaseTimestamps.self, forKey: .phaseTimestamps)
        compensation = try container.decode(StartupCompensation.self, forKey: .compensation)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        receiptHash = try container.decode(String.self, forKey: .receiptHash)
        guard error == nil, bindingGeneration > 0, workspaceResourceVersion > 0, resourceVersion > 0,
              startupOperationId.hasPrefix("startup:"), workId.hasPrefix("work:"),
              taskId.hasPrefix("task:"), repositoryId.hasPrefix("repository:"),
              worktreeId.hasPrefix("worktree:"), providerBindingId.hasPrefix("startup-binding:"),
              logicalSessionId.hasPrefix("session:") || logicalSessionId.hasPrefix("logical:"),
              canonicalWorktreePath.hasPrefix("/"),
              sourceCommitOid.range(of: #"^[0-9a-f]{40,64}$"#, options: .regularExpression) != nil,
              sourceTreeOid.range(of: #"^[0-9a-f]{40,64}$"#, options: .regularExpression) != nil,
              providerContextHash.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil,
              toolContractHash.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil,
              instructionSourcesHash.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil,
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
        try container.encode(workId, forKey: .workId)
        try container.encode(taskId, forKey: .taskId)
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
        try container.encode(toolContractHash, forKey: .toolContractHash)
        try container.encode(instructionSourcesHash, forKey: .instructionSourcesHash)
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

struct CorptieTaskStartupReady: Codable {
    let status: String
    let idempotentReplay: Bool
    let receipt: StartupBindingReceipt

    init(from decoder: Decoder) throws {
        try rejectUnknownStartupKeys(decoder, allowed: ["status", "idempotentReplay", "receipt"], context: "CorptieTaskStartupReady")
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

/// Shared macOS projection of the authoritative WorkSessionStartCommand.
/// Task startup callers must provide a source logical Session; Agent is only
/// the assignee resource and never the actor.
struct WorkSessionStartRequest: Codable, Equatable {
    let taskId: String
    let assigneeAgentId: String
    let expectedTaskVersion: Int
    let providerId: String
    let title: String?
    let idempotencyKey: String
    let sourceSessionId: String
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

// 后端响应 envelope：GET /tasks/:id/sessions → { sessions: [...] }
struct CorptieTaskSessionListEnvelope: Codable {
    let sessions: [CorptieTaskSessionSummary]
}

// 后端响应 envelope：POST /sessions / POST /agents/:id/sessions → { session: TaskSession }
struct SessionCreateEnvelope: Codable {
    let session: TaskSession
}

struct WorkSessionCreateEnvelope: Codable {
    let session: TaskSession
    let start: CorptieTaskStartupReady
}

struct CorptieTaskRestoreEnvelope: Decodable {
    let task: CorptieTask
}

// 后端错误响应：关联校验失败时同时返回稳定 code、field 与 expected。
struct EntityErrorEnvelope: Codable {
    let error: String
    let code: String?
    let field: String?
    let expected: String?
    let deletion: CorptieTaskDeletionPlan?

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

enum WorkspaceRegistrationResult {
    case success(WorkspaceRegistrationEnvelope)
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

struct EntityCorptieTaskRestoreResult {
    let task: CorptieTask?
    let error: EntityLaunchError?

    static func success(_ task: CorptieTask) -> Self {
        Self(task: task, error: nil)
    }

    static func failure(message: String, code: String? = nil) -> Self {
        Self(task: nil, error: EntityLaunchError(message: message, code: code))
    }
}

// Provider-neutral structured Memory. Optional lifecycle fields keep old server snapshots decodable.
struct MemoryItem: Identifiable, Codable, Hashable {
    let id: String
    let ownerType: String
    let ownerId: String
    let taskId: String?
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

enum CorptieTaskMemoryPresentationPolicy {
    static func shouldLoad(currentSessionId: String?) -> Bool {
        guard let currentSessionId else { return false }
        return !currentSessionId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// 后端响应 envelope：GET /memories?ownerType=&ownerId= → { memories: [...] }
struct MemoryListEnvelope: Codable {
    let memories: [MemoryItem]
    let hasMore: Bool?
    let nextCursor: String?
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
