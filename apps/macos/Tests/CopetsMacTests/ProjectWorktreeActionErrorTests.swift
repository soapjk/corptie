import Foundation
import Testing
@testable import CorptieMac

@MainActor
struct ProjectWorktreeActionErrorTests {
    @Test
    func integrationEntryExplainsEveryNonRunnableState() {
        #expect(ProjectWorktreeIntegrationEntryState(
            eligibleCount: 1, conflictCount: 0, isRunning: false
        ) == .ready)
        #expect(ProjectWorktreeIntegrationEntryState(
            eligibleCount: 0, conflictCount: 0, isRunning: false
        ) == .noEligibleWorktrees)
        #expect(ProjectWorktreeIntegrationEntryState(
            eligibleCount: 2, conflictCount: 1, isRunning: false
        ) == .unresolvedConflicts)
        #expect(ProjectWorktreeIntegrationEntryState(
            eligibleCount: 2, conflictCount: 0, isRunning: true
        ) == .running)
    }

    @Test
    func integrationLaunchGateRejectsRepeatedStartsUntilCompletion() {
        var gate = ProjectWorktreeIntegrationLaunchGate()

        let firstStart = gate.begin()
        #expect(firstStart)
        #expect(gate.isRunning)
        let duplicateStart = gate.begin()
        #expect(!duplicateStart)

        gate.finish()

        #expect(!gate.isRunning)
        let nextStart = gate.begin()
        #expect(nextStart)
    }

    @Test
    func oneClickEntryRoutesClicksAndOnlyDisablesWhileRunning() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/FloatingRootView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("handleIntegrationEntry(integrationEntryState)"))
        #expect(contents.contains("case .ready:\n            backendClient.dismissProjectWorktreeActionError()\n            showingIntegrationConfirmation = true"))
        #expect(contents.contains(".disabled(integrationEntryState == .running)"))
        #expect(contents.contains("No completed Worktrees are eligible for integration."))
        #expect(contents.contains("Worktree integration failures"))
        #expect(!contents.contains("integrationStatus.eligibleWorktrees.isEmpty\n                                ||"))
    }

    @Test
    func actionErrorSurvivesSessionStreamReconnection() {
        let client = BackendClient()

        client.recordProjectWorktreeActionError("Merge conflict in server.mjs")
        client.markBackendConnectedFromSessionStream()

        #expect(client.lastError == nil)
        #expect(client.projectWorktreeActionError == "Merge conflict in server.mjs")
    }

    @Test
    func actionErrorCanBeDismissedExplicitly() {
        let client = BackendClient()
        client.recordProjectWorktreeActionError("Merge failed")

        client.dismissProjectWorktreeActionError()

        #expect(client.projectWorktreeActionError == nil)
    }
}
