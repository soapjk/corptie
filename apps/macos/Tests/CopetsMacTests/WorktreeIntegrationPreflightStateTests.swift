import Testing
@testable import CorptieMac

struct WorktreeIntegrationPreflightStateTests {
    @Test func distinguishesReadyMainTaskAndCombinedStates() {
        #expect(WorktreeIntegrationPreflightState(risks: []) == .ready)
        #expect(WorktreeIntegrationPreflightState(risks: [risk("MAIN_UNCOMMITTED_CHANGES", worktreeId: "wt:main")]) == .mainUncommittedChanges)
        #expect(WorktreeIntegrationPreflightState(risks: [risk("UNRESOLVED_CONFLICTS", worktreeId: "wt:task")]) == .taskConflict)
        #expect(WorktreeIntegrationPreflightState(risks: [
            risk("MAIN_UNCOMMITTED_CHANGES", worktreeId: "wt:main"),
            risk("UNRESOLVED_CONFLICTS", worktreeId: "wt:task")
        ]) == .taskConflictAndMainUncommittedChanges)
    }

    @Test func keepsUnrelatedRisksExplicitlyBlocked() {
        #expect(WorktreeIntegrationPreflightState(risks: [risk("WORKTREE_LOCKED", worktreeId: "wt:task")]) == .otherBlockingRisks)
        #expect(WorktreeIntegrationPreflightState(risks: [
            risk("MAIN_UNCOMMITTED_CHANGES", worktreeId: "wt:main"),
            risk("ACTIVE_SESSION_IN_PROGRESS", worktreeId: "wt:task")
        ]) == .otherBlockingRisks)
    }

    private func risk(_ code: String, worktreeId: String?) -> WorktreeIntegrationRisk {
        WorktreeIntegrationRisk(worktreeId: worktreeId, code: code, message: code)
    }
}
