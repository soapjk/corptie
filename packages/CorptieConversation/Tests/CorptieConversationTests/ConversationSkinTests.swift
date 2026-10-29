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
        #expect(skin.surface(for: .process) == .legacy)
        #expect(skin.surface(for: .plan) == .legacy)
        #expect(skin.surface(for: .user) == ConversationSkin.classic.surface(for: .user))
        #expect(skin.surface(for: .structured) == .legacy)
        #expect(skin.surface(for: .interaction) == .legacy)
        for role in [ConversationSurfaceRole.process, .plan, .structured, .interaction] {
            #expect(skin.surface(for: role) == ConversationSkin.classic.surface(for: role))
            #expect(skin.typography(for: role) == ConversationSkin.classic.typography(for: role))
        }
    }
}
