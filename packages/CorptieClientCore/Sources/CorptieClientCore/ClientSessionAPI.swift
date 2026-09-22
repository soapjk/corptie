import Foundation
import CryptoKit

public struct ClientMessage: Decodable, Sendable, Identifiable, Equatable {
    public let id: String
    public let turnId: String?
    public let type: String
    public let text: String
    public let status: String?
    public let createdAt: String?
    public let userMessageStatus: String?
    public let queuePosition: Int?
    /// Additive timeline presentation fields. Older backends may omit them.
    public let turnStatus: String?
    public let title: String?
    public let presentationRole: String?
    public let presentationText: String?
    public let sourceType: String?
    public let localVisibility: String?
    public let processingError: String?
    public var processStartedAt: String?
    public var processEndedAt: String?

    public init(id: String, text: String) {
        self.id = id; self.text = text; type = "userMessage"
        turnId = nil; status = nil; createdAt = nil; userMessageStatus = nil; queuePosition = nil
        turnStatus = nil; title = nil; presentationRole = nil; presentationText = nil
        sourceType = nil; localVisibility = nil; processingError = nil
        processStartedAt = nil; processEndedAt = nil
    }
    public init(commandMessageID: String, result: ClientConversationCommandResult) {
        id = commandMessageID; text = result.text; type = "commandExecution"
        turnId = commandMessageID; status = "completed"; createdAt = nil
        userMessageStatus = nil; queuePosition = nil
        turnStatus = nil; title = nil; presentationRole = nil; presentationText = nil
        sourceType = nil; localVisibility = nil; processingError = nil
        processStartedAt = nil; processEndedAt = nil
    }
}
extension ClientMessage: ConversationExecutionItem {
    public var executionTitle: String { title ?? "" }
    public var timelineTurnID: String { turnId ?? "" }
    public var timelineTurnStatus: String { turnStatus ?? "" }
}

public struct ClientMessagePage: Decodable, Sendable {
    public let schemaVersion: Int
    public let sessionId: String
    public let items: [ClientMessage]
    public let hasEarlier: Bool
    public let nextBefore: String?
    public let revision: Int?
}
public struct ClientCommandReceipt: Decodable, Sendable {
    public let schemaVersion: Int
    public let requestId: String
    public let sessionId: String
    public let kind: String
    /// accepted is queue acceptance, not model completion. unknown must not be auto-replayed.
    public let status: String
    public let errorCode: String?
    public let updatedAt: String
    public let commandResult: ClientConversationCommandResult?
    public let taskResult: ClientTaskCreationResult?
}
public struct ClientSessionCapabilities: Decodable, Sendable {
    public struct Action: Decodable, Sendable {
        public let available: Bool
        public let reason: String?
    }
    public let schemaVersion: Int
    public let sessionId: String
    public let readMessages: Bool
    public let send: Action
    public let stop: Action
    public let composer: Bool?
    public let sendImages: Bool?
    public let sendMentions: Bool?
    public let scheduleMessage: Bool?
    public let createTask: Action?
    public let currentModel: String?
    public let currentReasoningLevel: String?
}

public struct ClientMessageSchedule: Encodable, Sendable {
    public let runAt: String
    public let expiresAt: String
    public let intervalSeconds: Int?
    public init(runAt: Date, expiresAt: Date, intervalSeconds: Int? = nil) {
        self.runAt = runAt.ISO8601Format(); self.expiresAt = expiresAt.ISO8601Format()
        self.intervalSeconds = intervalSeconds
    }
}

public struct ClientDraftImage: Encodable, Sendable, Identifiable {
    public let id: UUID
    public let fileName: String
    public let data: Data
    public init(fileName: String, data: Data) { id = UUID(); self.fileName = fileName; self.data = data }
    enum CodingKeys: String, CodingKey { case fileName, dataBase64 }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(fileName, forKey: .fileName)
        try container.encode(data.base64EncodedString(), forKey: .dataBase64)
    }
}
public struct ClientDraftMention: Encodable, Sendable, Identifiable {
    public var id: String { targetType + ":" + targetId }
    public let targetType: String
    public let targetId: String
    public let displayName: String
    public init(targetType: String, targetId: String, displayName: String) {
        self.targetType = targetType; self.targetId = targetId; self.displayName = displayName
    }
}

public struct ClientComposerConfiguration: Decodable, Sendable {
    public struct Model: Decodable, Sendable, Identifiable {
        public let id: String
        public let name: String
        public let reasoningLevels: [String]
        public let defaultReasoningLevel: String?
    }
    public let schemaVersion: Int
    public let sessionId: String
    public let currentModel: String?
    public let currentReasoningLevel: String?
    public let models: [Model]
    public let switchModel: ClientSessionCapabilities.Action
    public let switchReasoning: ClientSessionCapabilities.Action
}

/// No automatic retry. Persist requestId before sending and reuse it to query/retry the same intent.
public struct ClientSessionAPI: Sendable {
    /// Matches the existing durable device-command message identity on the server.
    public static func messageID(deviceID: String, requestID: String) -> String {
        "client:" + SHA256.hash(data: Data("\(deviceID):\(requestID)".utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private struct Version: Decodable { let schemaVersion: Int }
    private let transport: BackendTransport
    public init(transport: BackendTransport) { self.transport = transport }
    public func messages(sessionId: String, before: String? = nil) async throws -> ClientMessagePage {
        let query = [URLQueryItem(name: "limit", value: "40")] + (before.map { [URLQueryItem(name: "before", value: $0)] } ?? [])
        let request = try transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, "messages"], query: query)
        return try await read(request)
    }
    public func capabilities(sessionId: String) async throws -> ClientSessionCapabilities {
        try await read(transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, "capabilities"]))
    }
    public func composer(sessionId: String, update: [String: String]? = nil) async throws -> ClientComposerConfiguration {
        var request = try transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, "composer"])
        if let update {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(update)
        }
        return try await read(request)
    }
    public func receipt(requestId: String) async throws -> ClientCommandReceipt {
        try await read(transport.endpoint.request(path: ["client", "v1", "commands", requestId]))
    }
    public func commandCatalog(sessionId: String) async throws -> ClientConversationCommandCatalog {
        try await read(transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, "conversation-commands"]))
    }
    public func conversationCommand(sessionId: String, requestId: String,
                                    command: ClientConversationCommand, confirmed: Bool = false) async throws -> ClientCommandReceipt {
        struct Body: Encodable {
            let requestId: String
            let name: String
            let arguments: String
            let confirmed: Bool
        }
        return try await self.command(sessionId: sessionId, route: "conversation-commands",
            body: Body(requestId: requestId, name: command.name, arguments: command.arguments, confirmed: confirmed))
    }
    public func send(sessionId: String, requestId: String, text: String,
                     images: [ClientDraftImage] = [], mentions: [ClientDraftMention] = [],
                     schedule: ClientMessageSchedule? = nil) async throws -> ClientCommandReceipt {
        struct Message: Encodable {
            let requestId: String
            let text: String
            let images: [ClientDraftImage]?
            let mentions: [ClientDraftMention]?
            let schedule: ClientMessageSchedule?
        }
        return try await command(sessionId: sessionId, route: "messages", body: Message(requestId: requestId,
            text: text, images: images.isEmpty ? nil : images, mentions: mentions.isEmpty ? nil : mentions, schedule: schedule))
    }
    public func stop(sessionId: String, requestId: String) async throws -> ClientCommandReceipt {
        try await command(sessionId: sessionId, route: "stop", body: ["requestId": requestId])
    }
    public func createTask(sourceSessionId: String, input: ClientTaskCreation) async throws -> ClientCommandReceipt {
        try await command(sessionId: sourceSessionId, route: "tasks", body: input)
    }
    public func taskCreationOptions(sourceSessionId: String, providerId: String? = nil) async throws -> ClientTaskCreationOptions {
        let query = providerId.map { [URLQueryItem(name: "providerId", value: $0)] } ?? []
        return try await read(transport.endpoint.request(path: ["client", "v1", "sessions", sourceSessionId, "tasks"], query: query))
    }
    private func command<Body: Encodable>(sessionId: String, route: String, body: Body) async throws -> ClientCommandReceipt {
        var request = try transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, route])
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await read(request)
    }
    private func read<Value: Decodable>(_ request: URLRequest) async throws -> Value {
        let (data, _) = try await transport.data(for: request)
        guard try JSONDecoder().decode(Version.self, from: data).schemaVersion == 1 else {
            throw ClientConnectionError.invalidResponse
        }
        return try JSONDecoder().decode(Value.self, from: data)
    }
}
