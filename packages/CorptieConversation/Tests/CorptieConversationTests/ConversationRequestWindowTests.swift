import Testing
@testable import CorptieConversation

struct ConversationRequestWindowTests {
    @Test func opensTenAndExpandsOnlyOnExplicitAction() {
        var window = ConversationRequestWindow()
        #expect(window.limit == 10)
        window.showMore()
        #expect(window.limit == 20)
        // The window does not consume or reorder the server list.
        let ids = Array(0..<100)
        #expect(Array(ids.prefix(window.limit)) == Array(0..<20))
        window.collapse()
        #expect(window.limit == 10)
    }
    @Test func expansionRemainsBoundedAndNewViewStartsCollapsed() {
        var window = ConversationRequestWindow()
        for _ in 0..<30 { window.showMore() }
        #expect(window.limit == 100)
        #expect(ConversationRequestWindow().limit == 10)
        #expect(Array((0..<7).prefix(window.limit)).count == 7)
        window.collapse()
        #expect(window.limit == 10)
    }
}
