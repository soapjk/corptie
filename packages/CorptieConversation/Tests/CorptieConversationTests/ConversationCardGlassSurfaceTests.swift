import Testing
@testable import CorptieConversation

@Suite("Card glass accessibility policy")
struct ConversationCardGlassSurfaceTests {
    @Test func panelMaterialStaysLighterThanMessagesAndRespectsAccessibility() {
        #expect(ConversationContentSurfacePolicy.panelMaterialOpacity == 0.60)
        #expect(ConversationContentSurfacePolicy.panelMaterialOpacity < ConversationContentSurfacePolicy.messageMaterialOpacity)
        #expect(ConversationContentSurfacePolicy.usesPanelMaterial(isPanel: true, reduceTransparency: false, increasedContrast: false))
        #expect(!ConversationContentSurfacePolicy.usesPanelMaterial(isPanel: false, reduceTransparency: false, increasedContrast: false))
        #expect(!ConversationContentSurfacePolicy.usesPanelMaterial(isPanel: true, reduceTransparency: true, increasedContrast: false))
        #expect(!ConversationContentSurfacePolicy.usesPanelMaterial(isPanel: true, reduceTransparency: false, increasedContrast: true))
        for dark in [false, true] {
            let panel = ConversationContentSurfacePolicy.backgroundOpacity(dark: dark, reduceTransparency: false, increasedContrast: false, isPanel: true)
            let plain = ConversationContentSurfacePolicy.backgroundOpacity(dark: dark, reduceTransparency: false, increasedContrast: false)
            let message = ConversationContentSurfacePolicy.backgroundOpacity(dark: dark, reduceTransparency: false, increasedContrast: false, isMessage: true, withMaterial: true)
            #expect(panel > plain)
            #expect(panel < message)
            #expect(ConversationContentSurfacePolicy.backgroundOpacity(dark: dark, reduceTransparency: true, increasedContrast: false, isPanel: true) == 1)
            #expect(ConversationContentSurfacePolicy.backgroundOpacity(dark: dark, reduceTransparency: false, increasedContrast: true, isPanel: true) == 0.85)
        }
    }

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
