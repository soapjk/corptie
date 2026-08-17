import XCTest
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
