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
    let activityStatus: String?
    let updatedAt: String
    let accent: Accent
    let archived: Bool?
    let pinned: Bool?
    let sortOrder: Double?
    let avatarPath: String?
    let external: ExternalSession?

    var isConnected: Bool {
        external?.connectionStatus?.localizedCaseInsensitiveContains("connected") == true
            && external?.connectionStatus?.localizedCaseInsensitiveContains("disconnected") != true
            && external?.connectionStatus?.localizedCaseInsensitiveContains("connecting") != true
    }

    var isConnecting: Bool {
        external?.connectionStatus?.localizedCaseInsensitiveContains("connecting") == true
    }

    var isUnboundCodexSession: Bool {
        external?.provider == "codex-pty" && (external?.agentSessionId?.isEmpty ?? true)
    }

    var connectionColor: Color {
        if isUnboundCodexSession {
            return CopetsPalette.unboundDot
        }
        return isConnected ? CopetsPalette.connectedDot : CopetsPalette.disconnected
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

enum TaskStatus: String, Codable {
    case running
    case blocked
    case complete
    case failed
    case cancelled

    var label: String {
        switch self {
        case .running: "Running"
        case .blocked: "Needs input"
        case .complete: "Complete"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        }
    }

    var color: Color {
        switch self {
        case .running: CopetsPalette.running
        case .blocked: .orange
        case .complete: .green
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
        case .cyan: CopetsPalette.softBlue
        case .mint: CopetsPalette.connected
        case .violet: CopetsPalette.periwinkle
        case .amber: CopetsPalette.amber
        }
    }
}

enum CopetsPalette {
    static let running = adaptiveColor(light: (0.24, 0.43, 0.70), dark: (0.55, 0.68, 0.86))
    static let softBlue = adaptiveColor(light: (0.28, 0.45, 0.70), dark: (0.50, 0.64, 0.82))
    static let connected = adaptiveColor(light: (0.08, 0.70, 0.34), dark: (0.62, 0.82, 0.66))
    static let connectedDot = adaptiveColor(light: (0.00, 0.95, 0.38), dark: (0.28, 1.00, 0.42))
    static let disconnected = adaptiveColor(light: (1.00, 0.12, 0.10), dark: (1.00, 0.22, 0.18))
    static let unboundDot = adaptiveColor(light: (0.58, 0.61, 0.63), dark: (0.62, 0.66, 0.68))
    static let periwinkle = adaptiveColor(light: (0.45, 0.36, 0.70), dark: (0.66, 0.62, 0.84))
    static let amber = adaptiveColor(light: (0.66, 0.43, 0.10), dark: (0.86, 0.68, 0.38))
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

struct CodexThreadDetailResponse: Decodable {
    let thread: CodexThreadDetail
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
    let turnCount: Int
    let items: [CodexThreadItem]

    var isConnected: Bool {
        connectionStatus?.localizedCaseInsensitiveContains("connected") == true
            && connectionStatus?.localizedCaseInsensitiveContains("disconnected") != true
            && connectionStatus?.localizedCaseInsensitiveContains("connecting") != true
    }

    var isConnecting: Bool {
        connectionStatus?.localizedCaseInsensitiveContains("connecting") == true
    }

    var connectionColor: Color {
        isConnected ? CopetsPalette.connectedDot : CopetsPalette.disconnected
    }
}

struct CodexModelsResponse: Decodable {
    let currentModel: String?
    let currentReasoningLevel: String?
    let models: [CodexModel]
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
    let warning: String?
    let error: String?
    let hint: String?
    let visibleInCodexDesktop: Bool?
}

struct CreateCodexThreadResponse: Decodable {
    let session: TaskSession?
    let warning: String?
    let error: String?
}

struct CreatePtySessionResponse: Decodable {
    let session: TaskSession?
    let error: String?
}

struct BackendSettings: Codable, Equatable {
    let environment: String?
    let configPath: String?
    let dataDir: String
    let dbPath: String
    let legacyDbPath: String?
    let choiceParser: ChoiceParserSettings?
    let agentProxy: AgentProxySettings?
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
