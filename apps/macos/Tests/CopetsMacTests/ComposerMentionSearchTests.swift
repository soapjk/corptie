import XCTest
@testable import CorptieMac

@MainActor
final class ComposerMentionSearchTests: XCTestCase {
    private func session(_ id: String, title: String, archived: Bool = false) throws -> TaskSession {
        let fields: [String: Any] = ["id": id, "title": title, "agent": "OtherProvider", "status": "complete",
            "progress": 1, "summary": "", "updatedAt": "2026-11-05T00:00:00Z", "accent": "cyan", "archived": archived]
        return try JSONDecoder().decode(TaskSession.self, from: JSONSerialization.data(withJSONObject: fields))
    }

    private func request(_ query: String?, revision: UInt64 = 1, active: Bool = true,
                         mentions: [ConversationMention] = []) -> ComposerMentionSearch.Request {
        .init(query: query, catalogRevision: revision, draftRevision: 1, selectedMentions: mentions, active: active)
    }

    func testInstalledAbilitiesInvalidateDirectoryAndPreserveWireTypes() async throws {
        let search = ComposerMentionSearch()
        var value = request("")
        await search.search(value, sessionID: "current", sessions: [], works: [], draft: "@")
        value.abilityRevision = 1
        await search.search(value, sessionID: "current", sessions: [], works: [], draft: "@", abilities: [
            .init(id: "skill:one", name: "Research", kind: .skill),
            .init(id: "mcp:one", name: "Tools", kind: .mcp)])
        XCTAssertEqual(search.candidate(at: 0)?.mention.targetType, .skill)
        XCTAssertEqual(search.candidate(at: 1)?.mention.targetType, .mcp)
        XCTAssertEqual(search.directoryBuildCount, 2)
    }

    func testSameInputDoesNotSearchAgainAndQueryChangesReuseDirectory() async throws {
        let search = ComposerMentionSearch()
        let sessions = try [session("a", title: "Alpha"), session("b", title: "Beta"), session("archived", title: "Alpha", archived: true)]
        await search.search(request("Alpha"), sessionID: "current", sessions: sessions, works: [], draft: "@Alpha")
        XCTAssertEqual(search.matches.map(\.id), ["session:a"])
        await search.search(request("Alpha"), sessionID: "current", sessions: sessions, works: [], draft: "@Alpha")
        XCTAssertEqual(search.searchCount, 1)
        await search.search(request("Beta"), sessionID: "current", sessions: sessions, works: [], draft: "@Beta")
        XCTAssertEqual(search.matches.map(\.id), ["session:b"])
        XCTAssertEqual(search.directoryBuildCount, 1)
        XCTAssertEqual(search.candidate(at: 0)?.mention.targetId, "b")
    }

    func testSameLengthRenameAndArchiveWithNewRevisionInvalidateDirectory() async throws {
        let search = ComposerMentionSearch()
        await search.search(request("Alpha"), sessionID: "current", sessions: [try session("a", title: "Alpha")], works: [], draft: "@Alpha")
        await search.search(request("Bravo", revision: 2), sessionID: "current", sessions: [try session("a", title: "Bravo")], works: [], draft: "@Bravo")
        XCTAssertEqual(search.candidate(at: 0)?.mention.displayName, "Bravo")
        await search.search(request("Bravo", revision: 3), sessionID: "current", sessions: [try session("a", title: "Bravo", archived: true)], works: [], draft: "@Bravo")
        XCTAssertTrue(search.matches.isEmpty)
        XCTAssertEqual(search.directoryBuildCount, 3)
    }

    func testExcludedMentionDoesNotLeakIntoResultsAndKeyboardWrapsWholeResult() async throws {
        let search = ComposerMentionSearch()
        let mention = ConversationMention(targetType: .session, targetId: "a", displayName: "Alpha")
        let sessions = try [session("a", title: "Alpha"), session("b", title: "Beta"), session("c", title: "Gamma")]
        await search.search(request("", mentions: [mention]), sessionID: "current", sessions: sessions, works: [], draft: "@Alpha @")
        XCTAssertEqual(search.matches.map(\.id), ["session:b", "session:c"])
        search.move(-1)
        XCTAssertEqual(search.candidate(at: search.selectedIndex)?.mention.targetId, "c")
        search.move(1)
        XCTAssertEqual(search.selectedIndex, 0)
    }

    func testInvalidationRejectsInFlightSearchAndReleasesDirectory() async throws {
        let search = ComposerMentionSearch()
        let sessions = try (0..<10_000).map { try session("s\($0)", title: "Chat \($0)") }
        let task = Task { await search.search(request("Chat"), sessionID: "current", sessions: sessions, works: [], draft: "@Chat") }
        while !search.isLoading { await Task.yield() }
        search.invalidate()
        await task.value
        XCTAssertTrue(search.matches.isEmpty)
        XCTAssertNil(search.directory)
        XCTAssertFalse(search.isLoading)
    }

    func testNewQueryCannotBeOverwrittenByAnEarlierSearch() async throws {
        let search = ComposerMentionSearch()
        let sessions = try (0..<5_000).map { try session("s\($0)", title: "Chat \($0)") }
        let old = Task { await search.search(request("Chat"), sessionID: "current", sessions: sessions, works: [], draft: "@Chat") }
        while !search.isLoading { await Task.yield() }
        await search.search(request("s4999"), sessionID: "current", sessions: sessions, works: [], draft: "@s4999")
        await old.value
        XCTAssertEqual(search.matches.map(\.id), ["session:s4999"])
        await search.search(request(nil, active: false), sessionID: "current", sessions: sessions, works: [], draft: "")
        XCTAssertNil(search.directory)
        XCTAssertTrue(search.matches.isEmpty)
    }
}
