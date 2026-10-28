import SwiftUI
import CorptieConversation

@MainActor
final class ConversationSkinController: ObservableObject {
    static let shared = ConversationSkinController(defaults: CorptieAppEnvironment.userDefaults)
    static let preferenceKey = "appearance.conversationSkin"
    @Published private(set) var skin: ConversationSkin
    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
        skin = defaults.string(forKey: Self.preferenceKey).flatMap(ConversationSkin.init(rawValue:)) ?? .classic
    }

    func select(_ next: ConversationSkin) {
        guard skin != next else { return }
        defaults.set(next.rawValue, forKey: Self.preferenceKey)
        skin = next
    }

    func restoreDefault() { select(.classic) }
}

/// Applied at independent hosting roots, not on each message or streaming update.
struct ConversationSkinHost: ViewModifier {
    @ObservedObject private var controller = ConversationSkinController.shared
    func body(content: Content) -> some View {
        content.environment(\.conversationSkin, controller.skin)
    }
}
