import XCTest
@testable import CorptieConversation

final class ComposerMentionIndexTests: XCTestCase {
    func testIdentitySearchPreservesCatalogOrderingFilteringAndFullKeyboardRange() throws {
        let works: [ComposerMentionCatalog.Work] = [.init(id: "w", name: "Alpha")]
        let sessions: [ComposerMentionCatalog.Session] = [
            .init(id: "outside", title: "Loose", workId: nil),
            .init(id: "inside", title: "Chat", workId: "w"),
            .init(id: "self", title: "Current", workId: "w")]
        let index = try ComposerMentionCatalog.Index(works: works, sessions: sessions)
        for query in ["", " ALPHA ", "session", "outside", "nobody"] {
            let matches = try index.matches(query: query, currentSessionID: "self", activeMentionIDs: [])
            XCTAssertEqual(matches.compactMap(index.suggestion), ComposerMentionCatalog.suggestions(
                works: works, sessions: sessions, currentSessionID: "self", activeMentionIDs: [], query: query))
        }
        XCTAssertEqual(try index.matches(query: "", currentSessionID: "self", activeMentionIDs: ["work:w"]).map(\.id),
                       ["session:inside", "session:outside"])
        XCTAssertTrue(try index.matches(query: "", currentSessionID: "self",
            activeMentionIDs: Set((0..<8).map { "session:\($0)" })).isEmpty)
    }

    func testLargeDirectoryReturnsIdentitiesAndResolvesOnlyRequestedRows() throws {
        let sessions = (0..<10_000).map { ComposerMentionCatalog.Session(id: "s\($0)", title: "Chat \($0)", workId: nil) }
        let index = try ComposerMentionCatalog.Index(works: [], sessions: sessions)
        let matches = try index.matches(query: "", currentSessionID: "other", activeMentionIDs: [])
        XCTAssertEqual(matches.count, 10_000)
        XCTAssertEqual(index.suggestion(for: matches[9_999])?.displayName, "Chat 9999")
        XCTAssertEqual(try index.matches(query: "s9999", currentSessionID: "other", activeMentionIDs: []).map(\.id), ["session:s9999"])
    }

    func testLocalizedWorkLabelParticipatesInSearch() throws {
        let index = try ComposerMentionCatalog.Index(works: [.init(id: "w", name: "Alpha")], sessions: [], workLabel: "工作")
        XCTAssertEqual(try index.matches(query: "工作", currentSessionID: "s", activeMentionIDs: []).map(\.id), ["work:w"])
    }
    func testInstalledAbilitiesAreSearchableAndKeepExactMentionIdentities() throws {
        let abilities: [ComposerMentionCatalog.Ability] = [
            .init(id: "skill:one", name: "Research", kind: .skill),
            .init(id: "mcp:one", name: "Research tools", kind: .mcp)]
        let index = try ComposerMentionCatalog.Index(works: [], sessions: [], abilities: abilities)
        let matches = try index.matches(query: "Research", currentSessionID: "s", activeMentionIDs: [])
        XCTAssertEqual(matches.map(\.id), ["skill:skill:one", "mcp:mcp:one"])
        XCTAssertEqual(matches.compactMap(index.suggestion), ComposerMentionCatalog.suggestions(
            works: [], sessions: [], currentSessionID: "s", activeMentionIDs: [], query: "Research", abilities: abilities))
        XCTAssertEqual(matches.compactMap(index.suggestion).map(\.kind), [.skill, .mcp])
        XCTAssertEqual(try index.matches(query: "MCP", currentSessionID: "s", activeMentionIDs: []).map(\.id), ["mcp:mcp:one"])
        XCTAssertEqual(try index.matches(query: "", currentSessionID: "s", activeMentionIDs: ["skill:skill:one"]).map(\.id), ["mcp:mcp:one"])
    }

}
