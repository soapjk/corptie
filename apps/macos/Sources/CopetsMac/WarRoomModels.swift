import Foundation

// 控制台数据模型（15 Phase 5 净新增）。
// 独立于现有 Models.swift 巨石，对齐后端 entityHttpApi 返回的 snake_case JSON
// （Objective/WorkItem 字段名，见后端 corptieStore 的 objectives / work_items 表）。

struct Objective: Identifiable, Codable, Hashable {
    let id: String
    var name: String
    var description: String
    var acceptanceCriteria: String
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
    var createdAt: String
    var updatedAt: String
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

    // 后端 status 字符串 → 看板列（容错：未知值归「待开始」；评审归入「进行中」）
    static func column(for status: String) -> WorkItemColumn {
        switch status {
        case "todo", "pending", "ready": .todo
        case "in_progress", "doing", "running", "review", "reviewing": .inProgress
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

// 后端响应 envelope：GET /work-items/:id/sessions → { sessions: [...] }
struct WorkItemSessionListEnvelope: Codable {
    let sessions: [WorkItemSessionSummary]
}

// 后端响应 envelope：POST /sessions / POST /agents/:id/sessions → { session: TaskSession }
struct SessionCreateEnvelope: Codable {
    let session: TaskSession
}

// 后端错误响应：关联校验失败时同时返回稳定 code、field 与 expected。
struct EntityErrorEnvelope: Codable {
    let error: String
    let code: String?
    let field: String?
    let expected: String?

    var displayMessage: String {
        guard let field, let expected else { return error }
        return "\(error)（字段：\(field)，期望：\(expected)）"
    }
}

// 执行/操作失败的结果（含错误码，供 UI 做针对性引导，如「未绑定仓库」给绑定入口）
struct EntityLaunchError: Error {
    let message: String
    let code: String?
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

// 记忆（work_item 级记忆，跨执行上下文载体；对齐后端 memories 表 snake_case 字段）
struct MemoryItem: Identifiable, Codable, Hashable {
    let id: String
    let ownerType: String
    let ownerId: String
    let kind: String
    let content: String
    let sourceType: String
    let createdAt: String
}

// 后端响应 envelope：GET /memories?ownerType=&ownerId= → { memories: [...] }
struct MemoryListEnvelope: Codable {
    let memories: [MemoryItem]
}
