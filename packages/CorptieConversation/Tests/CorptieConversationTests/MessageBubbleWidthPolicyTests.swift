import Testing
@testable import CorptieConversation

@Suite("Message bubble width policy")
struct MessageBubbleWidthPolicyTests {
    @Test("Intrinsic process width follows current content, not a future clock reserve")
    func intrinsicProcessWidth() {
        #expect(MessageBubbleWidthPolicy.processCardLayoutWidth(naturalWidth: 120, expanded: false, laneWidth: 700) == 120)
        #expect(MessageBubbleWidthPolicy.processCardLayoutWidth(naturalWidth: 140, expanded: false, laneWidth: 700) == 140)
        #expect(MessageBubbleWidthPolicy.processCardLayoutWidth(naturalWidth: 900, expanded: false, laneWidth: 320) == 316)
        #expect(MessageBubbleWidthPolicy.processCardLayoutWidth(naturalWidth: 120, expanded: true, laneWidth: 700) == 480)
        #expect(MessageBubbleWidthPolicy.processCardLayoutWidth(naturalWidth: 120, expanded: true, laneWidth: 320) == 316)
    }
    @Test("Collapsed process cards fit their summary without filling the lane")
    func collapsedProcessCard() {
        #expect(MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 160,
            expanded: false,
            laneWidth: 700
        ) == 218)
    }

    @Test("Short collapsed process cards hug their visible header")
    func shortCollapsedProcessCard() {
        #expect(MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 42,
            expanded: false,
            laneWidth: 700
        ) == 100)
    }

    @Test("Collapsed process cards include progress and secondary rows")
    func collapsedProcessCardVisibleRows() {
        #expect(MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 80,
            secondaryWidth: 190,
            progressLabelWidth: 48,
            expanded: false,
            laneWidth: 700
        ) == 230)
    }

    @Test("Expanded process cards stay bounded within the timeline lane")
    func expandedProcessCard() {
        #expect(MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 80,
            expanded: true,
            laneWidth: 700
        ) == MessageBubbleWidthPolicy.maximumWidth)
    }

    @Test("Process cards clamp to narrow lanes")
    func narrowProcessCard() {
        #expect(MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 300,
            expanded: false,
            laneWidth: 150
        ) == 146)
    }

    @Test("Message card width hugs short text and clamps long text")
    func messageCardWidthHugsAndClamps() {
        // Short text (bodyWidth: 30) hugs natural content: 30 + 20 = 50
        let shortWidth = MessageBubbleWidthPolicy.cardWidth(bodyWidth: 30, hasAttachments: false, laneWidth: 800)
        #expect(shortWidth == 50)
        #expect(shortWidth < MessageBubbleWidthPolicy.maximumWidth)

        // Long text (bodyWidth: 1000) clamps to maximumWidth = 480
        let longWidth = MessageBubbleWidthPolicy.cardWidth(bodyWidth: 1000, hasAttachments: false, laneWidth: 800)
        #expect(longWidth == MessageBubbleWidthPolicy.maximumWidth)

        // Narrow lane clamps available width: laneWidth 320 -> 316
        let narrowWidth = MessageBubbleWidthPolicy.cardWidth(bodyWidth: 1000, hasAttachments: false, laneWidth: 320)
        #expect(narrowWidth == 316)

        // Attachments enforce attachment floor of 220
        let attachmentWidth = MessageBubbleWidthPolicy.cardWidth(bodyWidth: 30, hasAttachments: true, laneWidth: 800)
        #expect(attachmentWidth == MessageBubbleWidthPolicy.attachmentMinimumWidth)
    }
}
