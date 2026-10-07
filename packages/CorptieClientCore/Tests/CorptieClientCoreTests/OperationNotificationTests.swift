import Foundation
import Testing
@testable import CorptieClientCore

@Suite("Operation notifications") @MainActor
struct OperationNotificationTests {
    private func defaults() -> UserDefaults {
        UserDefaults(suiteName: "OperationNotifications.\(UUID().uuidString)")!
    }
    private func job(_ status: String, revision: Int, phase: String = "completed", automatic: Bool = false,
                     worktree: String = "tree:one") throws -> OperationJobSnapshot {
        let object: [String: Any] = ["id": "job:one", "repositoryId": "repo:one", "status": status,
            "phase": phase, "updatedAt": "2026-10-07T00:00:00.000Z", "currentWorktreeId": worktree,
            "audit": [], "revision": revision, "plan": ["operationType": "sync"],
            "conflictAutomation": ["status": automatic ? "running" : "failed"]]
        return try JSONDecoder().decode(OperationJobSnapshot.self, from: JSONSerialization.data(withJSONObject: object))
    }

    @Test func uncertainTransportDoesNotClaimFailure() {
        #expect(OperationNotificationOutcome.errorOutcome(URLError(.timedOut)) == .unconfirmed)
        #expect(OperationNotificationOutcome.errorOutcome(URLError(.cancelled)) == .cancelled)
        #expect(OperationNotificationOutcome.errorOutcome(CancellationError()) == .cancelled)
        #expect(OperationNotificationOutcome.errorOutcome(ClientServiceFailure(statusCode: 503, code: "BUSY")) == .unconfirmed)
    }

    @Test func deletionRecoveryUsesItsOwnAuthority() {
        let ledger = OperationNotificationLedger(defaults: defaults(), scope: "server")
        ledger.track(jobID: "deletion:one", kind: "task_delete")
        #expect(ledger.recoverableJobIDs.isEmpty)
        #expect(ledger.deletionJobIDs == ["deletion:one"])
    }

    @Test func settingsPersistAndEveryGateApplies() {
        let store = defaults()
        let preferences = OperationNotificationPreferences(defaults: store)
        let success = OperationNotificationEvent(category: .worktree, outcome: .succeeded, name: "Sync")
        #expect(preferences.allows(success))
        #expect(!preferences.sound && !preferences.cancellation)
        preferences.setCategory(.worktree, enabled: false)
        #expect(!preferences.allows(success))
        preferences.setCategory(.worktree, enabled: true)
        preferences.success = false
        #expect(!preferences.allows(success))
        #expect(OperationNotificationPreferences(defaults: store).success == false)
        let failure = OperationNotificationEvent(category: .worktree, outcome: .partial, name: "Sync")
        #expect(preferences.allows(failure))
        preferences.enabled = false
        #expect(!preferences.allows(failure))
    }

    @Test func onlyLocallyTrackedJobsNotifyAndRestartDeduplicates() throws {
        let store = defaults()
        let ledger = OperationNotificationLedger(defaults: store, scope: "server:one")
        let completed = try job("completed", revision: 5)
        #expect(ledger.observe(completed) == nil)
        ledger.track(jobID: completed.id, resourceName: "Project A")
        let event = try #require(ledger.observe(completed))
        #expect(event.summary == "Project A")
        #expect(ledger.consume(event))
        #expect(!ledger.consume(event))
        let restored = OperationNotificationLedger(defaults: store, scope: "server:one")
        #expect(restored.observe(completed) == nil)
        #expect(!restored.consume(event))
        #expect(restored.recoverableJobIDs.isEmpty)
        #expect(OperationNotificationLedger(defaults: store, scope: "server:two").consume(event))
    }

    @Test func progressAndAutomaticRecoveryAreSilentAndRetryCanNotifyAgain() throws {
        let ledger = OperationNotificationLedger(defaults: defaults(), scope: "server")
        ledger.track(jobID: "job:one")
        #expect(ledger.observe(try job("running", revision: 1, phase: "merging")) == nil)
        #expect(ledger.observe(try job("paused", revision: 2, phase: "conflict", automatic: true)) == nil)
        let first = try #require(ledger.observe(try job("paused", revision: 3, phase: "conflict")))
        #expect(first.outcome == .attention)
        #expect(ledger.observe(try job("paused", revision: 4, phase: "conflict")) == nil)
        #expect(ledger.observe(try job("queued", revision: 5, phase: "recovery")) == nil)
        let second = try #require(ledger.observe(try job("paused", revision: 6, phase: "conflict")))
        #expect(first.id != second.id)
        #expect(ledger.observe(try job("running", revision: 1, phase: "merging")) == nil)
        #expect(ledger.observe(try job("completed", revision: 7))?.outcome == .succeeded)
    }

    @Test func disabledEventsAreConsumedAndHistoryIsBounded() {
        let ledger = OperationNotificationLedger(defaults: defaults(), scope: "server")
        for index in 0..<600 {
            #expect(ledger.consume(.init(id: "event:\(index)", category: .mcp, outcome: .failed, name: "Install")))
        }
        #expect(ledger.results.count == 64)
        #expect(!ledger.consume(.init(id: "event:599", category: .mcp, outcome: .failed, name: "Install")))
        for index in 0..<160 { ledger.track(jobID: "job:\(index)") }
        #expect(ledger.recoverableJobIDs.count == 128)
    }

    @Test func distinctBlockersAndPartialResultsAreNotSuccess() throws {
        let ledger = OperationNotificationLedger(defaults: defaults(), scope: "server")
        ledger.track(jobID: "job:one")
        #expect(ledger.observe(try job("paused", revision: 1, phase: "conflict"))?.outcome == .attention)
        #expect(ledger.observe(try job("paused", revision: 2, phase: "conflict", worktree: "tree:two"))?.outcome == .attention)
        #expect(ledger.observe(try job("partial_completed", revision: 3))?.outcome == .partial)
    }
}
