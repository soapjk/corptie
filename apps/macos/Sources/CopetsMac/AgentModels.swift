import Foundation

// 通用 Agent 模型。Agent 是可复用的行为配置；Session 才是执行与授权上下文。
// 对齐后端 agents 表 + GET /agents 返回的 camelCase（见 corptieStore.agentFromRow）。
//
// 与协作专用 CollaborationAgent（Models.swift）不同：这里不区分 Assistant / Contributor。

struct Agent: Identifiable, Codable, Hashable {
    let agentId: String
    var agentKind: String? = nil
    var name: String
    var description: String
    var status: String
    var statusReason: String? = nil
    var systemPrompt: String
    var capabilities: [String]
    var workDir: String?
    var avatarPath: String?
    var skillIds: [String]?
    var suggestedSessionTitle: String? = nil
    var currentSessionId: String?
    var createdAt: String
    var updatedAt: String

    var id: String { agentId }

    var isPlatformAssistant: Bool { agentKind == "platformAssistant" || agentId == "assistant" }
}

// 后端响应 envelope：GET /agents → { agents: [...] }
struct AgentListEnvelope: Codable {
    let agents: [Agent]
}

// Skill（全局共享的 Skill 维护中心条目）。对齐后端 skills 表 + GET /skills 返回的 camelCase。
// local 源 → source 为本地绝对目录；git 源 → source 为仓库 URL、cachePath 为克隆缓存目录。
struct Skill: Identifiable, Codable, Hashable {
    let skillId: String
    var name: String
    var description: String
    var sourceType: String
    var source: String
    var sourceSubpath: String?
    var packageSubpath: String?
    var mcpDescriptorSubpath: String?
    var packageDiscoveryMethod: String?
    var cachePath: String?
    var manifestName: String?
    var manifestDescription: String?
    var contentHash: String?
    var installedAt: String
    var updatedAt: String

    var id: String { skillId }
    var isGit: Bool { sourceType == "git" }
    var sourceKindLocalizationKey: String { isGit ? "Git" : "Local" }
}

struct SkillCandidate: Codable, Hashable, Identifiable {
    let relativePath: String
    let packageRelativePath: String?
    let manifestName: String
    let manifestDescription: String
    let contentHash: String
    let composition: SkillPackageComposition?

    var id: String { relativePath.isEmpty ? manifestName : relativePath }
}

struct SkillPackageComposition: Codable, Hashable {
    let kind: String
    let package: SkillPackageMetadata?
    let mcp: SkillMCPComposition?
}

struct SkillPackageMetadata: Codable, Hashable {
    let discoveryMethod: String
    let manifest: String?
    let skillPath: String
    let assistance: SkillDiscoveryAssistance?
}

struct SkillDiscoveryAssistance: Codable, Hashable {
    let confidence: Double?
    let evidence: [String]
}

struct SkillMCPComposition: Codable, Hashable {
    let descriptor: String
    let serverNames: [String]
    let resources: [String]
}

struct SkillDiscoveryEnvelope: Codable {
    let sourceType: String
    let source: String
    let candidates: [SkillCandidate]
    let diagnostics: [SkillDiscoveryDiagnostic]?
}

struct SkillDiscoveryDiagnostic: Codable, Hashable, Identifiable {
    let relativePath: String
    let code: String
    let stage: String
    let message: String

    var id: String { "\(relativePath):\(code):\(message)" }
}

// 后端响应 envelope：GET /skills → { skills: [...] }
struct SkillListEnvelope: Codable {
    let skills: [Skill]
}

// POST /skills 响应 envelope
struct SkillEnvelope: Codable {
    let skill: Skill
}

struct SkillDeletionAffectedAgent: Codable, Hashable, Identifiable {
    let agentId: String
    let name: String
    var id: String { agentId }
}

struct SkillDeletionActiveSession: Codable, Hashable, Identifiable {
    let sessionId: String
    let title: String
    let status: String
    let agentId: String
    let agentName: String
    var id: String { sessionId }
}

struct SkillDeletionImpact: Codable, Hashable {
    let skillId: String
    let skillName: String
    let affectedAgents: [SkillDeletionAffectedAgent]
    let affectedAgentCount: Int
    let activeSessions: [SkillDeletionActiveSession]
    let activeSessionCount: Int
    let canDelete: Bool
    let policy: String
}

struct SkillDeletionImpactEnvelope: Codable {
    let impact: SkillDeletionImpact
}

struct SkillDeletionCleanupResult: Codable, Hashable {
    let kind: String
    let providerId: String?
    let path: String
    let status: String
    let error: String?
}

struct SkillDeletionOperation: Codable, Hashable {
    let operationId: String
    let skillId: String
    let skillName: String
    let status: String
    let cleanup: [SkillDeletionCleanupResult]
    let errorCode: String?
    let errorMessage: String?
}

struct SkillDeletionResultEnvelope: Codable {
    let ok: Bool
    let operation: SkillDeletionOperation
    let impact: SkillDeletionImpact
}

enum SkillDeletionConfirmationPolicy {
    static func canOfferDestructiveAction(for impact: SkillDeletionImpact) -> Bool {
        impact.canDelete && impact.activeSessionCount == 0
    }
}
