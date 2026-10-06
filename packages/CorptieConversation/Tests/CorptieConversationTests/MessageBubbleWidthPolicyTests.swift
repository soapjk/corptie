import Foundation
import Testing
@testable import CorptieConversation

@Suite("Message bubble width policy")
struct MessageBubbleWidthPolicyTests {
    @Test("Following collapse handle stays inside a process card visible only at the top")
    func processCollapseFollowsVisibleCardEnd() {
        let placement = ProcessCollapsePlacementPolicy.placement(
            candidates: [ProcessCollapseCandidate(id: "process", frame: CGRect(x: 16, y: -400,
                width: 480, height: 600), headerHeight: 32)],
            viewport: CGRect(x: 0, y: 0, width: 600, height: 500),
            handleSize: CGSize(width: 80, height: 44))
        #expect(placement?.id == "process")
        #expect(placement?.origin.y == 146)
        #expect(placement?.origin.x == 406)
    }

    @Test("Following collapse handle does not duplicate a visible header or appear on a sliver")
    func processCollapseVisibilityRules() {
        let viewport = CGRect(x: 0, y: 0, width: 600, height: 500)
        let size = CGSize(width: 80, height: 44)
        #expect(ProcessCollapsePlacementPolicy.placement(candidates: [
            ProcessCollapseCandidate(id: "header", frame: CGRect(x: 16, y: 10, width: 480,
                height: 800), headerHeight: 32)
        ], viewport: viewport, handleSize: size) == nil)
        #expect(ProcessCollapsePlacementPolicy.placement(candidates: [
            ProcessCollapseCandidate(id: "sliver", frame: CGRect(x: 16, y: -500, width: 480,
                height: 540), headerHeight: 32)
        ], viewport: viewport, handleSize: size) == nil)
    }

    @Test("Only the process containing the viewport center gets a following handle")
    func processCollapseChoosesCenterCard() {
        let placement = ProcessCollapsePlacementPolicy.placement(candidates: [
            ProcessCollapseCandidate(id: "upper", frame: CGRect(x: 16, y: -600,
                width: 480, height: 760), headerHeight: 32),
            ProcessCollapseCandidate(id: "center", frame: CGRect(x: 16, y: -120,
                width: 480, height: 600), headerHeight: 32)
        ], viewport: CGRect(x: 0, y: 0, width: 600, height: 500),
           handleSize: CGSize(width: 80, height: 44))
        #expect(placement?.id == "center")
    }

    @Test("Process summary text has no line cap on either platform")
    func processSummaryDoesNotTruncate() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CorptieConversation/ProcessCard.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)
        let start = try #require(contents.range(of: "ProcessCardSummaryLabel(summary:"))
        let end = try #require(contents.range(of: "if let progressLabel", range: start.upperBound..<contents.endIndex))
        let summary = contents[start.lowerBound..<end.lowerBound]
        #expect(summary.contains(".lineLimit(nil)"))
        #expect(summary.contains(".fixedSize(horizontal: false, vertical: true)"))
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
