import SwiftUI
import Testing
@testable import CorptieConversation

@Suite("Conversation skin compatibility")
struct ConversationSkinTests {
    @Test func detailCardsRetainExistingSurfacesInEverySkin() {
        for skin in ConversationSkin.allCases {
            #expect(skin.surface(for: .inspector) == .legacy)
        }
    }

    @Test func defaultEnvironmentRetainsClassicSurfaces() {
        #expect(EnvironmentValues().conversationSkin == .classic)
        for role in [ConversationSurfaceRole.user, .assistant, .process, .plan, .inspector, .project, .structured, .composer, .interaction] {
            #expect(ConversationSkin.classic.surface(for: role) == .legacy)
        }
    }
    @Test func flatDistinguishesReadingFromInteractiveAndStructuredContent() {
        let skin = ConversationSkin.codexFlat
        #expect(skin.surface(for: .assistant) == .plain)
        #expect(skin.surface(for: .process) == .plain)
        #expect(skin.surface(for: .plan) == .plain)
        #expect(skin.surface(for: .user) == .bubble)
        #expect(skin.surface(for: .structured) == .neutral)
        #expect(skin.surface(for: .interaction) == .legacy)
    }
}
