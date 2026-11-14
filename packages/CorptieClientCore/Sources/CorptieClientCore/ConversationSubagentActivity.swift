import Foundation

public struct ConversationSubagentActivity: Codable, Hashable, Sendable {
    public let schemaVersion: Int
    public let activityId: String
    public let childId: String
    public let name: String
    public let event: String
    public let status: String
}

public struct ConversationSubagentSummary: Hashable, Sendable {
    public let childId: String
    public let name: String
    public var activities: [ConversationSubagentActivity]
    public var latest: ConversationSubagentActivity { activities[activities.count - 1] }
    public func text(languageCode: String) -> String {
        let zh = languageCode.lowercased().hasPrefix("zh")
        let labels = zh ? ["started": "已启动", "interacted": "已发送后续指令", "completed": "已完成", "unknown": "状态待确认"]
            : ["started": "Started", "interacted": "Follow-up sent", "completed": "Completed", "unknown": "Status unconfirmed"]
        return activities.map { labels[$0.event] ?? labels["unknown"]! }.joined(separator: " → ")
    }
}
