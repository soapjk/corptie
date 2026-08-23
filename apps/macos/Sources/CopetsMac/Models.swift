import Foundation
import AppKit
import SwiftUI

enum SessionKind: String, Codable, Equatable, Sendable {
    case assistantChat
    case objectiveChat
    case worker
    case legacy
}

enum SessionContextReferenceType: String, Codable, CaseIterable, Sendable {
    case localFile
    case webURL
    case objective
    case workItem
    case agent
    case session
}

struct SessionContextReference: Identifiable, Codable, Equatable, Sendable {
    let referenceId: String
    let ownerSessionId: String
    let targetType: SessionContextReferenceType
    let targetKey: String
    let targetId: String?
    let locator: String?
    let displayName: String
    let inclusionMode: String
    let enabled: Bool
    let priority: Int
    let status: String
    let snapshotTitle: String?
    let snapshotAt: String?
    let contentHash: String?
    let createdAt: String
    let updatedAt: String

    var id: String { referenceId }
}

struct SessionContextReferenceListEnvelope: Decodable {
    let references: [SessionContextReference]
}

struct SessionContextReferenceEnvelope: Decodable {
    let reference: SessionContextReference
}

struct TaskSession: Identifiable, Codable, Equatable, Sendable {
    let id: String
    let title: String
    let agent: String
    let agentId: String?
    var sessionKind: SessionKind? = nil
    var objectiveId: String? = nil
    var workItemId: String? = nil
    let status: TaskStatus
    let progress: Double
    let summary: String
    let suggestedOptions: [CodexApprovalOption]?
    let suggestedPrompt: String?
    let activityStatus: String?
    let updatedAt: String
    var lastMessageAt: String? = nil
    var lastAgentMessageSequence: Int? = nil
    var lastReadMessageSequence: Int? = nil
    let accent: Accent
    let archived: Bool?
    let pinned: Bool?
    let sortOrder: Double?
    let capabilities: SessionCapabilities?
    let external: ExternalSession?
    var actions: SessionActions? = nil
    var pendingCollaborationConfirmation: PendingCollaborationConfirmation? = nil

    var isConnected: Bool {
        SessionConnectionPresentation.isConnected(
            status: external?.connectionStatus,
            usesManualConnection: usesManualConnection
        )
    }

    var resolvedSessionKind: SessionKind {
        if let sessionKind { return sessionKind }
        if workItemId?.isEmpty == false { return .worker }
        return objectiveId?.isEmpty == false ? .objectiveChat : .legacy
    }

    var isConnecting: Bool {
        isConnectingStatus(external?.connectionStatus, provider: external?.provider)
    }

    var canSendNow: Bool {
        actions?.send.available ?? capabilities?.canSend ?? false
    }

    var canInterruptNow: Bool {
        actions?.interrupt.available ?? capabilities?.canInterrupt ?? false
    }

    var canResumeNow: Bool {
        actions?.resume?.available ?? capabilities?.canReconnect ?? false
    }

    var canPrepareExecutionNow: Bool {
        actions?.prepareExecution?.available ?? capabilities?.canPrepareExecution ?? false
    }

    var canSwitchModelNow: Bool {
        actions?.switchModel.available ?? capabilities?.canSwitchModel ?? false
    }

    var canSwitchReasoningNow: Bool {
        actions?.switchReasoning.available ?? capabilities?.canSwitchReasoning ?? false
    }

    var canSwitchProviderNow: Bool {
        actions?.switchProvider.available ?? false
    }

    var usesManualConnection: Bool {
        if let disconnect = actions?.disconnect {
            return disconnect.available || disconnect.reason != "CAPABILITY_UNSUPPORTED"
        }
        return external?.connectionStatus?.localizedCaseInsensitiveContains("pty") == true
    }

    var isUnboundSession: Bool {
        usesManualConnection && (external?.agentSessionId?.isEmpty ?? true)
    }

    var connectionColor: Color {
        if isUnboundSession {
            return CorptiePalette.unboundDot
        }
        return isConnected ? CorptiePalette.connectedDot : CorptiePalette.disconnected
    }
}

struct SessionReadReceiptResponse: Decodable, Sendable {
    let sessionId: String
    let legacySessionId: String?
    let lastAgentMessageSequence: Int
    let lastReadMessageSequence: Int
}

struct PendingCollaborationConfirmation: Codable, Equatable, Sendable {
    let confirmationId: String
    let initiatorAgentId: String?
    let initiatorName: String?
    let recipientAgentId: String?
    let recipientName: String
    let sourceObjectiveId: String?
    let sourceObjectiveName: String?
    let targetObjectiveId: String?
    let targetObjectiveName: String?
    let initiatorSessionId: String?
    let initiatorSessionTitle: String?
    let initiatorSessionKind: String?
    let initiatorWorkItemId: String?
    let recipientSessionId: String?
    let recipientSessionTitle: String?
    let recipientSessionKind: String?
    let recipientWorkItemId: String?
    let routeStatus: String?
    let routingVersion: Int?
    let taskTitle: String
    let summary: String
    let acceptanceCriteria: [String]
}

struct ExternalSession: Codable, Equatable, Sendable {
    let provider: String
    let threadId: String?
    let sessionId: String?
    let agentSessionId: String?
    let connectionStatus: String?
    let currentModel: String?
    let currentReasoningLevel: String?
    let cwd: String?
    let sandbox: String?
    let approvalPolicy: String?
    let source: String?
    let logicalSessionId: String?
    let workspace: SessionWorkspace?
    let routingVersion: Int?
    let providerSwitchInFlight: Bool?
    let providerTransition: ProviderTransition?
}

struct ProviderTransition: Codable, Equatable, Sendable {
    let transitionId: String
    let phase: String
    let error: String?
}

struct SessionWorkspace: Codable, Equatable, Sendable {
    let id: String?
    let repositoryId: String?
    let projectPath: String?
    let path: String?
    let availability: String?
    let branchName: String?
    let headOid: String?
    var transitionStrategy: String? = nil
    var previousThreadId: String? = nil
    var continuationState: String? = nil
}

struct WorkspaceRecoveryStatus: Decodable, Equatable, Sendable {
    let orphaned: Bool
    let originalPath: String?
    let originalBranchName: String?
    let canRebuild: Bool?
    let worktrees: [WorkspaceRecoveryWorktree]
}

struct WorkspaceRecoveryWorktree: Identifiable, Decodable, Equatable, Sendable {
    var id: String { worktreeId }
    let worktreeId: String
    let path: String
    let branchName: String?
    let isMain: Bool
    let availability: String
}

struct SessionDeletionPlan: Decodable, Sendable {
    let requiresWorktreeMerge: Bool
    let workspaceUnavailable: Bool?
    let sourcePath: String?
    let sourceBranch: String?
    let mainPath: String?
    let mainBranch: String?
    let hasUncommittedChanges: Bool?
    let unavailableReason: String?
}

struct SessionWorkspaceHistoryResponse: Decodable, Sendable {
    let history: [SessionWorkspaceHistory]
}

struct WorkspaceInventoryEventEnvelope: Decodable, Sendable {
    struct Payload: Decodable, Sendable {
        let newlyDiscoveredWorkspaces: [GitWorkspaceEventItem]
    }

    let payload: Payload
}

struct GitWorkspaceEventItem: Decodable, Sendable {
    let worktreeId: String
    let path: String
}

struct SessionWorkspaceHistory: Identifiable, Decodable, Equatable, Sendable {
    var id: String { bindingId }
    let bindingId: String
    let providerId: String
    let providerThreadId: String
    let state: String
    let readOnly: Bool
    let boundCwd: String
    let worktreeId: String?
    let repositoryId: String?
    let branchName: String?
    let headOid: String?
    let availability: String?
    let createdAt: String
    let updatedAt: String
}

struct ProjectWorktreeStatusResponse: Decodable, Equatable, Sendable {
    let project: ProjectGitStatus
    let toolset: ProjectToolsetStatus
    let service: ProjectServiceStatus
    let gitHubPush: GitHubPushStatus?
}

struct GitHubPushStatus: Decodable, Equatable, Sendable {
    let available: Bool
    let pending: Bool
    let dirty: Bool
    let unpushedCommitCount: Int
    let branch: String?
    let destinationUrl: String?
    let error: String?
}

struct ProjectGitStatus: Decodable, Equatable, Sendable {
    let repositoryId: String
    let mainWorktreeId: String
    let mainPath: String
    let mainBranch: String
    let mainHeadOid: String
    let pendingWorktreeCount: Int
    let worktrees: [ProjectWorktreeStatus]
}

struct ProjectWorktreeStatus: Identifiable, Decodable, Equatable, Sendable {
    var id: String { worktreeId }
    let worktreeId: String
    let path: String
    let isMain: Bool
    let availability: String
    let headOid: String?
    let branchName: String?
    let state: String
    let dirty: Bool?
    let mergedIntoMain: Bool?
    let synchronizedWithMain: Bool?
    let serviceContainsChanges: Bool?
    let aheadOfMain: Int?
    let behindMain: Int?
    let pendingIntegration: Bool
    let sessions: [ProjectWorktreeSession]
    let gitHubPush: GitHubPushStatus?
}

struct ProjectWorktreeSession: Decodable, Equatable, Sendable {
    let logicalSessionId: String
    let sessionId: String?
    let title: String?
    let active: Bool
}

struct ProjectToolsetStatus: Decodable, Equatable, Sendable {
    let installed: Bool
    let configured: Bool
    let manifestConfigured: Bool
    let compatible: Bool
    let requiresUpdate: Bool
    let schemaVersion: Int?
    let mainPath: String
    let toolsetPath: String
    let profiles: [ProjectServiceProfile]
    let selectedProfile: String
}

struct ProjectServiceProfile: Identifiable, Decodable, Equatable, Sendable {
    let id: String
    let label: String
    let description: String
}

struct ProjectServiceStatus: Decodable, Equatable, Sendable {
    let state: String
    let configurationError: String?
    let freshness: String
    let running: Bool?
    let healthy: Bool?
    let mainHeadOid: String?
    let runningRevision: String?
    let runningBranch: String?
    let runningCommitTime: String?
    let dirty: Bool?
    let startedAt: String?
    let worktreePath: String?
    let desiredProfile: String?
    let runningProfile: String?
    let artifactId: String?
    let sourceFingerprint: String?
    let verified: Bool?
    let verificationDetail: String?
}

struct ProjectWorktreeActionResponse: Decodable, Sendable {
    let deletedSessionIds: [String]?
}

struct ProjectIntegrationStatusResponse: Decodable, Equatable, Sendable {
    let projectId: String
    let objective: ProjectIntegrationObjective
    let mainHeadOid: String
    let eligibleWorktrees: [ProjectIntegrationCandidate]
    let excludedWorktrees: [ProjectIntegrationExcludedCandidate]
    let eligibleAgents: [ProjectIntegrationAgent]
    let latestRun: ProjectIntegrationRun?
}

struct ProjectIntegrationObjective: Decodable, Equatable, Sendable {
    let id: String
    let name: String
}

struct ProjectIntegrationCandidate: Identifiable, Decodable, Equatable, Sendable {
    var id: String { worktreeId }
    let worktreeId: String
    let path: String
    let branchName: String?
    let headOid: String?
    let workItemId: String?
    let workItemTitle: String?
}

struct ProjectIntegrationExcludedCandidate: Identifiable, Decodable, Equatable, Sendable {
    var id: String { worktreeId }
    let worktreeId: String
    let path: String
    let branchName: String?
    let headOid: String?
    let workItemId: String?
    let workItemTitle: String?
    let reason: String
}

struct ProjectIntegrationAgent: Identifiable, Decodable, Equatable, Sendable {
    var id: String { agentId }
    let agentId: String
    let name: String
    let role: String
}

struct ProjectIntegrationRun: Identifiable, Decodable, Equatable, Sendable {
    let id: String
    let repositoryId: String
    let objectiveId: String
    let status: String
    let mainHeadBefore: String
    let mainHeadAfter: String?
    let integrationWorktreeId: String?
    let integrationWorktreePath: String?
    let integrationBranch: String?
    let conflictWorkItemId: String?
    let conflictSessionId: String?
    let error: String?
    let items: [ProjectIntegrationRunItem]
    let counts: ProjectIntegrationCounts
    let createdAt: String
    let updatedAt: String
    let completedAt: String?
}

struct ProjectIntegrationRunItem: Identifiable, Decodable, Equatable, Sendable {
    var id: String { worktreeId }
    let runId: String
    let worktreeId: String
    let workItemId: String
    let workItemTitle: String
    let branchName: String?
    let sourceHeadOid: String
    let ordinal: Int
    let status: String
    let conflictFiles: [String]
    let mergedMainHead: String?
    let error: String?
    let updatedAt: String
}

struct ProjectIntegrationCounts: Decodable, Equatable, Sendable {
    let total: Int
    let integrated: Int
    let conflicts: Int
    let failed: Int
    let pending: Int
}

struct ProjectIntegrationConflictWorkItemResponse: Decodable, Sendable {
    let run: ProjectIntegrationRun
    let workItem: WorkItem
    let session: TaskSession?
    let reused: Bool
}

struct GitCommitProtectionStatus: Decodable, Equatable, Sendable {
    let repositoryRoot: String
    let protectedPaths: [String]
    let localSymlinkPaths: [String]?
    let suggestedIgnorePatterns: [String]
    let warningEnabled: Bool
    let requiresDecision: Bool
}

enum WorktreeCommitReviewOperation: String, Equatable, Sendable {
    case commit
    case merge
    case complete
    case operate
}

struct WorktreeCommitReviewPrompt: Identifiable, Equatable, Sendable {
    var id: String { worktree.worktreeId }
    let worktree: ProjectWorktreeStatus
    let protection: GitCommitProtectionStatus
    let operation: WorktreeCommitReviewOperation
}

struct GitHubPushPreparation: Identifiable, Decodable, Equatable, Sendable {
    var id: String { confirmationToken }
    let confirmationToken: String
    let expiresAt: String
    let repository: String
    let destinationService: String
    let remoteName: String
    let remoteUrl: String
    let destinationUrl: String
    let branch: String
    let includesSourceCode: Bool
    let visibility: String
    let retention: String
    let action: String
    let dirty: Bool
    let changedFiles: [String]
    let filesToPush: [String]
    let addedFiles: [String]?
    let modifiedFiles: [String]?
    let deletedFiles: [String]?
    let commitsToPush: [GitHubPushCommit]
    let statusSummary: String
    let commitProtection: GitCommitProtectionStatus?
}

struct GitHubPushCommit: Decodable, Equatable, Sendable {
    let oid: String
    let subject: String
}

struct GitHubPushResult: Decodable, Sendable {
    let pushed: Bool
    let committed: Bool
    let commitMessage: String?
    let headOid: String
    let branch: String
    let destinationUrl: String
}

struct GitHubCommitMessageSuggestion: Decodable, Sendable {
    let commitMessage: String
}

struct SessionCapabilities: Codable, Equatable, Sendable {
    let canSend: Bool?
    let canSwitchModel: Bool?
    let canSwitchReasoning: Bool?
    let canInterrupt: Bool?
    let canReconnect: Bool?
    let canPrepareExecution: Bool?
}

struct SessionActionAvailability: Codable, Equatable, Sendable {
    let available: Bool
    let reason: String?
    let retryable: Bool?
}

struct SessionActions: Codable, Equatable, Sendable {
    let resume: SessionActionAvailability?
    let prepareExecution: SessionActionAvailability?
    let delete: SessionActionAvailability?
    let restart: SessionActionAvailability?
    let disconnect: SessionActionAvailability?
    let send: SessionActionAvailability
    let interrupt: SessionActionAvailability
    let approve: SessionActionAvailability
    let switchModel: SessionActionAvailability
    let switchReasoning: SessionActionAvailability
    let updatePermissions: SessionActionAvailability?
    let switchWorkspace: SessionActionAvailability
    let switchProvider: SessionActionAvailability
}

enum TaskStatus: String, Codable, Sendable {
    case running
    case blocked
    case complete
    case failed
    case cancelled

    @MainActor var label: String {
        switch self {
        case .running: L10n("Running")
        case .blocked: L10n("Blocked")
        case .complete: L10n("Complete")
        case .failed: L10n("Failed")
        case .cancelled: L10n("Interrupted")
        }
    }

    var color: Color {
        switch self {
        case .running: CorptiePalette.running
        case .blocked: .orange
        case .complete: .orange
        case .failed: .red
        case .cancelled: .red
        }
    }
}

enum Accent: String, Codable, Sendable {
    case cyan
    case mint
    case violet
    case amber

    var color: Color {
        switch self {
        case .cyan: CorptiePalette.softBlue
        case .mint: CorptiePalette.connected
        case .violet: CorptiePalette.periwinkle
        case .amber: CorptiePalette.amber
        }
    }
}

enum CorptiePalette {
    static let running = adaptiveColor(light: (0.24, 0.43, 0.70), dark: (0.55, 0.68, 0.86))
    static let softBlue = adaptiveColor(light: (0.28, 0.45, 0.70), dark: (0.50, 0.64, 0.82))
    static let connected = adaptiveColor(light: (0.08, 0.70, 0.34), dark: (0.62, 0.82, 0.66))
    static let connectedDot = adaptiveColor(light: (0.00, 0.95, 0.38), dark: (0.28, 1.00, 0.42))
    static let disconnected = adaptiveColor(light: (1.00, 0.12, 0.10), dark: (1.00, 0.22, 0.18))
    static let unboundDot = adaptiveColor(light: (0.58, 0.61, 0.63), dark: (0.62, 0.66, 0.68))
    static let periwinkle = adaptiveColor(light: (0.45, 0.36, 0.70), dark: (0.66, 0.62, 0.84))
    static let amber = adaptiveColor(light: (0.66, 0.43, 0.10), dark: (0.86, 0.68, 0.38))
    static let collaborationSurface = adaptiveColor(light: (0.96, 0.88, 0.76), dark: (0.27, 0.22, 0.17))
    static let collaborationBorder = adaptiveColor(light: (0.76, 0.58, 0.38), dark: (0.62, 0.49, 0.34))
    static let primaryText = adaptiveColor(light: (0.10, 0.12, 0.13), dark: (0.94, 0.96, 0.96))
    static let secondaryText = adaptiveColor(light: (0.24, 0.27, 0.29), dark: (0.78, 0.82, 0.84))
    static let mutedText = adaptiveColor(light: (0.38, 0.41, 0.43), dark: (0.62, 0.66, 0.68))
    static let disabledText = adaptiveColor(light: (0.56, 0.58, 0.59), dark: (0.48, 0.51, 0.53))
    static let glassVeilIdle = adaptiveColor(light: (0.94, 0.97, 1.00, 0.00), dark: (0.08, 0.10, 0.12, 0.00))
    static let glassVeilFocused = adaptiveColor(light: (0.96, 0.98, 1.00, 0.54), dark: (0.07, 0.09, 0.11, 0.48))
    static let inputBorder = adaptiveColor(light: (0.42, 0.52, 0.62), dark: (0.58, 0.66, 0.72))
    static let inputBorderFocused = adaptiveColor(light: (0.24, 0.42, 0.62), dark: (0.64, 0.76, 0.86))
    static let inputFill = adaptiveColor(light: (0.92, 0.96, 1.00, 0.08), dark: (0.10, 0.13, 0.16, 0.12))
    static let inputFillFocused = adaptiveColor(light: (0.90, 0.95, 1.00, 0.16), dark: (0.10, 0.14, 0.18, 0.18))
    static let cardPreviewText = adaptiveColor(light: (0.16, 0.18, 0.19), dark: (0.78, 0.82, 0.84))
    static let userText = adaptiveColor(light: (0.22, 0.35, 0.62), dark: (0.62, 0.70, 0.84))
    static let agentText = adaptiveColor(light: (0.18, 0.48, 0.27), dark: (0.62, 0.76, 0.66))

    private static func adaptiveColor(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        adaptiveColor(light: (light.0, light.1, light.2, 1), dark: (dark.0, dark.1, dark.2, 1))
    }

    private static func adaptiveColor(light: (Double, Double, Double, Double), dark: (Double, Double, Double, Double)) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let bestMatch = appearance.bestMatch(from: [.darkAqua, .aqua])
            let rgb = bestMatch == .darkAqua ? dark : light
            return NSColor(calibratedRed: rgb.0, green: rgb.1, blue: rgb.2, alpha: rgb.3)
        })
    }
}

struct SessionsResponse: Decodable, Sendable {
    let sessions: [TaskSession]
}

struct SessionCollectionSnapshotEnvelope: Decodable, Sendable {
    let revision: UInt64
    let sessions: [TaskSession]
}

struct SessionCollectionPatchEnvelope: Decodable, Sendable {
    struct Insertion: Decodable, Sendable {
        let index: Int
        let session: TaskSession
    }

    struct Update: Decodable, Sendable {
        let sessionId: String
        let changedFields: [String]
        let session: TaskSession
    }

    let baseRevision: UInt64
    let revision: UInt64
    let orderedIds: [String]?
    let inserted: [Insertion]
    let removedIds: [String]
    let updated: [Update]
}

struct CollaborationOverviewResponse: Decodable {
    let agents: [CollaborationAgent]
    let services: [CollaborationService]
    let tasks: [CollaborationTask]
}

struct CollaborationTaskResponse: Decodable {
    let task: CollaborationTask
    let deliveries: [CollaborationDelivery]?
}

struct CollaborationServiceResponse: Decodable {
    let service: CollaborationService
}

struct CollaborationDeliveryResponse: Decodable {
    let delivery: CollaborationDelivery
}

struct CollaborationAgent: Identifiable, Decodable, Equatable {
    var id: String { agentId }
    let agentId: String
    let name: String
    let description: String
    let status: String
    let capabilities: [String]
    let currentSessionId: String?
    let currentObjectiveId: String?
    let currentWorkItemId: String?
    let objectiveIds: [String]?
    let createdAt: String
    let updatedAt: String
}

struct CollaborationService: Identifiable, Decodable, Equatable {
    var id: String { serviceId }
    let serviceId: String
    let name: String
    let description: String
    let ownerAgentId: String
    let currentVersion: String?
    let status: String
    let endpoint: String?
    let repositoryRoot: String?
    let createdAt: String
    let updatedAt: String
}

struct CollaborationTask: Identifiable, Decodable, Equatable {
    var id: String { taskId }
    let taskId: String
    let contextId: String
    let parentTaskId: String?
    let protocolVersion: String?
    let sourceObjectiveId: String?
    let targetObjectiveId: String?
    let sourceWorkItemId: String?
    let workItemId: String?
    let initiatorAgentId: String
    let recipientAgentId: String
    let initiatorSessionId: String?
    let recipientSessionId: String?
    let initiatorNameAtSend: String?
    let recipientNameAtSend: String?
    let routingVersion: Int?
    let routeStatus: String?
    let artifactStatus: String?
    let acceptanceStatus: String?
    let initiatorBindingId: String?
    let recipientBindingId: String?
    let serviceId: String?
    let type: String
    let status: String
    let iteration: Int
    let maxIterations: Int
    let title: String
    let summary: String
    let acceptanceCriteria: [String]
    let createdAt: String
    let updatedAt: String
    let completedAt: String?
    let messages: [CollaborationMessage]?
    let artifacts: [CollaborationArtifact]?
    let events: [CollaborationEvent]?
}

struct CollaborationMessage: Identifiable, Decodable, Equatable {
    var id: String { messageId }
    let messageId: String
    let taskId: String
    let senderAgentId: String
    let recipientAgentId: String
    let messageType: String
    let body: String
    let resourceVersion: String?
    let createdAt: String
    let envelope: CollaborationMessageEnvelope?
}

struct CollaborationMessageEnvelope: Decodable, Equatable {
    let version: String
    let messageId: String
    let messageType: String
    let sender: CollaborationMessageParty
    let recipient: CollaborationMessageParty
    let objective: CollaborationMessageObjectiveRoute
    let workItem: CollaborationMessageWorkItemRoute
    let taskId: String
    let payload: CollaborationMessagePayload
    let timestamp: String
    let error: CollaborationMessageError?
}

struct CollaborationMessageParty: Decodable, Equatable {
    let agentId: String
    let sessionId: String?
    let objectiveId: String
}

struct CollaborationMessageObjectiveRoute: Decodable, Equatable {
    let sourceId: String
    let targetId: String
}

struct CollaborationMessageWorkItemRoute: Decodable, Equatable {
    let id: String
    let sourceId: String?
}

struct CollaborationMessagePayload: Decodable, Equatable {
    let body: String
    let evidence: [JSONValue]?
    let resourceVersion: String?
}

struct CollaborationMessageError: Decodable, Equatable {
    let code: String
    let message: String
    let retryable: Bool?
}

indirect enum JSONValue: Decodable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }
}

struct CollaborationArtifact: Identifiable, Decodable, Equatable {
    var id: String { artifactId }
    let artifactId: String
    let taskId: String
    let producerAgentId: String
    let type: String
    let name: String
    let uri: String
    let createdAt: String
}

struct CollaborationEvent: Identifiable, Decodable, Equatable {
    var id: String { eventId }
    let eventId: String
    let taskId: String
    let sequence: Int
    let type: String
    let actorAgentId: String?
    let createdAt: String
}

struct CollaborationDelivery: Identifiable, Decodable, Equatable {
    var id: String { deliveryId }
    let deliveryId: String
    let messageId: String
    let recipientAgentId: String
    let status: String
    let attemptCount: Int
    let nextAttemptAt: String?
    let deliveredAt: String?
    let targetTurnId: String?
    let lastError: String?
    let createdAt: String
    let updatedAt: String
}

struct BackendErrorResponse: Decodable {
    let error: String
}

struct FeishuBotsResponse: Decodable {
    let bots: [FeishuBot]
}

struct FeishuProfilesResponse: Decodable {
    let profiles: [FeishuProfile]
}

struct FeishuProfile: Codable, Identifiable, Equatable {
    var id: String { name }
    let name: String
    let appId: String?
    let brand: String?
    let active: Bool
}

struct FeishuBotResponse: Decodable {
    let bot: FeishuBot
}

struct FeishuPairingCodeResponse: Decodable {
    let code: String
    let expiresAt: String
}

struct FeishuBot: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let profile: String
    let appId: String?
    let brand: String?
    let managedProfile: Bool?
    let remoteName: String?
    let remoteAvatarURL: String?
    let remoteOpenId: String?
    let remoteActivateStatus: Int?
    let transportType: String
    let enabled: Bool
    let connectionStatus: String
    let lastError: String?
    let createdAt: String
    let updatedAt: String
    let bindings: [FeishuBinding]
    let assignment: FeishuSessionAssignment?
    let runtime: String
}

struct FeishuBinding: Codable, Identifiable, Equatable {
    let id: String
    let botId: String
    let openId: String
    let chatId: String?
    let tenantKey: String?
    let verifiedAt: String
    let revokedAt: String?
}

struct FeishuSessionAssignment: Codable, Identifiable, Equatable {
    let id: String
    let botId: String
    let bindingId: String
    let sessionId: String
    let assignedAt: String
    let lastEventSequence: Int
}

struct CodexThreadDetailResponse: Decodable, Sendable {
    let thread: CodexThreadDetail
}

struct UnifiedSessionSnapshotResponse: Decodable, Sendable {
    let session: CodexThreadDetail
}

struct SessionHistoryResponse: Decodable, Sendable {
    let sessionId: String?
    let logicalSessionId: String?
    let items: [CodexThreadItem]
    let hasMoreHistory: Bool?
    let historyItemsCount: Int?
}

struct SessionUsageResponse: Decodable, Equatable {
    let account: CodexAccountUsage
    let context: CodexContextUsage?
    var resetForecast: CodexResetForecastSnapshot? = nil
}

struct CodexResetForecastSnapshot: Decodable, Equatable {
    let forecast: CodexResetForecast?
    let checkedAt: String?
    let sourceHealthy: Bool?
    let sourceError: String?
    let sourceUrl: String?
}

struct CodexResetForecast: Decodable, Equatable {
    let postId: String
    let text: String
    let url: String?
    let publishedAt: String
    let estimateLabel: String
    let expiresAt: String
}

struct SessionUsageEventEnvelope: Decodable {
    let payload: SessionUsageEventPayload
}

struct SessionUsageEventPayload: Decodable {
    let sessionId: String
    let context: CodexContextUsage
}

struct SessionWorkspaceSwitchedEventEnvelope: Decodable {
    let payload: SessionWorkspaceSwitchedEventPayload
}

struct SessionWorkspaceSwitchedEventPayload: Decodable {
    let session: TaskSession
}

struct SessionTransitionEventEnvelope: Decodable {
    let payload: SessionTransitionEventPayload
}

struct SessionTransitionEventPayload: Decodable {
    let sessionId: String?
}

struct SessionProviderSwitchPendingEventEnvelope: Decodable {
    let payload: SessionProviderSwitchPendingEventPayload
}

struct SessionProviderSwitchPendingEventPayload: Decodable {
    let sessionId: String?
}

struct SessionProviderSwitchedEventEnvelope: Decodable {
    let payload: SessionProviderSwitchedEventPayload
}

struct SessionProviderSwitchedEventPayload: Decodable {
    let sessionId: String?
}

struct ProviderSessionChangedEventEnvelope: Decodable {
    let payload: ProviderSessionChangedEventPayload
}

struct ProviderSessionChangedEventPayload: Decodable {
    let sessionId: String?
    let type: String?
    let eventType: String?
}

struct CodexAccountUsage: Decodable, Equatable {
    let available: Bool?
    let provider: String?
    let model: String?
    let rateLimits: CodexRateLimitSnapshot?
    let rateLimitsByLimitId: [String: CodexRateLimitSnapshot]?
}

struct CodexRateLimitSnapshot: Decodable, Equatable {
    let limitId: String?
    let limitName: String?
    let primary: CodexRateLimitWindow?
    let secondary: CodexRateLimitWindow?
}

struct CodexRateLimitWindow: Decodable, Equatable {
    let usedPercent: Double?
    let windowDurationMins: Int?
    let resetsAt: Double?
}

struct CodexContextUsage: Decodable, Equatable {
    let usedTokens: Double?
    let contextWindow: Double?
    let remainingTokens: Double?
    let usedPercent: Double?
}

struct CodexThreadDetail: Decodable, Equatable, Sendable {
    let id: String
    let title: String
    let status: TaskStatus
    let source: String?
    let connectionStatus: String?
    let currentModel: String?
    let currentReasoningLevel: String?
    let activityStatus: String?
    let cwd: String?
    let createdAt: String
    let updatedAt: String
    let canSend: Bool?
    let sendUnavailableReason: String?
    let capabilities: SessionCapabilities?
    let turnCount: Int
    let items: [CodexThreadItem]
    var lastAgentMessageSequence: Int? = nil
    var hasMoreHistory: Bool? = nil
    var historyItemsCount: Int? = nil
    var actions: SessionActions? = nil

    var isConnected: Bool {
        SessionConnectionPresentation.isConnected(
            status: connectionStatus,
            usesManualConnection: usesManualConnection
        )
    }

    var isConnecting: Bool {
        isConnectingStatus(connectionStatus, provider: source)
    }

    var usesManualConnection: Bool {
        if let disconnect = actions?.disconnect {
            return disconnect.available || disconnect.reason != "CAPABILITY_UNSUPPORTED"
        }
        return connectionStatus?.localizedCaseInsensitiveContains("pty") == true
    }

    var canInterruptNow: Bool {
        actions?.interrupt.available ?? capabilities?.canInterrupt ?? false
    }

    var canSwitchModelNow: Bool {
        actions?.switchModel.available ?? capabilities?.canSwitchModel ?? false
    }

    var canSwitchReasoningNow: Bool {
        actions?.switchReasoning.available ?? capabilities?.canSwitchReasoning ?? false
    }

    var connectionColor: Color {
        isConnected ? CorptiePalette.connectedDot : CorptiePalette.disconnected
    }

    // Compare revision-bearing metadata before the potentially large item
    // array. Streaming updates normally change updatedAt, so the common path
    // is O(1); unchanged metadata still retains strict Equatable semantics.
    static func == (lhs: CodexThreadDetail, rhs: CodexThreadDetail) -> Bool {
        guard lhs.id == rhs.id,
              lhs.title == rhs.title,
              lhs.status == rhs.status,
              lhs.source == rhs.source,
              lhs.connectionStatus == rhs.connectionStatus,
              lhs.currentModel == rhs.currentModel,
              lhs.currentReasoningLevel == rhs.currentReasoningLevel,
              lhs.activityStatus == rhs.activityStatus,
              lhs.cwd == rhs.cwd,
              lhs.createdAt == rhs.createdAt,
              lhs.updatedAt == rhs.updatedAt,
              lhs.canSend == rhs.canSend,
              lhs.sendUnavailableReason == rhs.sendUnavailableReason,
              lhs.capabilities == rhs.capabilities,
              lhs.turnCount == rhs.turnCount,
              lhs.lastAgentMessageSequence == rhs.lastAgentMessageSequence,
              lhs.hasMoreHistory == rhs.hasMoreHistory,
              lhs.historyItemsCount == rhs.historyItemsCount,
              lhs.actions == rhs.actions else {
            return false
        }
        return lhs.items == rhs.items
    }
}

struct CodexModelsResponse: Decodable {
    let currentModel: String?
    let currentReasoningLevel: String?
    let models: [CodexModel]
}

struct AgentProviderDescriptor: Identifiable, Decodable, Equatable, Sendable {
    let id: String
    let displayName: String
    let transport: String
    let aliases: [String]
    let capabilities: [String]
    let runtime: AgentProviderRuntimeDescriptor
    let configuration: AgentProviderConfigurationDescriptor

    func supports(_ capability: String) -> Bool {
        capabilities.contains(capability)
    }

    func matches(_ providerIdentity: String?) -> Bool {
        guard let providerIdentity else { return false }
        let normalized = providerIdentity.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return false }
        return id.lowercased() == normalized
            || aliases.contains(where: { $0.lowercased() == normalized })
    }
}

extension Collection where Element == AgentProviderDescriptor {
    func descriptor(matching providerIdentity: String?) -> AgentProviderDescriptor? {
        first(where: { $0.matches(providerIdentity) })
    }

    func canonicalProviderId(for providerIdentity: String?) -> String? {
        descriptor(matching: providerIdentity)?.id
    }

    func displayName(for providerIdentity: String?) -> String? {
        descriptor(matching: providerIdentity)?.displayName
    }

    /// Provider switching is server-authoritative. The client only needs to know
    /// whether the catalog contains a different Provider capable of creating the
    /// replacement Session; it must not gate the menu on an optional cached
    /// SessionActions projection.
    func sessionProviderAlternatives(to currentProviderIdentity: String?) -> [AgentProviderDescriptor] {
        filter {
            $0.supports("session.create") && !$0.matches(currentProviderIdentity)
        }
    }
}

struct AgentProviderRuntimeDescriptor: Decodable, Equatable, Sendable {
    let lifecycle: String
}

struct AgentProviderConfigurationDescriptor: Decodable, Equatable, Sendable {
    let fields: [AgentProviderConfigurationField]
}

struct AgentProviderConfigurationField: Identifiable, Decodable, Equatable, Sendable {
    let id: String
    let type: String
    let label: String?
    let required: Bool?
    let defaultValue: String?
}

struct AgentProvidersResponse: Decodable, Sendable {
    let defaultProviderId: String?
    let providers: [AgentProviderDescriptor]
}

enum SessionConnectionPresentation {
    static func isConnected(status: String?, usesManualConnection: Bool) -> Bool {
        guard let normalized = status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !normalized.isEmpty else {
            return !usesManualConnection
        }
        return normalized.contains("connected")
            && !normalized.contains("disconnected")
            && !normalized.contains("connecting")
    }
}

private func isConnectingStatus(_ status: String?, provider _: String?) -> Bool {
    return status?.localizedCaseInsensitiveContains("connecting") == true
}

struct CodexSessionLookupResponse: Decodable, Equatable {
    let id: String
    let cwd: String?
    let rolloutPath: String?
    let timestampMs: Double?
    let error: String?
}

struct CodexModel: Identifiable, Decodable, Equatable {
    let id: String
    let name: String
    let description: String?
    let defaultReasoningLevel: String?
    let reasoningLevels: [String]?
    let serviceTiers: [CodexServiceTier]?
}

struct CodexServiceTier: Decodable, Equatable {
    let id: String
    let name: String
}

struct CodexThreadItem: Identifiable, Decodable, Equatable, Sendable {
    let id: String
    let turnId: String
    let turnStatus: String
    let type: String
    let title: String
    let text: String
    let options: [CodexApprovalOption]?
    let status: String?
    let createdAt: String?
    var rawMetadataJSON: String? = nil
    /// Presentation-only lifecycle bounds derived from the complete turn.
    /// Process cards contain only execution items, so their own timestamps are
    /// insufficient to measure a single-step turn accurately.
    var processStartedAt: String? = nil
    var processEndedAt: String? = nil
    var userMessageStatus: String? = nil
    var queuePosition: Int? = nil
    var processingError: String? = nil
    var sourceType: String? = nil
    var localVisibility: String? = nil
    var workItemId: String? = nil
    var collaborationTaskId: String? = nil
    var presentationRole: String? = nil
    var presentationText: String? = nil
    var collaborationDirection: String? = nil
    var collaborationSenderAgentId: String? = nil
    var collaborationSenderName: String? = nil
    var collaborationRecipientAgentId: String? = nil
    var collaborationRecipientName: String? = nil
    var collaborationInitiatorSessionId: String? = nil
    var collaborationInitiatorSessionTitle: String? = nil
    var collaborationInitiatorSessionKind: String? = nil
    var collaborationRecipientSessionId: String? = nil
    var collaborationRecipientSessionTitle: String? = nil
    var collaborationRecipientSessionKind: String? = nil
    var collaborationSourceObjectiveId: String? = nil
    var collaborationSourceObjectiveName: String? = nil
    var collaborationTargetObjectiveId: String? = nil
    var collaborationTargetObjectiveName: String? = nil
    var collaborationSourceWorkItemId: String? = nil
    var collaborationTargetWorkItemId: String? = nil
    var collaborationRelation: String? = nil
    var collaborationRouteStatus: String? = nil
    var collaborationRoutingVersion: Int? = nil
    var collaborationTaskTitle: String? = nil
    var collaborationMessageKind: String? = nil
    var collaborationProcessingStatus: String? = nil
    var collaborationConfirmationId: String? = nil
    var collaborationConfirmationStatus: String? = nil
    var collaborationAcceptanceCriteria: [String]? = nil
    var fileChanges: [CodexFileChange]? = nil
    var turnDiff: String? = nil

    var authoritativeUserMessageState: UserMessageProcessingState? {
        guard type == "userMessage" else { return nil }
        return UserMessageProcessingState(
            authoritativeValue: userMessageStatus,
            legacyStatus: status
        )
    }
}

enum UserMessageProcessingState: String, Equatable, Sendable {
    case queued
    case processing
    case consumed
    case failed
    case cancelled

    init?(authoritativeValue: String?, legacyStatus: String?) {
        if let authoritativeValue {
            guard let state = Self(rawValue: authoritativeValue.lowercased()) else { return nil }
            self = state
            return
        }
        // Compatibility with snapshots produced before userMessageStatus was
        // added. Only explicit server status values qualify; timeline position
        // is never used to infer lifecycle.
        switch legacyStatus?.lowercased() {
        case "queued": self = .queued
        case "running", "processing": self = .processing
        default: return nil
        }
    }
}

struct CodexFileChange: Decodable, Equatable, Sendable {
    let path: String
    let kind: String
}

struct CodexApprovalOption: Identifiable, Codable, Equatable, Sendable {
    let id: String
    let label: String
    let role: String?
    let index: Int?
    let selected: Bool?
}

struct SendMessageResponse: Decodable {
    let mode: String?
    let cleared: Bool?
    let sessionId: String?
    let session: TaskSession?
    let queued: Bool?
    let queuePosition: Int?
    let warning: String?
    let error: String?
    let hint: String?
    let visibleInCodexDesktop: Bool?
}

struct SessionReplacement: Decodable, Equatable, Sendable {
    let previousSessionId: String
    let session: TaskSession
}

struct SessionClearedEventEnvelope: Decodable {
    let payload: SessionReplacement
}

struct CreateCodexThreadResponse: Decodable {
    let session: TaskSession?
    let warning: String?
    let error: String?
    let code: String?
    let suggestedTitle: String?
}

struct CreatePtySessionResponse: Decodable {
    let session: TaskSession?
    let error: String?
    let code: String?
    let suggestedTitle: String?
}

struct BackendSettings: Codable, Equatable {
    let environment: String?
    let configPath: String?
    let dataDir: String
    let dbPath: String
    let logDir: String?
    let logPaths: BackendLogPaths?
    let legacyDbPath: String?
    let choiceParser: ChoiceParserSettings?
    let codexBackend: CodexBackendSettings?
    let codeDiff: CodeDiffSettings?
    let agentProxy: AgentProxySettings?
    let newSessionDefaults: NewSessionDefaults?
    let gateway: GatewaySettings?
}

struct BackendLogPaths: Codable, Equatable {
    let stdout: String
    let stderr: String
}

struct GatewaySettings: Codable, Equatable {
    var trustedWorkspaces: [String]

    static let defaults = GatewaySettings(trustedWorkspaces: [])
}

struct NewSessionDefaults: Codable, Equatable {
    var sandbox: String
    var approvalPolicy: String
    var codexModel: String?
    var codexReasoningLevel: String?
    var claudeModel: String?
}

struct CodexBackendSettings: Codable, Equatable {
    var mode: String

    static let defaults = CodexBackendSettings(mode: "app-server")
}

struct CodeDiffSettings: Codable, Equatable {
    var tool: String

    static let defaults = CodeDiffSettings(tool: "automatic")
}

struct ChoiceParserSettings: Codable, Equatable {
    var provider: String
    var openaiBaseURL: String
    var openaiApiKey: String
    var openaiModel: String
    var localCommand: String
    var localArgs: String
    var localModel: String
    var timeoutMs: Int

    static let defaults = ChoiceParserSettings(
        provider: "local-agent",
        openaiBaseURL: "https://api.openai.com/v1",
        openaiApiKey: "",
        openaiModel: "gpt-4o-mini",
        localCommand: "codex",
        localArgs: "",
        localModel: "",
        timeoutMs: 12000
    )

    enum CodingKeys: String, CodingKey {
        case provider
        case openaiBaseURL
        case openaiApiKey
        case openaiModel
        case localCommand
        case localArgs
        case localModel
        case timeoutMs
    }

    init(
        provider: String,
        openaiBaseURL: String,
        openaiApiKey: String,
        openaiModel: String,
        localCommand: String,
        localArgs: String,
        localModel: String,
        timeoutMs: Int
    ) {
        self.provider = provider
        self.openaiBaseURL = openaiBaseURL
        self.openaiApiKey = openaiApiKey
        self.openaiModel = openaiModel
        self.localCommand = localCommand
        self.localArgs = localArgs
        self.localModel = localModel
        self.timeoutMs = timeoutMs
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? Self.defaults.provider
        openaiBaseURL = try container.decodeIfPresent(String.self, forKey: .openaiBaseURL) ?? Self.defaults.openaiBaseURL
        openaiApiKey = try container.decodeIfPresent(String.self, forKey: .openaiApiKey) ?? Self.defaults.openaiApiKey
        openaiModel = try container.decodeIfPresent(String.self, forKey: .openaiModel) ?? Self.defaults.openaiModel
        localCommand = try container.decodeIfPresent(String.self, forKey: .localCommand) ?? Self.defaults.localCommand
        localArgs = try container.decodeIfPresent(String.self, forKey: .localArgs) ?? Self.defaults.localArgs
        localModel = try container.decodeIfPresent(String.self, forKey: .localModel) ?? Self.defaults.localModel
        timeoutMs = try container.decodeIfPresent(Int.self, forKey: .timeoutMs) ?? Self.defaults.timeoutMs
    }
}

struct ChoiceParserTestResponse: Decodable {
    let ok: Bool
    let error: String?
    let durationMs: Int?
}

struct AgentProxySettings: Codable, Equatable {
    var codex: AgentProxyProfile
    var choiceParser: AgentProxyProfile
    var pty: AgentProxyProfile

    static let defaults = AgentProxySettings(
        codex: .defaults,
        choiceParser: .defaults,
        pty: .defaults
    )

    enum CodingKeys: String, CodingKey {
        case codex
        case choiceParser
        case pty
    }

    init(codex: AgentProxyProfile, choiceParser: AgentProxyProfile, pty: AgentProxyProfile) {
        self.codex = codex
        self.choiceParser = choiceParser
        self.pty = pty
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        codex = try container.decodeIfPresent(AgentProxyProfile.self, forKey: .codex) ?? .defaults
        choiceParser = try container.decodeIfPresent(AgentProxyProfile.self, forKey: .choiceParser) ?? .defaults
        pty = try container.decodeIfPresent(AgentProxyProfile.self, forKey: .pty) ?? .defaults
    }
}

struct AgentProxyProfile: Codable, Equatable {
    var enabled: Bool
    var httpProxy: String
    var httpsProxy: String
    var allProxy: String
    var noProxy: String

    static let defaults = AgentProxyProfile(
        enabled: false,
        httpProxy: "",
        httpsProxy: "",
        allProxy: "",
        noProxy: "localhost,127.0.0.1,::1,.local,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
    )
}
