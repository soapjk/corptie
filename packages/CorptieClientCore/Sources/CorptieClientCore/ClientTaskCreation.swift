import Foundation

public struct ClientTaskCreation: Codable, Sendable {
    public let requestId: String
    public let workId: String
    public let title: String
    public let mainRoleId: String
    public let providerId: String
    public var priority: String?
    public var model: String?
    public var reasoningLevel: String?
    public var parentTaskId: String?
    public var expectedParentResourceVersion: Int?

    // Decode legacy requests, but new requests never use the parent's general
    // resource revision as a creation precondition.
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(requestId, forKey: .requestId)
        try values.encode(workId, forKey: .workId)
        try values.encode(title, forKey: .title)
        try values.encode(mainRoleId, forKey: .mainRoleId)
        try values.encode(providerId, forKey: .providerId)
        try values.encodeIfPresent(priority, forKey: .priority)
        try values.encodeIfPresent(model, forKey: .model)
        try values.encodeIfPresent(reasoningLevel, forKey: .reasoningLevel)
        try values.encodeIfPresent(parentTaskId, forKey: .parentTaskId)
    }

    public init(requestId: String, workId: String, title: String, mainRoleId: String, providerId: String) {
        self.requestId = requestId
        self.workId = workId
        self.title = title
        self.mainRoleId = mainRoleId
        self.providerId = providerId
    }
    // Legacy transport names remain stable; business code uses Role.
    enum CodingKeys: String, CodingKey {
        case requestId
        case workId
        case title
        case mainRoleId = "mainAgentId"
        case providerId
        case priority
        case model
        case reasoningLevel
        case parentTaskId
        case expectedParentResourceVersion
    }
}

public struct ClientTaskCreationResult: Codable, Sendable, Equatable {
    public let taskId: String
    public let sessionId: String
    public let workId: String
    public var startupOperationId: String?
    public init(taskId: String, sessionId: String, workId: String, startupOperationId: String? = nil) {
        self.taskId = taskId; self.sessionId = sessionId; self.workId = workId
        self.startupOperationId = startupOperationId
    }
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
    public let roles: [Resource]
    public let providers: [Provider]
    public let providerId: String?
    public let defaultProviderId: String?
    public let models: [ClientComposerConfiguration.Model]
    public let currentModel: String?
    public let currentReasoningLevel: String?
    public let priorities: [String]
    public let taskHierarchyCapabilities: TaskHierarchyCapabilities?
    // Legacy transport names remain stable; business code uses Role.
    enum CodingKeys: String, CodingKey {
        case schemaVersion
        case sourceSessionId
        case work
        case roles = "agents"
        case providers
        case providerId
        case defaultProviderId
        case models
        case currentModel
        case currentReasoningLevel
        case priorities
        case taskHierarchyCapabilities
    }
}
