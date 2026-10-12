import Foundation

public struct TaskCreationDefaults: Codable, Equatable, Sendable {
    public var providerId: String?
    public var model: String?
    public var reasoningLevel: String?
    public init(providerId: String? = nil, model: String? = nil, reasoningLevel: String? = nil) {
        self.providerId = providerId; self.model = model; self.reasoningLevel = reasoningLevel
    }
}

public struct TaskCreationSettings: Decodable, Sendable {
    public struct Provider: Decodable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let available: Bool
        public let supportsModels: Bool
        public let supportsReasoning: Bool
    }
    public struct Model: Decodable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let reasoningLevels: [String]
        public let defaultReasoningLevel: String?
    }
    public let schemaVersion: Int
    public let readOnly: Bool?
    public let value: TaskCreationDefaults
    public let defaultProviderId: String?
    public let selectedProviderId: String?
    public let providers: [Provider]
    public let models: [Model]
    public let currentModel: String?
    public let currentReasoningLevel: String?
    public let modelError: String?
}
