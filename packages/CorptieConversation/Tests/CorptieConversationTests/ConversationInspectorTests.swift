import Testing
@testable import CorptieConversation

struct ConversationInspectorTests {
    @Test func textOverflowUsesTheSameToleranceOnBothPlatforms() {
        #expect(!CollapsibleDetailTextLayout.isOverflowing(fullHeight: 60.4, collapsedHeight: 60))
        #expect(CollapsibleDetailTextLayout.isOverflowing(fullHeight: 61, collapsedHeight: 60))
        #expect(!CollapsibleDetailTextLayout.isOverflowing(fullHeight: 40, collapsedHeight: 60))
    }
}
