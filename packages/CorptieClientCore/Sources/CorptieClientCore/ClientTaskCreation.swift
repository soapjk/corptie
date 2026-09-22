import Foundation

public struct ClientTaskCreation: Codable, Sendable {
    public let requestId: String
    public let workId: String
    public let title: String
    public let mainAgentId: String
    public let providerId: String
    public var description: String?
    public var acceptanceCriteria: String?
    public var verificationCriteria: String?
    public var priority: String?
    public var model: String?
    public var reasoningLevel: String?

    public init(requestId: String, workId: String, title: String, mainAgentId: String, providerId: String) {
        self.requestId = requestId
        self.workId = workId
        self.title = title
        self.mainAgentId = mainAgentId
        self.providerId = providerId
    }
}

public struct ClientTaskCreationResult: Codable, Sendable, Equatable {
    public let taskId: String
    public let sessionId: String
    public let workId: String
}

public struct ClientTaskCreationOptions: Decodable, Sendable {
    public struct Resource: Decodable, Sendable, Identifiable {
        public let id: String
        public let name: String
    }
    public struct Provider: Decodable, Sendable, Identifiable {
        public let id: String
        public let name: String
        public let available: Bool
        public let reason: String?
        public let supportsModels: Bool
    }
    public let schemaVersion: Int
    public let sourceSessionId: String
    public let work: Resource
    public let agents: [Resource]
    public let providers: [Provider]
    public let providerId: String?
    public let defaultProviderId: String?
    public let models: [ClientComposerConfiguration.Model]
    public let currentModel: String?
    public let currentReasoningLevel: String?
    public let priorities: [String]
}
