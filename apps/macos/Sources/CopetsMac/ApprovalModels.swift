import SwiftUI

// 审批卡数据模型（03 §15.3 四级审批卡，净新增）。
// 四级风险定义见 09 敏感操作分级表；协作映射见 14；Skill 创建/晋升见 12/13。

enum RiskLevel: String, CaseIterable, Identifiable {
    case safe
    case moderate
    case high
    case dangerous

    var id: String { rawValue }

    // TODO(接 L10n)：等级文案后续接入 AppLanguage，第一版硬编码中文。
    var title: String {
        switch self {
        case .safe: "安全"
        case .moderate: "中等"
        case .high: "高风险"
        case .dangerous: "危险"
        }
    }

    // 等级色：safe 绿 / moderate 蓝 / high 橙 / dangerous 红（03 §15.3.2）
    var color: Color {
        switch self {
        case .safe: .green
        case .moderate: .blue
        case .high: .orange
        case .dangerous: .red
        }
    }

    // dangerous 带 ⚠ 图标（03 §15.3.2）
    var showsWarningIcon: Bool { self == .dangerous }
}

// 一次待审批动作（后端 event.session.approval_required 的前端形态）
struct ApprovalRequest: Identifiable {
    let id: String
    /// 动作名（如「git push」「rm -rf node_modules」）
    var action: String
    /// Agent 给出的「要做什么」方案摘要
    var proposal: String
    var riskLevel: RiskLevel
    /// 影响范围（文件清单 / 仓库 / Objective / 协作方）
    var affectedScope: [String]
    /// 风险说明（为什么需要这步）
    var rationale: String
    /// 审计溯源（来自哪个 Agent / Session#seq）
    var sourceLine: String
    /// dangerous 需二次确认（键入确认短语）
    var requiresSecondaryConfirm: Bool
    /// 二次确认短语（如「删除不可恢复」）
    var confirmPhrase: String?
}
