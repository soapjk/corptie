import Testing
@testable import CorptieMac

struct ModelMenuLabelTests {
    @Test func longModelNamesAreLimitedToFifteenCharactersIncludingEllipsis() {
        let label = ModelMenuLabel.compact("OpenCode Zen/deepseek-v4-flash-free")

        #expect(label == "OpenCode Zen/d…")
        #expect(label.count == 15)
    }

    @Test func shortModelNamesRemainUnchanged() {
        #expect(ModelMenuLabel.compact("Claude Sonnet") == "Claude Sonnet")
    }
}
