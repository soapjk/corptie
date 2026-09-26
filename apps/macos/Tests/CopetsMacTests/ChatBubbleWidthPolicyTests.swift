import XCTest
import CorptieConversation
@testable import CorptieMac

@MainActor
final class ChatBubbleWidthPolicyTests: XCTestCase {
    func testShortUserMessageHugsBodyInsteadOfMaximumWidth() {
        let width = preferredWidth(text: "Hi")

        XCTAssertGreaterThanOrEqual(width, ChatBubbleWidthPolicy.minimumWidth)
        XCTAssertLessThanOrEqual(width, 48)
        XCTAssertLessThan(width, 220)
        XCTAssertLessThan(width, ChatBubbleWidthPolicy.maximumWidth)
    }

    func testWidthGrowsWithContentAndLongTextClampsAtMaximum() {
        let short = preferredWidth(text: "Hi")
        let medium = preferredWidth(text: "Please review the latest implementation and test results.")
        let long = preferredWidth(text: String(repeating: "long message content ", count: 80))

        XCTAssertGreaterThan(medium, short)
        XCTAssertEqual(long, ChatBubbleWidthPolicy.maximumWidth)
    }

    func testRichMarkdownUsesFullSafeLane() {
        let width = preferredWidth(text: """
        ```swift
        print("Hi")
        ```
        """)

        XCTAssertEqual(width, ChatBubbleWidthPolicy.maximumWidth)
    }

    func testCollapsedAndExpandedProcessWidthsAreExplicit() {
        let collapsed = preferredWidth(
            text: "Hi",
            processWidth: ChatBubbleWidthPolicy.collapsedProcessWidth
        )
        let expanded = preferredWidth(
            text: "Hi",
            processWidth: ChatBubbleWidthPolicy.maximumWidth - ChatBubbleWidthPolicy.horizontalPadding
        )

        XCTAssertEqual(
            collapsed,
            ChatBubbleWidthPolicy.collapsedProcessWidth + ChatBubbleWidthPolicy.horizontalPadding
        )
        XCTAssertEqual(expanded, ChatBubbleWidthPolicy.maximumWidth)
    }

    func testNarrowViewportClampsPreferredWidth() {
        let width = preferredWidth(
            text: String(repeating: "wide content ", count: 40),
            availableWidth: 312
        )

        XCTAssertEqual(width, 312)
    }

    func testExpandedProcessCardUsesMessageWidthCeiling() {
        XCTAssertEqual(MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 80, expanded: true, laneWidth: 900),
            ChatBubbleWidthPolicy.maximumWidth)
        XCTAssertEqual(MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 80, expanded: true, laneWidth: 320), 316)

        let process = AppKitChatTimelineRow(
            id: "expanded-process", contentRevision: 1, nativeText: "Step details",
            copyText: "Step details", nativeStyle: .process, title: "", metadata: "",
            expandableTurnId: "turn", isExpanded: true, processCount: 1
        )
        XCTAssertEqual(NativeTimelineLayoutCache.shared.layout(
            for: process, columnWidth: 900).cardWidth, ChatBubbleWidthPolicy.maximumWidth)
    }

    /// The AppKit wrapper only measures; the clamp the iPad applies is the shared one.
    func testSharedPolicyMatchesDesktopClampAndAttachmentFloor() {
        XCTAssertEqual(ChatBubbleWidthPolicy.maximumWidth, MessageBubbleWidthPolicy.maximumWidth)
        XCTAssertEqual(ChatBubbleWidthPolicy.minimumWidth, MessageBubbleWidthPolicy.minimumWidth)
        XCTAssertEqual(ChatBubbleWidthPolicy.horizontalPadding, MessageBubbleWidthPolicy.horizontalPadding)
        XCTAssertEqual(MessageBubbleWidthPolicy.preferredWidth(bodyWidth: 12), MessageBubbleWidthPolicy.minimumWidth)
        XCTAssertEqual(MessageBubbleWidthPolicy.preferredWidth(bodyWidth: 100), 120)
        XCTAssertEqual(MessageBubbleWidthPolicy.preferredWidth(bodyWidth: 900), MessageBubbleWidthPolicy.maximumWidth)
        XCTAssertEqual(MessageBubbleWidthPolicy.preferredWidth(bodyWidth: 900, availableWidth: 312), 312)
        XCTAssertEqual(MessageBubbleWidthPolicy.cardWidth(bodyWidth: 20, hasAttachments: false, laneWidth: 600), 40)
        XCTAssertEqual(MessageBubbleWidthPolicy.cardWidth(bodyWidth: 20, hasAttachments: true, laneWidth: 600), 220)
        XCTAssertEqual(MessageBubbleWidthPolicy.cardWidth(bodyWidth: 20, hasAttachments: true, laneWidth: 200), 196)
        XCTAssertTrue(MessageBubbleWidthPolicy.requiresFullWidthLayout("| A | B |\n|---|---|"))
        XCTAssertFalse(MessageBubbleWidthPolicy.requiresFullWidthLayout("plain **bold** text"))
    }

    private func preferredWidth(
        text: String,
        processWidth: CGFloat = 0,
        availableWidth: CGFloat = ChatBubbleWidthPolicy.maximumWidth
    ) -> CGFloat {
        ChatBubbleWidthPolicy.preferredWidth(
            text: text,
            style: .user,
            title: "",
            metadata: "",
            processWidth: processWidth,
            availableWidth: availableWidth
        )
    }
}
