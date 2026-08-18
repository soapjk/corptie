import Testing
@testable import CorptieMac

struct WorkItemStatusAdvanceDecisionTests {
    @Test func advancesNotStartedWorkItemToInProgress() {
        #expect(WorkItemStatusAdvanceDecision.resolve(status: "todo") == .advance(to: "in_progress"))
    }

    @Test func advancesInProgressAndReviewWorkItemsToDone() {
        #expect(WorkItemStatusAdvanceDecision.resolve(status: "in_progress") == .advance(to: "done"))
        #expect(WorkItemStatusAdvanceDecision.resolve(status: "review") == .advance(to: "done"))
    }

    @Test func completedAndFailedWorkItemsCannotAdvance() {
        #expect(WorkItemStatusAdvanceDecision.resolve(status: "done") == .unavailable)
        #expect(WorkItemStatusAdvanceDecision.resolve(status: "failed") == .unavailable)
    }
}
