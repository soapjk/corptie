import SwiftUI

/// Appearance and reading variants. Workspace structure and execution semantics stay shared.
public enum ConversationSkin: String, CaseIterable, Sendable {
    case classic
    case codexFlat

    public var showsTimelineTimeSeparators: Bool { self == .classic }

    public func surface(for role: ConversationSurfaceRole) -> ConversationSurfaceStyle {
        guard self == .codexFlat else { return .legacy }
        switch role {
        case .assistant, .project: return .plain
        // User cards share the classic surface and its status halo in both skins.
        case .user: return .legacy
        case .composer: return .neutral
        case .process, .plan, .structured, .inspector, .interaction: return .legacy
        }
    }
}

public enum ConversationSurfaceRole: Sendable {
    case user, assistant, process, plan, inspector, project, structured, composer, interaction

    /// Non-prose reply cards keep one appearance and typography in every skin.
    var usesSharedReplyCard: Bool {
        switch self {
        case .process, .plan, .structured, .interaction: true
        default: false
        }
    }
}

public enum ConversationSurfaceStyle: Equatable, Sendable {
    case legacy, plain, bubble, neutral
}

private struct ConversationSkinKey: EnvironmentKey {
    static let defaultValue = ConversationSkin.classic
}

public extension EnvironmentValues {
    var conversationSkin: ConversationSkin {
        get { self[ConversationSkinKey.self] }
        set { self[ConversationSkinKey.self] = newValue }
    }
}
