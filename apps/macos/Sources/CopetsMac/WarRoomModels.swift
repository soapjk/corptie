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
    var createdAt: String
    var updatedAt: String
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

// 后端响应 envelope：POST /sessions → { session: {...} }
struct SessionCreateEnvelope: Codable {
    let session: WorkItemSessionSummary
}

// 后端错误响应：{ error: String, code: String? }
struct EntityErrorEnvelope: Codable {
    let error: String
    let code: String?
}

// 执行/操作失败的结果（含错误码，供 UI 做针对性引导，如「未绑定仓库」给绑定入口）
struct EntityLaunchError {
    let message: String
    let code: String?
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
