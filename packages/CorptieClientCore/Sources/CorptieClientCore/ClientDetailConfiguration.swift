import Foundation

/// Public configuration values only; no credentials or Provider-specific UI.
public struct ClientDetailConfiguration: Equatable, Sendable {
    public enum Field: Equatable, Sendable { case provider, model, reasoning }
    public struct Choice: Equatable, Identifiable, Sendable {
        public let id: String
        public let title: String
        public let available: Bool
        public init(id: String, title: String, available: Bool = true) {
            self.id = id; self.title = title; self.available = available
        }
    }
    public struct Selection: Equatable, Sendable {
        public let id: String
        public let title: String
        public let choices: [Choice]
        public let canSelect: Bool
        public init(id: String, title: String, choices: [Choice], canSelect: Bool) {
            self.id = id; self.title = title; self.choices = choices; self.canSelect = canSelect
        }
    }
    public let provider: Selection
    public let model: Selection
    public let reasoning: Selection
    public let busy: Bool
    public let error: String?
    public init(provider: Selection, model: Selection, reasoning: Selection, busy: Bool = false, error: String? = nil) {
        self.provider = provider; self.model = model; self.reasoning = reasoning; self.busy = busy; self.error = error
    }
    public func selection(_ field: Field) -> Selection {
        switch field { case .provider: provider; case .model: model; case .reasoning: reasoning }
    }
}

public enum ClientDetailConfigurationFailure: LocalizedError {
    case unavailable, unconfirmed(String)
    public var errorDescription: String? {
        switch self {
        case .unavailable: "当前会话或配置能力已变化，未发送操作"
        case .unconfirmed(let message): message
        }
    }
}
