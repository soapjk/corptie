import Foundation
import AppKit
import SwiftUI

struct TaskSession: Identifiable, Codable, Equatable {
    let id: String
    let title: String
    let agent: String
    let status: TaskStatus
    let progress: Double
    let summary: String
    let suggestedOptions: [CodexApprovalOption]?
    let suggestedPrompt: String?
    let activityStatus: String?
    let updatedAt: String
    let accent: Accent
    let archived: Bool?
    let pinned: Bool?
    let sortOrder: Double?
    let avatarPath: String?
    let capabilities: SessionCapabilities?
    let external: ExternalSession?

    var isConnected: Bool {
        isConnectedStatus(external?.connectionStatus, provider: external?.provider)
    }

    var isConnecting: Bool {
        isConnectingStatus(external?.connectionStatus, provider: external?.provider)
    }

    var isUnboundCodexSession: Bool {
        external?.provider == "codex-pty" && (external?.agentSessionId?.isEmpty ?? true)
    }

    var connectionColor: Color {
        if isUnboundCodexSession {
            return CorptiePalette.unboundDot
        }
        return isConnected ? CorptiePalette.connectedDot : CorptiePalette.disconnected
    }
}

struct ExternalSession: Codable, Equatable {
    let provider: String
    let threadId: String?
    let sessionId: String?
    let agentSessionId: String?
    let connectionStatus: String?
    let currentModel: String?
    let currentReasoningLevel: String?
    let cwd: String?
    let source: String?
}

struct SessionCapabilities: Codable, Equatable {
    let canSend: Bool?
    let canSwitchModel: Bool?
    let canSwitchReasoning: Bool?
    let canInterrupt: Bool?
    let canReconnect: Bool?
}

enum TaskStatus: String, Codable {
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
        case .cancelled: L10n("Cancelled")
        }
    }

    var color: Color {
        switch self {
        case .running: CorptiePalette.running
        case .blocked: .orange
        case .complete: .orange
        case .failed: .red
        case .cancelled: .secondary
        }
    }
}

enum Accent: String, Codable {
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

struct SessionsResponse: Decodable {
    let sessions: [TaskSession]
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
    let initiatorAgentId: String
    let recipientAgentId: String
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

struct CodexThreadDetailResponse: Decodable {
    let thread: CodexThreadDetail
}

struct UnifiedSessionSnapshotResponse: Decodable {
    let session: CodexThreadDetail
}

struct CodexThreadDetail: Decodable, Equatable {
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

    var isConnected: Bool {
        isConnectedStatus(connectionStatus, provider: source)
    }

    var isConnecting: Bool {
        isConnectingStatus(connectionStatus, provider: source)
    }

    var connectionColor: Color {
        isConnected ? CorptiePalette.connectedDot : CorptiePalette.disconnected
    }
}

struct CodexModelsResponse: Decodable {
    let currentModel: String?
    let currentReasoningLevel: String?
    let models: [CodexModel]
}

private func isConnectedStatus(_ status: String?, provider: String?) -> Bool {
    if provider == "codex-app-server" {
        return true
    }
    guard let normalized = status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
          !normalized.isEmpty else {
        return false
    }
    return normalized.contains("connected")
        && !normalized.contains("disconnected")
        && !normalized.contains("connecting")
}

private func isConnectingStatus(_ status: String?, provider: String?) -> Bool {
    if provider == "codex-app-server" {
        return false
    }
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

struct CodexThreadItem: Identifiable, Decodable, Equatable {
    let id: String
    let turnId: String
    let turnStatus: String
    let type: String
    let title: String
    let text: String
    let options: [CodexApprovalOption]?
    let status: String?
    let createdAt: String?
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
    var collaborationTaskTitle: String? = nil
    var collaborationMessageKind: String? = nil
    var collaborationProcessingStatus: String? = nil
    var collaborationConfirmationId: String? = nil
    var collaborationConfirmationStatus: String? = nil
    var collaborationAcceptanceCriteria: [String]? = nil
    var fileChanges: [CodexFileChange]? = nil
    var turnDiff: String? = nil
}

struct CodexFileChange: Decodable, Equatable {
    let path: String
    let kind: String
}

struct CodexApprovalOption: Identifiable, Codable, Equatable {
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
    let legacyDbPath: String?
    let choiceParser: ChoiceParserSettings?
    let codexBackend: CodexBackendSettings?
    let codeDiff: CodeDiffSettings?
    let agentProxy: AgentProxySettings?
    let gateway: GatewaySettings?
}

struct GatewaySettings: Codable, Equatable {
    var trustedWorkspaces: [String]

    static let defaults = GatewaySettings(trustedWorkspaces: [])
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
