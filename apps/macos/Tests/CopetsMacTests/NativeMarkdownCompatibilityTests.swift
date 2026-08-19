import XCTest
@testable import CorptieMac

final class NativeMarkdownCompatibilityTests: XCTestCase {
    func testRichBlocksRequestTheFullNativeContentWidth() {
        XCTAssertTrue(NativeMarkdownCompatibility.requiresFullWidthLayout("![alt](image.png)"))
        XCTAssertTrue(NativeMarkdownCompatibility.requiresFullWidthLayout("- [ ] unfinished"))
        XCTAssertTrue(NativeMarkdownCompatibility.requiresFullWidthLayout("| A | B |\n|---|---|\n| 1 | 2 |"))
        XCTAssertTrue(NativeMarkdownCompatibility.requiresFullWidthLayout("```swift\nlet value = 42\n```"))
        XCTAssertTrue(NativeMarkdownCompatibility.requiresFullWidthLayout("<details>\ntext\n</details>"))
    }

    func testKeepsSupportedMarkdownOnNativePath() {
        let markdown = """
        # Heading

        - first
        - second

        > quote with **bold**, ~~deleted~~, and [link](https://example.com)
        """

        XCTAssertFalse(NativeMarkdownCompatibility.requiresFullWidthLayout(markdown))
    }

    func testStandaloneProcessUsesNativeExpandableRow() {
        let reasoning = item(id: "reasoning", type: "reasoning", text: "Thinking")
        XCTAssertEqual(
            ChatTimelineRowRouting.route(
                for: ChatDisplayEntry(kind: .process(turnId: "turn", items: [reasoning]))
            ),
            .native
        )
    }

    func testUserMessageAndExecutionProcessBecomeSeparateDisplayEntries() {
        let user = item(id: "user", type: "userMessage", text: "hi")
        let reasoning = item(id: "reasoning", type: "reasoning", text: "Thinking")

        let entries = makeChatDisplayEntriesForTurn([user, reasoning])

        XCTAssertEqual(entries.count, 2)
        guard entries.count == 2 else { return }
        if case .message(let message) = entries[0].kind {
            XCTAssertEqual(message.id, user.id)
        } else {
            XCTFail("The first entry should remain the user message")
        }
        if case .process(let turnId, let items) = entries[1].kind {
            XCTAssertEqual(turnId, "turn")
            XCTAssertEqual(items.map(\.id), [reasoning.id])
        } else {
            XCTFail("The execution process should be its own display entry")
        }
    }

    func testPlainUserAndAgentMessagesRemainNative() {
        XCTAssertEqual(
            ChatTimelineRowRouting.route(
                for: ChatDisplayEntry(kind: .message(item(id: "user", type: "userMessage", text: "hi")))
            ),
            .native
        )
        XCTAssertEqual(
            ChatTimelineRowRouting.route(
                for: ChatDisplayEntry(kind: .message(item(id: "agent", type: "agentMessage", text: "Ready")))
            ),
            .native
        )
    }

    func testLongAgentReplyUsesDeterministicNativeLayoutPath() {
        let longReply = String(repeating: "A long model reply that wraps across several lines. ", count: 20)
        XCTAssertEqual(
            ChatTimelineRowRouting.route(
                for: ChatDisplayEntry(kind: .message(item(id: "long", type: "agentMessage", text: longReply)))
            ),
            .native
        )
        let manyLines = (0..<12).map { "line \($0)" }.joined(separator: "\n")
        XCTAssertEqual(
            ChatTimelineRowRouting.route(
                for: ChatDisplayEntry(kind: .message(item(id: "lines", type: "agentMessage", text: manyLines)))
            ),
            .native
        )
    }

    func testRichMarkdownStillUsesTheNativeTimelineLayout() {
        let markdown = "```swift\nlet value = 42\n```"
        XCTAssertEqual(
            ChatTimelineRowRouting.route(
                for: ChatDisplayEntry(kind: .message(item(id: "code", type: "agentMessage", text: markdown)))
            ),
            .native
        )
    }

    private func item(id: String, type: String, text: String) -> CodexThreadItem {
        CodexThreadItem(
            id: id,
            turnId: "turn",
            turnStatus: "complete",
            type: type,
            title: type == "userMessage" ? "User" : "Claude Code",
            text: text,
            options: nil,
            status: nil,
            createdAt: "2026-08-12T03:55:44.520Z"
        )
    }
}
