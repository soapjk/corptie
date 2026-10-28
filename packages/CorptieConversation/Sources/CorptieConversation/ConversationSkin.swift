import SwiftUI

/// Paint-only variants. Geometry, content and execution semantics never depend on a skin.
public enum ConversationSkin: String, CaseIterable, Sendable {
    case classic
    case codexFlat

    public func surface(for role: ConversationSurfaceRole) -> ConversationSurfaceStyle {
        guard self == .codexFlat else { return .legacy }
        switch role {
        case .assistant, .process, .plan, .project: return .plain
        case .user: return .bubble
        case .structured, .composer: return .neutral
        case .inspector, .interaction: return .legacy
        }
    }
}

public enum ConversationSurfaceRole: Sendable {
    case user, assistant, process, plan, inspector, project, structured, composer, interaction
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
