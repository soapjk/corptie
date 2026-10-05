import Testing
@testable import CorptieConversation

@Suite("Message text card palette")
struct MessageTextCardPaletteTests {
    @Test("Commentary has a distinct opaque tint with readable existing agent text")
    func commentaryColor() {
        let final = MessageTextCardPalette.RGB(red: 0.952, green: 0.961, blue: 0.941)
        #expect(MessageTextCardPalette.commentaryRGB != final)
        #expect(MessageTextCardPalette.commentaryRGB != MessageTextCardPalette.lightUserBackground)
        #expect(MessageTextCardPalette.contrastRatio(
            foreground: .init(red: 0.18, green: 0.48, blue: 0.27),
            background: MessageTextCardPalette.commentaryRGB) >= 4.5)
    }

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
