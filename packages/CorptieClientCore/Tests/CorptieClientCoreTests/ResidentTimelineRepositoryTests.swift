import Testing
@testable import CorptieClientCore

struct ResidentTimelineRepositoryTests {
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
