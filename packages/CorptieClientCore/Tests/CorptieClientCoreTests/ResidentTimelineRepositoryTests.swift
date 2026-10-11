import Testing
import Foundation
@testable import CorptieClientCore

struct ResidentTimelineRepositoryTests {
    @Test func latestWindowReconciliationUsesOnlyAuthoritativeRowsAsTheReplacementBoundary() {
        let existing = ["history", "boundary", "base-old", "tail-old"].map {
            ClientMessage(id: $0, text: "old:\($0)")
        }
        let incoming = ["boundary", "base-new", "tail-new"].map {
            ClientMessage(id: $0, text: "new:\($0)")
        }
        let result = ClientTimelineWindowReconciler.reconcile(
            existing: existing,
            incoming: incoming,
            nextBefore: "new-cursor",
            existingBefore: "old-cursor",
            authoritativeItemIds: ["base-old", "base-new", "tail-new"],
            supplementalItemIds: ["boundary"]
        )

        #expect(result.messages.map(\.id) == ["history", "boundary", "base-new", "tail-new"])
        #expect(result.messages[1].text == "new:boundary")
        #expect(result.before == "old-cursor")
        #expect(result.retainedPrefix)
        #expect(Set(result.messages.map(\.id)).count == result.messages.count)
    }

    @Test func latestWindowReconciliationHandlesReplacementPartialOverlapAndReordering() {
        let existing = ["history", "a", "b", "c"].map { ClientMessage(id: $0, text: $0) }
        let reordered = ["boundary", "c", "b"].map { ClientMessage(id: $0, text: "new:\($0)") }
        let partial = ClientTimelineWindowReconciler.reconcile(
            existing: existing, incoming: reordered, nextBefore: "new", existingBefore: "old",
            authoritativeItemIds: ["c", "b"], supplementalItemIds: ["boundary"]
        )
        #expect(partial.messages.map(\.id) == ["history", "a", "boundary", "c", "b"])
        #expect(partial.before == "old")

        let replacement = ClientTimelineWindowReconciler.reconcile(
            existing: existing,
            incoming: [ClientMessage(id: "entirely-new", text: "new")],
            nextBefore: "replacement", existingBefore: "old",
            authoritativeItemIds: ["entirely-new"]
        )
        #expect(replacement.messages.map(\.id) == ["entirely-new"])
        #expect(replacement.before == "replacement")
        #expect(!replacement.retainedPrefix)
    }

    @Test func legacyLatestWindowFallbackDeduplicatesMalformedInputsWithoutTrapping() {
        let duplicate = ClientMessage(id: "duplicate", text: "latest")
        let result = ClientTimelineWindowReconciler.reconcile(
            existing: [ClientMessage(id: "history", text: "history"), duplicate, duplicate],
            incoming: [duplicate, duplicate],
            nextBefore: nil, existingBefore: "old",
            authoritativeItemIds: nil
        )
        #expect(result.messages.map(\.id) == ["history", "duplicate"])
        #expect(result.duplicateCount == 2)
    }

    @Test func coalescedChangesKeepContiguousRevisionsAndFinalDeletion() throws {
        var repository = ClientTimelineRepository()
        repository.store(state(revision: 1), for: "session:test")
        let delta = try JSONDecoder().decode(ClientTimelineDelta.self, from: Data(#"{"schemaVersion":2,"kind":"delta","sessionId":"session:test","snapshotRequired":false,"baseRevision":1,"revision":3,"currentRevision":3,"hasMore":false,"changes":[{"revision":2,"itemId":"one","operation":"noop"},{"revision":3,"itemId":"one","operation":"delete"}]}"#.utf8))
        guard case .applied(let updated) = repository.apply(delta) else {
            Issue.record("Coalescing must preserve revision coverage")
            return
        }
        #expect(updated.revision == 3)
        #expect(updated.messages.isEmpty)
    }

    @Test func orphanedCoalescingMarkerRequiresSnapshot() throws {
        var repository = ClientTimelineRepository()
        repository.store(state(revision: 1), for: "session:test")
        let delta = try JSONDecoder().decode(ClientTimelineDelta.self, from: Data(#"{"schemaVersion":2,"kind":"delta","sessionId":"session:test","snapshotRequired":false,"baseRevision":1,"revision":2,"currentRevision":2,"hasMore":false,"changes":[{"revision":2,"itemId":"one","operation":"noop"}]}"#.utf8))
        guard case .requiresSnapshot = repository.apply(delta) else {
            Issue.record("A missing final operation must never advance the cursor")
            return
        }
        #expect(repository.peek(sessionID: "session:test")?.revision == 1)
    }
    @Test func usageOnlyPushUpdatesResidentStateWithoutMovingMessages() throws {
        var repository = ClientTimelineRepository()
        repository.store(state(revision: 3), for: "session:test")
        let data = Data(#"{"schemaVersion":2,"kind":"delta","sessionId":"session:test","snapshotRequired":false,"baseRevision":3,"revision":3,"currentRevision":3,"hasMore":false,"changes":[],"usage":{"schemaVersion":1,"sessionId":"session:test","context":{"usedTokens":30,"contextWindow":100,"remainingTokens":70},"account":null}}"#.utf8)
        let delta = try JSONDecoder().decode(ClientTimelineDelta.self, from: data)
        guard case .applied(let updated) = repository.apply(delta) else {
            Issue.record("Usage-only push must update a resident timeline")
            return
        }
        #expect(updated.usage?.context?.usedTokens == 30)
        #expect(updated.messages.isEmpty)
        #expect(updated.revision == 3)
    }
    @Test func pinnedSelectionSurvivesBoundedResidentEviction() {
        var cache = ResidentSessionCache<Int>(capacity: 2)
        cache.store(1, for: "selected")
        cache.store(2, for: "older")
        cache.pin(["selected"])
        cache.store(3, for: "newer")

        #expect(cache.peek("selected") == 1)
        #expect(cache.peek("older") == nil)
        #expect(cache.peek("newer") == 3)
    }

    @Test func activeSetPrunesRemovedSessionsWithoutPinningEverySession() {
        var repository = ClientTimelineRepository(capacity: 2)
        repository.store(state(revision: 1), for: "selected")
        repository.store(state(revision: 1), for: "older")
        repository.retainActiveSessions(
            ["selected", "older", "newer"],
            pinnedSessionIDs: ["selected"]
        )
        repository.store(state(revision: 1), for: "newer")

        #expect(repository.peek(sessionID: "selected") != nil)
        #expect(repository.peek(sessionID: "older") == nil)
        #expect(repository.peek(sessionID: "newer") != nil)

        repository.remove("selected")
        #expect(repository.peek(sessionID: "selected") == nil)

        repository.retainActiveSessions(["newer"])
        #expect(repository.peek(sessionID: "newer") != nil)
    }

    private func state(revision: Int) -> ClientResidentTimeline {
        ClientResidentTimeline(
            messages: [],
            before: nil,
            revision: revision,
            capabilities: nil,
            usage: nil,
            composer: nil
        )
    }
}
