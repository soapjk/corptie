import Testing
@testable import CorptieConversation

@Suite("Message bubble width policy")
struct MessageBubbleWidthPolicyTests {
    @Test("Collapsed process cards fit their summary without filling the lane")
    func collapsedProcessCard() {
        #expect(MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 160,
            expanded: false,
            laneWidth: 700
        ) == 218)
    }

    @Test("Expanded process cards use the bounded timeline lane")
    func expandedProcessCard() {
        #expect(MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 80,
            expanded: true,
            laneWidth: 700
        ) == 696)
    }

    @Test("Process cards clamp to narrow lanes")
    func narrowProcessCard() {
        #expect(MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 300,
            expanded: false,
            laneWidth: 150
        ) == 146)
    }
}
