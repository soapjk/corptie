import Foundation
import Testing
import CorptieClientCore
@testable import CorptieConversation

@MainActor struct ConversationDetailCardDragTests {
    @Test(arguments: [false, true])
    func nativeDropMovesBeforeOrAfterAndRestoresExistingPreference(after: Bool) throws {
        let suite = "detail-drag-test-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let cards = try fixture().orderedCards
        let arrangement = ConversationDetailCardArrangement(defaults: defaults)
        let payload = ConversationDetailCardDrag(scope: ["session"], cardID: after ? "summary" : "references")
        let decoded = try JSONDecoder().decode(ConversationDetailCardDrag.self, from: JSONEncoder().encode(payload))
        #expect(arrangement.move(decoded, in: ["session"], relativeTo: after ? "references" : "summary", after: after, cards: cards))
        #expect(arrangement.ordered(cards).map(\.id) == ["references", "summary"])
        #expect(ConversationDetailCardArrangement(defaults: defaults).ordered(cards).map(\.id) == ["references", "summary"])
    }

    @Test func crossSessionRemovedAndSelfDropsCannotChangeSavedOrder() throws {
        let suite = "detail-drag-reject-test-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let cards = try fixture().orderedCards
        let arrangement = ConversationDetailCardArrangement(defaults: defaults)
        for (scope, source, target) in [(["other"], "references", "summary"),
                                        (["session"], "removed", "summary"),
                                        (["session"], "references", "removed"),
                                        (["session"], "summary", "summary")] {
            #expect(!arrangement.move(.init(scope: scope, cardID: source), in: ["session"], relativeTo: target, after: false, cards: cards))
        }
        #expect(defaults.object(forKey: "corptie.detail.cardKindOrder.v1") == nil)
        #expect(arrangement.ordered(cards).map(\.id) == ["summary", "references"])
    }

    private func fixture() throws -> ClientDetailBusinessStore {
        let store = ClientDetailBusinessStore()
        let cards: [[String: Any]] = [
            ["id": "summary", "kind": "chatSummary", "version": 1, "revision": "1", "loadState": "ready", "data": ["text": "Summary"], "actions": []],
            ["id": "references", "kind": "contextReferences", "version": 1, "revision": "1", "loadState": "ready", "data": ["items": [], "hasMore": false], "actions": []]
        ]
        try store.receive(ClientDetailBusinessDocument.decode(JSONSerialization.data(withJSONObject: [
            "protocolVersion": 1, "catalog": "native-business-v1", "documentId": "detail", "sessionId": "session",
            "generation": "generation", "revision": "1", "cards": cards, "order": ["summary", "references"]
        ])))
        return store
    }
}
