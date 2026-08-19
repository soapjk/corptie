import Testing
@testable import CorptieMac

struct WorkItemStatusAdvanceDecisionTests {
    @Test func advancesNotStartedWorkItemToInProgress() {
        #expect(WorkItemStatusAdvanceDecision.resolve(status: "todo") == .advance(to: "in_progress"))
    }

    @Test func advancesInProgressWorkItemToDone() {
        #expect(WorkItemStatusAdvanceDecision.resolve(status: "in_progress") == .advance(to: "done"))
    }

    @Test func completedWorkItemsCanBeRestoredWhileFailedItemsRemainUnavailable() {
        #expect(WorkItemStatusAdvanceDecision.resolve(status: "done") == .restore)
        #expect(WorkItemStatusAdvanceDecision.resolve(status: "completed") == .restore)
        #expect(WorkItemStatusAdvanceDecision.resolve(status: "failed") == .unavailable)
    }
}
