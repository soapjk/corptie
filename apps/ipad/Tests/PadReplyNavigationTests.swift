import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@MainActor
struct PadReplyNavigationTests {
    private func page(_ ids: [String], cursor: String? = nil) throws -> ClientMessagePage {
        var value: [String: Any] = ["schemaVersion": 2, "sessionId": "s", "revision": 10,
            "items": ids.map { ["id": $0, "type": "userMessage", "text": $0] }, "hasEarlier": cursor != nil]
        if let cursor { value["nextBefore"] = cursor }
        return try JSONDecoder().decode(ClientMessagePage.self, from: JSONSerialization.data(withJSONObject: value))
    }

    @Test func aroundWindowDoesNotMergeAcrossGapOrOverwriteLiveRevision() throws {
        let defaults = UserDefaults(suiteName: "navigation-\(UUID().uuidString)")!
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "s"
        workspace.messages = try page(["live:1", "live:2"]).items
        workspace.before = "live:cursor"
        workspace.lastTimelineRevision = 50
        #expect(workspace.showNavigationWindow(try page(["old:1", "q", "old:2"], cursor: "old:cursor"), target: "q") == "message:q")
        #expect(workspace.visibleMessages.map(\.id) == ["old:1", "q", "old:2"])
        #expect(workspace.messages.map(\.id) == ["live:1", "live:2"])
        #expect(workspace.lastTimelineRevision == 50)
        #expect(workspace.historyRequestCursor == "old:cursor")
        // Live stream/snapshot changes remain resident without moving history.
        workspace.applyLatestWindow(try page(["live:1", "live:2", "stream:fixed"]).items,
            cursor: "live:new-cursor", revision: 51)
        #expect(workspace.visibleMessages.map(\.id) == ["old:1", "q", "old:2"])
        workspace.returnToLatestMessages()
        #expect(workspace.visibleMessages.map(\.id) == ["live:1", "live:2", "stream:fixed"])
        #expect(workspace.historyRequestCursor == "live:new-cursor")
        #expect(workspace.lastTimelineRevision == 51)
    }

    @Test func invalidWindowDoesNotReplaceHistoryAndSessionSwitchClearsIt() throws {
        let workspace = PadWorkspace(defaults: UserDefaults(suiteName: "navigation-\(UUID().uuidString)")!)
        workspace.selection = "s"
        #expect(workspace.showNavigationWindow(try page(["q"]), target: "q") != nil)
        #expect(workspace.showNavigationWindow(try page(["other"]), target: "q") == nil)
        #expect(workspace.visibleMessages.map(\.id) == ["q"])
        workspace.clearSelectionState()
        #expect(workspace.displayEntries.isEmpty)
        #expect(workspace.showNavigationWindow(try page(["q"]), target: "q") != nil)
        workspace.selection = "s2"
        #expect(!workspace.isNavigatingHistory)
        #expect(workspace.navigationMessages == nil)
    }
}
