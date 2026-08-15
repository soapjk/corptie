import Foundation

// 通用 Agent 模型（15 Phase 5 浮球绑 Agent 的前置地基，净新增）。
// 对齐后端 agents 表 + GET /agents 返回的 camelCase（见 corptieStore.agentFromRow）。
//
// 与协作专用 CollaborationAgent（Models.swift）不同：这是设计里的「通用角色化执行主体」，
// 带 role（assistant 助手 / independentContributor 独立贡献者），浮球据此绑定 Agent 身份。

struct Agent: Identifiable, Codable, Hashable {
    let agentId: String
    var name: String
    var description: String
    var role: String
    var status: String
    var provider: String?
    var systemPrompt: String
    var capabilities: [String]
    var currentSessionId: String?
    var createdAt: String
    var updatedAt: String

    var id: String { agentId }

    // role 语义（容错：未知值视为普通独立贡献者）
    var isAssistant: Bool { role == "assistant" }
    var isIndependentContributor: Bool { role != "assistant" }
}

// 后端响应 envelope：GET /agents → { agents: [...] }
struct AgentListEnvelope: Codable {
    let agents: [Agent]
}
