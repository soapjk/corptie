import Foundation

/// Syntax only: the backend catalog and Session capability checks remain authoritative.
/// Unknown command names must reach command validation, never ordinary chat.
public struct ClientConversationCommand: Encodable, Sendable, Equatable {
    public let name: String
    public let arguments: String

    public static func parse(_ text: String) -> Self? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let match = text.range(of: #"^/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$"#,
                                     options: [.regularExpression, .caseInsensitive]),
              match == text.startIndex..<text.endIndex else { return nil }
        let body = text.dropFirst()
        let separator = body.firstIndex(where: { $0.isWhitespace }) ?? body.endIndex
        return Self(name: String(body[..<separator]).lowercased(),
                    arguments: String(body[separator...]).trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

public struct ClientConversationCommandCatalog: Decodable, Sendable {
    public struct Command: Decodable, Sendable, Identifiable {
        public var id: String { name }
        public let name: String
        public let usage: String
        public let summary: String
        public let available: Bool
        public let reason: String?
        public let requiresConfirmation: Bool
        /// A hint for argument-bearing commands, not authority to execute.
        public let canMutate: Bool
    }
    public let schemaVersion: Int
    public let sessionId: String
    public let commands: [Command]
}

public struct ClientConversationCommandResult: Decodable, Sendable, Equatable {
    public let text: String
    public let truncated: Bool
    /// Authoritative timeline identity, used to merge receipt and event delivery.
    public let messageId: String?
    public let conversationCleared: Bool?
}
