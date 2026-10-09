import Foundation
import CryptoKit

public struct ClientMessage: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let turnId: String?
    public let type: String
    public let text: String
    public let status: String?
    public let createdAt: String?
    public let userMessageStatus: String?
    public let queuePosition: Int?
    public let deletionAvailable: Bool?
    public let queuedMessageTaskId: String?
    public var cancellableQueuedMessageTaskID: String? {
        guard type == "userMessage", userMessageStatus == "queued",
              let queuedMessageTaskId, !queuedMessageTaskId.isEmpty else { return nil }
        return queuedMessageTaskId
    }
    /// Additive timeline presentation fields. Older backends may omit them.
    public let turnStatus: String?
    public let title: String?
    public let presentationRole: String?
    public let presentationText: String?
    public let sourceType: String?
    public let localVisibility: String?
    public let processingError: String?
    public let collaborationDirection: String?
    public let collaborationSenderAgentId: String?
    public let collaborationSenderName: String?
    public let collaborationRecipientAgentId: String?
    public let collaborationRecipientName: String?
    public let collaborationInitiatorSessionId: String?
    public let collaborationInitiatorSessionTitle: String?
    public let collaborationInitiatorSessionKind: String?
    public let collaborationRecipientSessionId: String?
    public let collaborationRecipientSessionTitle: String?
    public let collaborationRecipientSessionKind: String?
    public let collaborationSourceWorkId: String?
    public let collaborationSourceWorkName: String?
    public let collaborationTargetWorkId: String?
    public let collaborationTargetWorkName: String?
    public let collaborationSourceTaskId: String?
    public let collaborationTargetTaskId: String?
    public let collaborationRelation: String?
    public let collaborationRouteStatus: String?
    public let collaborationRoutingVersion: Int?
    public let collaborationRequestTitle: String?
    public let collaborationMessageKind: String?
    public let collaborationProcessingStatus: String?
    public let collaborationConfirmationId: String?
    public let collaborationConfirmationStatus: String?
    public let collaborationAuthorizationKind: String?
    public let collaborationChannelId: String?
    public let collaborationAcceptanceCriteria: [String]?
    public let automationName: String?
    public var messageOrigin: String? = nil
    public var automationRunId: String? = nil
    public var automationRunStatus: String? = nil
    public var automationRunError: String? = nil
    public var automationTriggerType: String? = nil
    public var automationScheduleType: String? = nil
    public var automationIntervalSeconds: Double? = nil
    public var automationConditionCheckIntervalSeconds: Double? = nil
    public var automationProcessPollIntervalSeconds: Double? = nil
    public let automationEventType: String?
    public let automationEventOccurredAt: String?
    public let automationRunAt: String?
    public let automationNextRunAt: String?
    public let automationExpiresAt: String?
    public let systemEventKind: String?
    public let systemEventReason: String?
    public let systemEventSource: String?
    public var processStartedAt: String?
    public var processEndedAt: String?
    /// Managed attachments (additive; older backends omit them). Bytes come from `ClientSessionAPI.image`.
    public let images: [ClientMessageImage]
    public let executionPlan: ConversationExecutionPlan?
    public let toolExecution: ConversationToolExecution?
    public let changeSet: ConversationChangeSet?
    public let userInput: ConversationUserInput?
    public let options: [ClientApprovalOption]?

    enum CodingKeys: String, CodingKey {
        case id, turnId, type, text, status, createdAt, userMessageStatus, queuePosition, queuedMessageTaskId, deletionAvailable
        case turnStatus, title, presentationRole, presentationText, sourceType, localVisibility, processingError
        case collaborationDirection, collaborationSenderAgentId, collaborationSenderName
        case collaborationRecipientAgentId, collaborationRecipientName
        case collaborationInitiatorSessionId, collaborationInitiatorSessionTitle, collaborationInitiatorSessionKind
        case collaborationRecipientSessionId, collaborationRecipientSessionTitle, collaborationRecipientSessionKind
        case collaborationSourceWorkId, collaborationSourceWorkName, collaborationTargetWorkId, collaborationTargetWorkName
        case collaborationSourceTaskId, collaborationTargetTaskId, collaborationRelation, collaborationRouteStatus
        case collaborationRoutingVersion, collaborationRequestTitle, collaborationMessageKind
        case collaborationProcessingStatus, collaborationConfirmationId, collaborationConfirmationStatus
        case collaborationAuthorizationKind, collaborationChannelId, collaborationAcceptanceCriteria
        case automationName, automationEventType, automationEventOccurredAt, automationRunAt, automationNextRunAt
        case messageOrigin, automationRunId, automationRunStatus, automationRunError
        case automationTriggerType, automationScheduleType, automationIntervalSeconds, automationConditionCheckIntervalSeconds, automationProcessPollIntervalSeconds
        case automationExpiresAt, systemEventKind, systemEventReason, systemEventSource
        case processStartedAt, processEndedAt, images, executionPlan, toolExecution, changeSet, userInput, options
    }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        turnId = try container.decodeIfPresent(String.self, forKey: .turnId)
        type = try container.decode(String.self, forKey: .type)
        text = try container.decode(String.self, forKey: .text)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
        userMessageStatus = try container.decodeIfPresent(String.self, forKey: .userMessageStatus)
        queuePosition = try container.decodeIfPresent(Int.self, forKey: .queuePosition)
        deletionAvailable = try container.decodeIfPresent(Bool.self, forKey: .deletionAvailable)
        queuedMessageTaskId = try container.decodeIfPresent(String.self, forKey: .queuedMessageTaskId)
        turnStatus = try container.decodeIfPresent(String.self, forKey: .turnStatus)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        presentationRole = try container.decodeIfPresent(String.self, forKey: .presentationRole)
        presentationText = try container.decodeIfPresent(String.self, forKey: .presentationText)
        sourceType = try container.decodeIfPresent(String.self, forKey: .sourceType)
        localVisibility = try container.decodeIfPresent(String.self, forKey: .localVisibility)
        processingError = try container.decodeIfPresent(String.self, forKey: .processingError)
        collaborationDirection = try container.decodeIfPresent(String.self, forKey: .collaborationDirection)
        collaborationSenderAgentId = try container.decodeIfPresent(String.self, forKey: .collaborationSenderAgentId)
        collaborationSenderName = try container.decodeIfPresent(String.self, forKey: .collaborationSenderName)
        collaborationRecipientAgentId = try container.decodeIfPresent(String.self, forKey: .collaborationRecipientAgentId)
        collaborationRecipientName = try container.decodeIfPresent(String.self, forKey: .collaborationRecipientName)
        collaborationInitiatorSessionId = try container.decodeIfPresent(String.self, forKey: .collaborationInitiatorSessionId)
        collaborationInitiatorSessionTitle = try container.decodeIfPresent(String.self, forKey: .collaborationInitiatorSessionTitle)
        collaborationInitiatorSessionKind = try container.decodeIfPresent(String.self, forKey: .collaborationInitiatorSessionKind)
        collaborationRecipientSessionId = try container.decodeIfPresent(String.self, forKey: .collaborationRecipientSessionId)
        collaborationRecipientSessionTitle = try container.decodeIfPresent(String.self, forKey: .collaborationRecipientSessionTitle)
        collaborationRecipientSessionKind = try container.decodeIfPresent(String.self, forKey: .collaborationRecipientSessionKind)
        collaborationSourceWorkId = try container.decodeIfPresent(String.self, forKey: .collaborationSourceWorkId)
        collaborationSourceWorkName = try container.decodeIfPresent(String.self, forKey: .collaborationSourceWorkName)
        collaborationTargetWorkId = try container.decodeIfPresent(String.self, forKey: .collaborationTargetWorkId)
        collaborationTargetWorkName = try container.decodeIfPresent(String.self, forKey: .collaborationTargetWorkName)
        collaborationSourceTaskId = try container.decodeIfPresent(String.self, forKey: .collaborationSourceTaskId)
        collaborationTargetTaskId = try container.decodeIfPresent(String.self, forKey: .collaborationTargetTaskId)
        collaborationRelation = try container.decodeIfPresent(String.self, forKey: .collaborationRelation)
        collaborationRouteStatus = try container.decodeIfPresent(String.self, forKey: .collaborationRouteStatus)
        collaborationRoutingVersion = try container.decodeIfPresent(Int.self, forKey: .collaborationRoutingVersion)
        collaborationRequestTitle = try container.decodeIfPresent(String.self, forKey: .collaborationRequestTitle)
        collaborationMessageKind = try container.decodeIfPresent(String.self, forKey: .collaborationMessageKind)
        collaborationProcessingStatus = try container.decodeIfPresent(String.self, forKey: .collaborationProcessingStatus)
        collaborationConfirmationId = try container.decodeIfPresent(String.self, forKey: .collaborationConfirmationId)
        collaborationConfirmationStatus = try container.decodeIfPresent(String.self, forKey: .collaborationConfirmationStatus)
        collaborationAuthorizationKind = try container.decodeIfPresent(String.self, forKey: .collaborationAuthorizationKind)
        collaborationChannelId = try container.decodeIfPresent(String.self, forKey: .collaborationChannelId)
        collaborationAcceptanceCriteria = try container.decodeIfPresent([String].self, forKey: .collaborationAcceptanceCriteria)
        automationName = try container.decodeIfPresent(String.self, forKey: .automationName)
        messageOrigin = try container.decodeIfPresent(String.self, forKey: .messageOrigin)
        automationRunId = try container.decodeIfPresent(String.self, forKey: .automationRunId)
        automationRunStatus = try container.decodeIfPresent(String.self, forKey: .automationRunStatus)
        automationRunError = try container.decodeIfPresent(String.self, forKey: .automationRunError)
        automationTriggerType = try container.decodeIfPresent(String.self, forKey: .automationTriggerType)
        automationScheduleType = try container.decodeIfPresent(String.self, forKey: .automationScheduleType)
        automationIntervalSeconds = try container.decodeIfPresent(Double.self, forKey: .automationIntervalSeconds)
        automationConditionCheckIntervalSeconds = try container.decodeIfPresent(Double.self, forKey: .automationConditionCheckIntervalSeconds)
        automationProcessPollIntervalSeconds = try container.decodeIfPresent(Double.self, forKey: .automationProcessPollIntervalSeconds)
        automationEventType = try container.decodeIfPresent(String.self, forKey: .automationEventType)
        automationEventOccurredAt = try container.decodeIfPresent(String.self, forKey: .automationEventOccurredAt)
        automationRunAt = try container.decodeIfPresent(String.self, forKey: .automationRunAt)
        automationNextRunAt = try container.decodeIfPresent(String.self, forKey: .automationNextRunAt)
        automationExpiresAt = try container.decodeIfPresent(String.self, forKey: .automationExpiresAt)
        systemEventKind = try container.decodeIfPresent(String.self, forKey: .systemEventKind)
        systemEventReason = try container.decodeIfPresent(String.self, forKey: .systemEventReason)
        systemEventSource = try container.decodeIfPresent(String.self, forKey: .systemEventSource)
        processStartedAt = try container.decodeIfPresent(String.self, forKey: .processStartedAt)
        processEndedAt = try container.decodeIfPresent(String.self, forKey: .processEndedAt)
        images = try container.decodeIfPresent([ClientMessageImage].self, forKey: .images) ?? []
        executionPlan = try? container.decodeIfPresent(ConversationExecutionPlan.self, forKey: .executionPlan)
        toolExecution = try? container.decodeIfPresent(ConversationToolExecution.self, forKey: .toolExecution)
        changeSet = try? container.decodeIfPresent(ConversationChangeSet.self, forKey: .changeSet)
        userInput = try? container.decodeIfPresent(ConversationUserInput.self, forKey: .userInput)
        options = try? container.decodeIfPresent([ClientApprovalOption].self, forKey: .options)
    }

    public init(id: String, text: String) {
        self.id = id; self.text = text; type = "userMessage"
        turnId = nil; status = nil; createdAt = nil; userMessageStatus = nil; queuePosition = nil
        queuedMessageTaskId = nil; deletionAvailable = nil
        turnStatus = nil; title = nil; presentationRole = nil; presentationText = nil
        sourceType = nil; localVisibility = nil; processingError = nil
        collaborationDirection = nil; collaborationSenderAgentId = nil; collaborationSenderName = nil
        collaborationRecipientAgentId = nil; collaborationRecipientName = nil
        collaborationInitiatorSessionId = nil; collaborationInitiatorSessionTitle = nil; collaborationInitiatorSessionKind = nil
        collaborationRecipientSessionId = nil; collaborationRecipientSessionTitle = nil; collaborationRecipientSessionKind = nil
        collaborationSourceWorkId = nil; collaborationSourceWorkName = nil; collaborationTargetWorkId = nil; collaborationTargetWorkName = nil
        collaborationSourceTaskId = nil; collaborationTargetTaskId = nil; collaborationRelation = nil; collaborationRouteStatus = nil
        collaborationRoutingVersion = nil; collaborationRequestTitle = nil; collaborationMessageKind = nil
        collaborationProcessingStatus = nil; collaborationConfirmationId = nil; collaborationConfirmationStatus = nil
        collaborationAuthorizationKind = nil; collaborationChannelId = nil; collaborationAcceptanceCriteria = nil
        automationName = nil; automationEventType = nil; automationEventOccurredAt = nil; automationRunAt = nil
        automationNextRunAt = nil; automationExpiresAt = nil; systemEventKind = nil; systemEventReason = nil; systemEventSource = nil
        processStartedAt = nil; processEndedAt = nil; images = []; executionPlan = nil; toolExecution = nil; changeSet = nil; userInput = nil; options = nil
    }
    public init(commandMessageID: String, result: ClientConversationCommandResult) {
        id = commandMessageID; text = result.text; type = "commandExecution"
        turnId = commandMessageID; status = "completed"; createdAt = nil
        userMessageStatus = nil; queuePosition = nil; queuedMessageTaskId = nil; deletionAvailable = nil
        turnStatus = nil; title = nil; presentationRole = nil; presentationText = nil
        sourceType = nil; localVisibility = nil; processingError = nil
        collaborationDirection = nil; collaborationSenderAgentId = nil; collaborationSenderName = nil
        collaborationRecipientAgentId = nil; collaborationRecipientName = nil
        collaborationInitiatorSessionId = nil; collaborationInitiatorSessionTitle = nil; collaborationInitiatorSessionKind = nil
        collaborationRecipientSessionId = nil; collaborationRecipientSessionTitle = nil; collaborationRecipientSessionKind = nil
        collaborationSourceWorkId = nil; collaborationSourceWorkName = nil; collaborationTargetWorkId = nil; collaborationTargetWorkName = nil
        collaborationSourceTaskId = nil; collaborationTargetTaskId = nil; collaborationRelation = nil; collaborationRouteStatus = nil
        collaborationRoutingVersion = nil; collaborationRequestTitle = nil; collaborationMessageKind = nil
        collaborationProcessingStatus = nil; collaborationConfirmationId = nil; collaborationConfirmationStatus = nil
        collaborationAuthorizationKind = nil; collaborationChannelId = nil; collaborationAcceptanceCriteria = nil
        automationName = nil; automationEventType = nil; automationEventOccurredAt = nil; automationRunAt = nil
        automationNextRunAt = nil; automationExpiresAt = nil; systemEventKind = nil; systemEventReason = nil; systemEventSource = nil
        processStartedAt = nil; processEndedAt = nil; images = []; executionPlan = nil; toolExecution = nil; changeSet = nil; userInput = nil; options = nil
    }
}
public struct ClientApprovalOption: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let role: String?
    public let selected: Bool?
}

public struct ClientApprovalResponse: Decodable, Sendable {
    public let schemaVersion: Int
    public let sessionId: String
    public let itemId: String
    public let status: String
}
public struct ClientCollaborationConfirmationResponse: Decodable, Sendable {
    public let schemaVersion: Int
    public let sessionId: String
    public let itemId: String
    public let status: String
}
public struct ClientUserInputResponse: Decodable, Sendable {
    public let schemaVersion: Int
    public let sessionId: String
    public let itemId: String
    /// Submitted means transport acknowledgement, not Provider execution.
    public let status: String
}
/// One managed attachment of a message. `managedPath` is an opaque host token, never a device path.
public struct ClientMessageImage: Codable, Sendable, Equatable, Identifiable {
    public var id: String { managedPath }
    public let managedPath: String
    public let fileName: String?
    public let mimeType: String?
    public let byteLength: Int?
}
extension ClientMessage: ConversationExecutionItem {
    public var timelineHasImages: Bool { !images.isEmpty }
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
    public let messageId: String?
    public let commandResult: ClientConversationCommandResult?
    public let taskResult: ClientTaskCreationResult?
    /// Present for `task_*` / `work_*` management commands.
    public let entityResult: ClientEntityCommandResult?
}
public struct ClientSessionCapabilities: Decodable, Sendable {
    public let cancelQueuedMessage: Bool?
    public let deleteUnreceivedMessage: Bool?
    public struct ImageUploads: Decodable, Sendable {
        public let version: Int
        public let maximumImages: Int
        public let maximumBytes: Int
        public let chunkBytes: Int
        public let maximumAgeSeconds: Int
    }
    public struct ReliableMessages: Decodable, Sendable {
        public let version: Int
        public let maximumAgeSeconds: Int
        public let messageIdentityVersion: Int?
    }
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
    public let imageUploads: ImageUploads?
    public let sendMentions: Bool?
    public let reliableMessages: ReliableMessages?
    public let scheduleMessage: Bool?
    public let createTask: Action?
    public let collaborationConfirmation: Action?
    public let currentModel: String?
    public let currentReasoningLevel: String?
    /// Host readiness of the Session ("ready" / "not_ready"); absent on older hosts.
    public let readiness: String?
    /// Present only while `readiness == "not_ready"`.
    public let notReadyReason: ClientSessionNotReadyReason?
}

/// Why the host reports a Session as not ready; codes mirror the desktop `SessionNotReadyReason`.
public struct ClientSessionNotReadyReason: Decodable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let retryable: Bool?
    public init(code: String, message: String, retryable: Bool? = nil) {
        self.code = code; self.message = message; self.retryable = retryable
    }
}

/// Read-only usage projection of one Session (context window plus provider rate limits).
public struct ClientSessionUsage: Decodable, Equatable, Sendable {
    public struct Route: Decodable, Equatable, Sendable {
        public let providerId: String
        public let modelId: String?
        public let bindingId: String?
        public let routingVersion: Int?
        public init(providerId: String, modelId: String?, bindingId: String?, routingVersion: Int?) {
            self.providerId = providerId; self.modelId = modelId
            self.bindingId = bindingId; self.routingVersion = routingVersion
        }
    }
    public struct Context: Decodable, Equatable, Sendable {
        public let usedTokens: Int?
        public let contextWindow: Int?
        public let remainingTokens: Int?
        public let usedPercent: Double?
        public init(usedTokens: Int?, contextWindow: Int?, remainingTokens: Int?, usedPercent: Double?) {
            self.usedTokens = usedTokens; self.contextWindow = contextWindow
            self.remainingTokens = remainingTokens; self.usedPercent = usedPercent
        }
    }
    public struct Window: Decodable, Equatable, Sendable {
        public let usedPercent: Double?
        public let windowDurationMins: Int?
        public let resetsAt: Double?
        public init(usedPercent: Double?, windowDurationMins: Int?, resetsAt: Double?) {
            self.usedPercent = usedPercent; self.windowDurationMins = windowDurationMins; self.resetsAt = resetsAt
        }
    }
    public struct RateLimit: Decodable, Equatable, Sendable {
        public let limitId: String?
        public let limitName: String?
        public let primary: Window?
        public let secondary: Window?
        public init(limitId: String?, limitName: String?, primary: Window?, secondary: Window?) {
            self.limitId = limitId; self.limitName = limitName; self.primary = primary; self.secondary = secondary
        }
    }
    public struct Account: Decodable, Equatable, Sendable {
        public let available: Bool?
        public let provider: String?
        public let model: String?
        public let rateLimits: RateLimit?
        public let rateLimitsByLimitId: [String: RateLimit]?
        public let rateLimitResetCredits: RateLimitResetCredits?
        public init(available: Bool?, provider: String?, model: String?, rateLimits: RateLimit?, rateLimitsByLimitId: [String: RateLimit]?, rateLimitResetCredits: RateLimitResetCredits? = nil) {
            self.available = available; self.provider = provider; self.model = model
            self.rateLimits = rateLimits; self.rateLimitsByLimitId = rateLimitsByLimitId
            self.rateLimitResetCredits = rateLimitResetCredits
        }
    }
    public struct RateLimitResetCredits: Decodable, Equatable, Sendable {
        public let availableCount: Int?
        public let credits: [RateLimitResetCredit]?
    }
    public struct RateLimitResetCredit: Decodable, Equatable, Sendable {
        public let id: String?
        public let resetType: String?
        public let status: String?
        public let grantedAt: Double?
        public let expiresAt: Double?
        public let title: String?
        public let description: String?
    }
    public let schemaVersion: Int
    public let sessionId: String
    /// Authoritative active Binding identity. Account usage is valid only when
    /// its provider/model matches this route.
    public let route: Route?
    public let accountFresh: Bool?
    public let context: Context?
    public let account: Account?
    public init(schemaVersion: Int = 1, sessionId: String, route: Route? = nil,
                context: Context?, account: Account?, accountFresh: Bool? = nil) {
        self.schemaVersion = schemaVersion; self.sessionId = sessionId; self.accountFresh = accountFresh
        self.route = route; self.context = context; self.account = account
    }
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

public struct ClientDraftImage: Codable, Sendable, Identifiable {
    public let id: UUID
    public let fileName: String
    public let data: Data
    public init(fileName: String, data: Data) { id = UUID(); self.fileName = fileName; self.data = data }
    enum CodingKeys: String, CodingKey { case fileName, dataBase64 }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let encoded = try container.decode(String.self, forKey: .dataBase64)
        guard let data = Data(base64Encoded: encoded) else {
            throw DecodingError.dataCorruptedError(forKey: .dataBase64, in: container, debugDescription: "Invalid image")
        }
        self.init(fileName: try container.decode(String.self, forKey: .fileName), data: data)
    }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(fileName, forKey: .fileName)
        try container.encode(data.base64EncodedString(), forKey: .dataBase64)
    }
}
public struct ClientDraftMention: Codable, Equatable, Sendable, Identifiable {
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
    public func cancelQueuedMessage(sessionId: String, taskId: String) async throws {
        struct Result: Decodable { let schemaVersion: Int; let status: String }
        var request = try transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, "cancel-queued-message"])
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["taskId": taskId])
        let result: Result = try await read(request)
        guard result.status == "cancelled" else { throw ClientConnectionError.invalidResponse }
    }
    public func deleteUnreceivedMessage(sessionId: String, messageId: String) async throws {
        struct Result: Decodable { let schemaVersion: Int; let messageId: String; let status: String }
        var request = try transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, "messages", messageId])
        request.httpMethod = "DELETE"
        let result: Result = try await read(request)
        guard result.status == "deleted", result.messageId == messageId else { throw ClientConnectionError.invalidResponse }
    }
    public func quickMessages(sessionId: String) async throws -> ClientQuickMessageRecommendations {
        let result: ClientQuickMessageRecommendations = try await read(
            transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, "quick-messages"]))
        guard result.schemaVersion == 1, result.items.count <= 6 else { throw ClientConnectionError.invalidResponse }
        return result
    }
    /// Usage snapshot behind `messages.read`; hosts without a usage reader answer 409 `CAPABILITY_UNSUPPORTED`.
    public func usage(sessionId: String, freshAccount: Bool = false) async throws -> ClientSessionUsage {
        let query = freshAccount ? [URLQueryItem(name: "freshAccount", value: "1")] : []
        return try await read(transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, "usage"], query: query))
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
    /// Small text retries use the durable idempotent endpoint directly, avoiding
    /// an extra round trip. Attachments still query before uploading again.
    public func reconcileOrDeliver(sessionId: String, requestId: String, createdAt: String, text: String,
        images: [ClientDraftImage] = [], mentions: [ClientDraftMention] = [], previousAttempts: Int,
        onProgress: (@Sendable (String) async -> Void)? = nil) async throws -> ClientCommandReceipt {
        if !images.isEmpty {
            do { return try await receipt(requestId: requestId) }
            catch let failure as ClientServiceFailure where failure.statusCode == 404 && failure.code == "COMMAND_NOT_FOUND" { }
        }
        if !images.isEmpty {
            return try await uploadAndDeliver(sessionId: sessionId, requestId: requestId, createdAt: createdAt,
                text: text, images: images, mentions: mentions, onProgress: onProgress)
        }
        return try await deliver(sessionId: sessionId, requestId: requestId, createdAt: createdAt,
            text: text, images: images, mentions: mentions)
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
    public func deliver(sessionId: String, requestId: String, createdAt: String, text: String,
                        images: [ClientDraftImage] = [], mentions: [ClientDraftMention] = [],
                        imageUploadIds: [String] = []) async throws -> ClientCommandReceipt {
        struct Body: Encodable {
            let schemaVersion = 1
            let requestId: String
            let createdAt: String
            let text: String
            let images: [ClientDraftImage]?
            let imageUploadIds: [String]?
            let mentions: [ClientDraftMention]?
        }
        return try await command(sessionId: sessionId, route: "message-deliveries", body: Body(
            requestId: requestId, createdAt: createdAt, text: text,
            images: images.isEmpty ? nil : images, imageUploadIds: imageUploadIds.isEmpty ? nil : imageUploadIds,
            mentions: mentions.isEmpty ? nil : mentions))
    }

    private struct ImageUploadStatus: Decodable {
        let schemaVersion: Int
        let uploadId: String
        let offset: Int
        let byteLength: Int
        let sha256: String
    }
    private func uploadAndDeliver(sessionId: String, requestId: String, createdAt: String, text: String,
        images: [ClientDraftImage], mentions: [ClientDraftMention],
        onProgress: (@Sendable (String) async -> Void)?) async throws -> ClientCommandReceipt {
        let capability = try await capabilities(sessionId: sessionId)
        guard capability.sendImages == true else {
            throw ClientServiceFailure(statusCode: 409, code: "IMAGE_CAPABILITY_UNSUPPORTED")
        }
        guard let policy = capability.imageUploads, policy.version == 1,
              policy.chunkBytes > 0, policy.chunkBytes <= 512 * 1024,
              policy.maximumBytes > 0, policy.maximumBytes <= 20 * 1024 * 1024 else {
            throw ClientServiceFailure(statusCode: 409, code: "IMAGE_UPLOAD_REQUIRES_HOST_UPDATE")
        }
        guard images.count <= policy.maximumImages, images.allSatisfy({ !$0.data.isEmpty }),
              images.reduce(0, { $0 + $1.data.count }) <= policy.maximumBytes else {
            throw ClientServiceFailure(statusCode: 413, code: "IMAGE_SIZE_LIMIT")
        }
        struct Begin: Encodable { let schemaVersion = 1; let uploadId: String; let fileName: String; let byteLength: Int; let sha256: String }
        struct Chunk: Encodable { let schemaVersion = 1; let offset: Int; let dataBase64: String; let sha256: String }
        func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
        var ids: [String] = []
        let total = images.reduce(0) { $0 + $1.data.count }
        var completed = 0
        for (index, image) in images.enumerated() {
            try Task.checkCancellation()
            let id = "\(requestId)-\(index)"
            let sha = digest(image.data)
            let path = ["client", "v1", "sessions", sessionId, "image-uploads"]
            var status: ImageUploadStatus = try await uploadRequest(path: path, method: "POST",
                body: Begin(uploadId: id, fileName: image.fileName, byteLength: image.data.count, sha256: sha))
            guard status.uploadId == id, status.sha256 == sha, status.byteLength == image.data.count,
                  status.offset >= 0, status.offset <= image.data.count else { throw ClientConnectionError.invalidResponse }
            while status.offset < image.data.count {
                try Task.checkCancellation()
                await onProgress?("上传图片 \(min(100, (completed + status.offset) * 100 / max(1, total)))%")
                let start = status.offset
                let end = min(image.data.count, start + policy.chunkBytes)
                let bytes = image.data.subdata(in: start..<end)
                status = try await uploadRequest(path: path + [id], method: "PUT",
                    body: Chunk(offset: start, dataBase64: bytes.base64EncodedString(), sha256: digest(bytes)))
                guard status.uploadId == id, status.sha256 == sha, status.byteLength == image.data.count,
                      status.offset == end else { throw ClientConnectionError.invalidResponse }
            }
            completed += image.data.count
            ids.append(id)
        }
        await onProgress?("图片已上传，正在提交")
        return try await deliver(sessionId: sessionId, requestId: requestId, createdAt: createdAt,
            text: text, mentions: mentions, imageUploadIds: ids)
    }
    private func uploadRequest<Body: Encodable>(path: [String], method: String, body: Body) async throws -> ImageUploadStatus {
        var request = try transport.endpoint.request(path: path)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await read(request)
    }
    public func respondToApproval(sessionId: String, itemId: String, optionId: String) async throws -> ClientApprovalResponse {
        struct Body: Encodable { let itemId: String; let optionId: String }
        var request = try transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, "approval"])
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Body(itemId: itemId, optionId: optionId))
        return try await read(request)
    }
    public func respondToUserInput(sessionId: String, itemId: String,
                                   answers: [String: [String]], action: String? = nil) async throws -> ClientUserInputResponse {
        struct Body: Encodable { let itemId: String; let answers: [String: [String]]; let action: String? }
        var request = try transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, "user-input"])
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Body(itemId: itemId, answers: answers, action: action))
        return try await read(request)
    }
    public func respondToCollaborationConfirmation(sessionId: String, itemId: String,
                                                   approve: Bool) async throws -> ClientCollaborationConfirmationResponse {
        struct Body: Encodable { let itemId: String; let decision: String }
        var request = try transport.endpoint.request(
            path: ["client", "v1", "sessions", sessionId, "collaboration-confirmation"])
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Body(
            itemId: itemId, decision: approve ? "confirm" : "reject"))
        return try await read(request)
    }
    /// Acknowledges agent messages through `throughSequence` (same host receipt macOS submits on open).
    public func readReceipt(sessionId: String, throughSequence: Int) async throws -> ClientReadReceipt {
        var request = try transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, "read-receipt"])
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["throughSequence": throughSequence])
        return try await read(request)
    }
    /// Raw bytes of one managed attachment (`nil` when the host no longer has it). Callers decode off-main.
    public func resource(sessionId: String, itemId: String, path: String) async throws -> Data {
        let request = try transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, "resources"],
            query: [URLQueryItem(name: "itemId", value: itemId), URLQueryItem(name: "path", value: path)])
        return try await transport.data(for: request).0
    }

    public func image(sessionId: String, managedPath: String) async throws -> (data: Data, contentType: String?)? {
        let request = try transport.endpoint.request(path: ["client", "v1", "sessions", sessionId, "images"],
            query: [URLQueryItem(name: "path", value: managedPath)])
        do {
            let (data, response) = try await transport.data(for: request)
            return (data, response.value(forHTTPHeaderField: "Content-Type"))
        } catch let failure as ClientServiceFailure where failure.statusCode == 404 {
            return nil
        }
    }
    public func createTask(sourceSessionId: String, input: ClientTaskCreation) async throws -> ClientCommandReceipt {
        try await command(sessionId: sourceSessionId, route: "tasks", body: input)
    }
    public func taskCreationOptions(sourceSessionId: String, providerId: String? = nil) async throws -> ClientTaskCreationOptions {
        let query = providerId.map { [URLQueryItem(name: "providerId", value: $0)] } ?? []
        return try await read(transport.endpoint.request(path: ["client", "v1", "sessions", sourceSessionId, "tasks"], query: query))
    }
    // MARK: Work / Task management (macOS outline context menus)
    public func taskManagement(taskId: String) async throws -> ClientTaskManagement {
        try await read(transport.endpoint.request(path: ["client", "v1", "tasks", taskId, "management"]))
    }
    public func taskDeletionPlan(taskId: String) async throws -> ClientTaskDeletionPlan {
        try await read(transport.endpoint.request(path: ["client", "v1", "tasks", taskId, "deletion"]))
    }
    public func workManagement(workId: String) async throws -> ClientWorkManagement {
        try await read(transport.endpoint.request(path: ["client", "v1", "works", workId, "management"]))
    }
    public func workCreationOptions() async throws -> ClientWorkCreationOptions {
        try await read(transport.endpoint.request(path: ["client", "v1", "works", "create"]))
    }
    public func createWork(_ body: ClientWorkCreation) async throws -> ClientCommandReceipt {
        try await post(path: ["client", "v1", "works", "create"], body: body)
    }
    public func taskCommand<Body: Encodable>(taskId: String, command: ClientTaskCommand, body: Body) async throws -> ClientCommandReceipt {
        try await post(path: ["client", "v1", "tasks", taskId, command.rawValue], body: body)
    }
    public func workCommand<Body: Encodable>(workId: String, command: ClientWorkCommand, body: Body) async throws -> ClientCommandReceipt {
        try await post(path: ["client", "v1", "works", workId, command.rawValue], body: body)
    }
    private func command<Body: Encodable>(sessionId: String, route: String, body: Body) async throws -> ClientCommandReceipt {
        try await post(path: ["client", "v1", "sessions", sessionId, route], body: body)
    }
    private func post<Body: Encodable>(path: [String], body: Body) async throws -> ClientCommandReceipt {
        var request = try transport.endpoint.request(path: path)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await read(request)
    }
    private func read<Value: Decodable>(_ request: URLRequest) async throws -> Value {
        let (data, _) = try await transport.data(for: request)
        guard try ClientDecodingDiagnostics.decode(Version.self, from: data,
            context: request.url?.path ?? "client-api").schemaVersion == 1 else {
            throw ClientConnectionError.invalidResponse
        }
        return try ClientDecodingDiagnostics.decode(Value.self, from: data, context: request.url?.path ?? "client-api")
    }
}
