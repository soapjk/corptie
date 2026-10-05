import Foundation

/// Provider-neutral visual meaning of one Timeline item. Raw provider item
/// types remain transport details; every client routes UI through this value.
public enum ConversationPresentationKind: String, Equatable, Sendable {
    case userMessage
    case agentMessage
    case collaborationMessage
    case collaborationConfirmation
    case automationEvent
    case systemEvent
    case approval
    case userInput
    case executionPlan
    case unknown

    public static func isCommentary(type: String, presentationRole: String?) -> Bool {
        resolve(type: type, presentationRole: presentationRole) == .agentMessage
            && presentationRole?.lowercased() == "commentary"
    }

    public static func resolve(type: String, presentationRole: String?) -> Self {
        switch presentationRole?.lowercased() {
        case "collaboration_confirmation": return .collaborationConfirmation
        case "collaboration": return .collaborationMessage
        case "automation": return .automationEvent
        case "system_event": return .systemEvent
        default: break
        }
        switch type {
        case "collaborationConfirmation": return .collaborationConfirmation
        case "automationEvent": return .automationEvent
        case "userMessage": return .userMessage
        case "agentMessage": return .agentMessage
        case "choice", "approval": return .approval
        case "userInput": return .userInput
        case "plan", "executionPlan": return .executionPlan
        default: return .unknown
        }
    }
}

public struct ClientCollaborationPresentation: Equatable, Sendable {
    public let isConfirmation: Bool
    public let isChannelAuthorization: Bool
    public let direction: String?
    public let sourceSession: String?
    public let targetSession: String?
    public let sourceWork: String?
    public let targetWork: String?
    public let sourceTaskID: String?
    public let targetTaskID: String?
    public let messageKind: String
    public let status: String
    public let body: String
    public let acceptanceCriteria: [String]
    public let confirmationID: String?
    public let channelID: String?

    public var isPendingConfirmation: Bool {
        isConfirmation && status.lowercased() == "pending" && confirmationID != nil
    }
}

public extension ClientMessage {
    var presentationKind: ConversationPresentationKind {
        .resolve(type: type, presentationRole: presentationRole)
    }

    var collaborationPresentation: ClientCollaborationPresentation? {
        let kind = presentationKind
        guard kind == .collaborationMessage || kind == .collaborationConfirmation else { return nil }
        let status = collaborationConfirmationStatus
            ?? collaborationProcessingStatus
            ?? self.status
            ?? (kind == .collaborationConfirmation ? "pending" : "queued")
        return ClientCollaborationPresentation(
            isConfirmation: kind == .collaborationConfirmation,
            isChannelAuthorization: collaborationAuthorizationKind == "session_channel",
            direction: collaborationDirection,
            sourceSession: displayName(collaborationInitiatorSessionTitle, fallbackID: collaborationInitiatorSessionId),
            targetSession: displayName(collaborationRecipientSessionTitle, fallbackID: collaborationRecipientSessionId),
            sourceWork: displayName(collaborationSourceWorkName, fallbackID: collaborationSourceWorkId),
            targetWork: displayName(collaborationTargetWorkName, fallbackID: collaborationTargetWorkId),
            sourceTaskID: nonEmpty(collaborationSourceTaskId),
            targetTaskID: nonEmpty(collaborationTargetTaskId),
            messageKind: nonEmpty(collaborationMessageKind) ?? "message",
            status: status,
            body: nonEmpty(presentationText) ?? nonEmpty(text) ?? "协作消息正文不可用",
            acceptanceCriteria: collaborationAcceptanceCriteria ?? [],
            confirmationID: nonEmpty(collaborationConfirmationId),
            channelID: nonEmpty(collaborationChannelId)
        )
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }

    private func displayName(_ value: String?, fallbackID: String?) -> String? {
        nonEmpty(value) ?? nonEmpty(fallbackID)
    }
}
