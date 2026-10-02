import Foundation

public struct ClientQuickMessage: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let text: String
    public let scope: String
    public let count: Int

    public init(id: String, text: String, scope: String, count: Int) {
        self.id = id; self.text = text; self.scope = scope; self.count = count
    }

    public static let defaults: [Self] = ["继续", "开始开发", "给我一个完整方案", "检查并运行测试"].map {
        Self(id: "default:\($0)", text: $0, scope: "default", count: 0)
    }
}

public struct ClientQuickMessageRecommendations: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let taskId: String?
    public let items: [ClientQuickMessage]
}
