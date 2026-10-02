import Testing
@testable import CorptieConversation

@Suite("Message text card palette")
struct MessageTextCardPaletteTests {
    @Test("User message colors meet AA contrast in every appearance")
    func userMessageContrast() {
        let lightContrast = MessageTextCardPalette.contrastRatio(
            foreground: MessageTextCardPalette.lightUserForeground,
            background: MessageTextCardPalette.lightUserBackground
        )
        let darkContrast = MessageTextCardPalette.contrastRatio(
            foreground: MessageTextCardPalette.darkUserForeground,
            background: MessageTextCardPalette.darkUserBackground
        )

        #expect(lightContrast >= 4.5)
        #expect(darkContrast >= 4.5)
    }
}
