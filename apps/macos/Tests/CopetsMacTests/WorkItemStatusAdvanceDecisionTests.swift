import Testing
@testable import CorptieMac

struct WorkItemStatusInteractionDecisionTests {
    @Test func inProgressStatusOpensCompletionConfirmation() {
        #expect(WorkItemAcceptancePresentationDecision.canOpenCompletionConfirmation(status: "in_progress"))
        #expect(WorkItemAcceptancePresentationDecision.canOpenCompletionConfirmation(status: "doing"))
        #expect(WorkItemAcceptancePresentationDecision.canOpenCompletionConfirmation(status: "running"))
    }

    @Test func everyOtherStatusIsReadOnly() {
        for status in ["todo", "pending", "ready", "review", "done", "complete", "completed", "failed"] {
            #expect(!WorkItemAcceptancePresentationDecision.canOpenCompletionConfirmation(status: status))
        }
    }
}
