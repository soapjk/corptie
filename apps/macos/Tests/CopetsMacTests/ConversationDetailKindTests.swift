import Testing
@testable import CorptieMac

struct ConversationDetailKindTests {
    @Test func classifiesExplicitSessionKindsWithoutProviderChecks() {
        #expect(ConversationDetailKind.resolve(.assistantChat) == .chatDetail)
        #expect(ConversationDetailKind.resolve(.workChat) == .workDetail)
        #expect(ConversationDetailKind.resolve(.worker) == .taskDetail)
        #expect(ConversationDetailKind.resolve(.legacy) == nil)
    }

    @Test func missingContentDoesNotBecomePlaceholderText() {
        #expect(ConversationDetailKind.nonempty(nil) == nil)
        #expect(ConversationDetailKind.nonempty("") == nil)
        #expect(ConversationDetailKind.nonempty(" \n\t") == nil)
        #expect(ConversationDetailKind.nonempty("  当前进展\n") == "当前进展")
    }
}
