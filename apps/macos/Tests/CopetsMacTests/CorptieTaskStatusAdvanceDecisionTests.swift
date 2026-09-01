import Testing
@testable import CorptieMac

struct CorptieTaskStatusInteractionDecisionTests {
    @Test func inProgressStatusOpensCompletionConfirmation() {
        #expect(CorptieTaskAcceptancePresentationDecision.canOpenCompletionConfirmation(status: "in_progress"))
        #expect(CorptieTaskAcceptancePresentationDecision.canOpenCompletionConfirmation(status: "doing"))
        #expect(CorptieTaskAcceptancePresentationDecision.canOpenCompletionConfirmation(status: "running"))
    }

    @Test func everyOtherStatusIsReadOnly() {
        for status in ["todo", "pending", "ready", "review", "done", "complete", "completed", "failed"] {
            #expect(!CorptieTaskAcceptancePresentationDecision.canOpenCompletionConfirmation(status: status))
        }
    }
}
