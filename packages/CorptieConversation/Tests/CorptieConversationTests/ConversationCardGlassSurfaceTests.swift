import Testing
@testable import CorptieConversation

@Suite("Card glass accessibility policy")
struct ConversationCardGlassSurfaceTests {
    @Test("Only supported systems without reduced transparency use native glass")
    func availability() {
        #expect(ConversationFunctionalGlassSurface.usesNativeGlass(supported: true, reduceTransparency: false))
        #expect(!ConversationFunctionalGlassSurface.usesNativeGlass(supported: true, reduceTransparency: true))
        #expect(!ConversationFunctionalGlassSurface.usesNativeGlass(supported: false, reduceTransparency: false))
        #expect(!ConversationFunctionalGlassSurface.usesNativeGlass(supported: false, reduceTransparency: true))
    }

    @Test func translucentContentAccessibility() {
        #expect(ConversationContentSurfacePolicy.tintOpacity == 0.18)
        #expect(ConversationContentSurfacePolicy.backgroundOpacity(dark: false, reduceTransparency: false, increasedContrast: false, isMessage: true) == 0.75)
        #expect(ConversationContentSurfacePolicy.backgroundOpacity(dark: true, reduceTransparency: false, increasedContrast: false, isMessage: true) == 0.80)
        #expect(ConversationContentSurfacePolicy.backgroundOpacity(dark: false, reduceTransparency: false, increasedContrast: false) == 0.18)
        #expect(ConversationContentSurfacePolicy.backgroundOpacity(dark: true, reduceTransparency: false, increasedContrast: false) == 0.28)
        #expect(ConversationContentSurfacePolicy.backgroundOpacity(dark: false, reduceTransparency: true, increasedContrast: false) == 1)
        #expect(ConversationContentSurfacePolicy.backgroundOpacity(dark: true, reduceTransparency: false, increasedContrast: true) == 0.85)
        #expect(ConversationContentSurfacePolicy.borderWidth(increasedContrast: true) == 1)
        #expect(ConversationContentSurfacePolicy.borderWidth(increasedContrast: false) == 0.5)
    }

    @Test func messageMaterialIsSeparateAndAccessibilityCanDisableIt() {
        #expect(ConversationContentSurfacePolicy.messageMaterialOpacity == 0.80)
        #expect(ConversationContentSurfacePolicy.usesMessageMaterial(isMessage: true, reduceTransparency: false, increasedContrast: false))
        #expect(!ConversationContentSurfacePolicy.usesMessageMaterial(isMessage: false, reduceTransparency: false, increasedContrast: false))
        #expect(!ConversationContentSurfacePolicy.usesMessageMaterial(isMessage: true, reduceTransparency: true, increasedContrast: false))
        #expect(!ConversationContentSurfacePolicy.usesMessageMaterial(isMessage: true, reduceTransparency: false, increasedContrast: true))
        #expect(ConversationContentSurfacePolicy.backgroundOpacity(dark: false, reduceTransparency: false, increasedContrast: false, isMessage: true, withMaterial: true) == 0.55)
        #expect(ConversationContentSurfacePolicy.backgroundOpacity(dark: true, reduceTransparency: false, increasedContrast: false, isMessage: true, withMaterial: true) == 0.65)
    }
}
