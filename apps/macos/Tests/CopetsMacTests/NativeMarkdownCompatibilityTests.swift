import AppKit
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

    func testExecutionProcessAppearsOnlyAfterItHasContent() {
        let user = item(id: "user", type: "userMessage", text: "hi", turnStatus: "inProgress")

        let userOnlyEntries = makeChatDisplayEntriesForTurn([user])

        XCTAssertEqual(userOnlyEntries.count, 1)
        guard case .message(let message) = userOnlyEntries[0].kind else {
            return XCTFail("A user-only turn should not create an empty execution process")
        }
        XCTAssertEqual(message.id, user.id)

        let reasoning = item(
            id: "reasoning",
            type: "reasoning",
            text: "Thinking",
            turnStatus: "inProgress"
        )
        let entriesWithProcessContent = makeChatDisplayEntriesForTurn([user, reasoning])

        XCTAssertEqual(entriesWithProcessContent.count, 2)
        guard case .process(_, let processItems) = entriesWithProcessContent[1].kind else {
            return XCTFail("The first execution item should create the process card")
        }
        XCTAssertEqual(processItems.map(\.id), [reasoning.id])
        XCTAssertEqual(projectedProcessState(for: processItems), .running)
    }

    @MainActor
    func testExpandedExecutionRawStatusUsesLatestProviderItem() {
        var first = item(id: "command", type: "commandExecution", text: "$ npm test")
        first.rawMetadataJSON = "{\"command\":\"npm test\"}"
        var latest = item(id: "reasoning", type: "reasoning", text: "Thinking", turnStatus: "inProgress")
        latest.rawMetadataJSON = "{\"type\":\"reasoning\",\"summary\":[]}"

        let rawStatus = processRawStatusText(for: [first, latest])

        XCTAssertTrue(rawStatus.contains("item_id: reasoning"))
        XCTAssertTrue(rawStatus.contains("turn_status: inProgress"))
        XCTAssertTrue(rawStatus.contains("provider_metadata:"))
        XCTAssertTrue(rawStatus.contains("\"summary\":[]"))
        XCTAssertFalse(rawStatus.contains("npm test"))
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

    private func item(
        id: String,
        type: String,
        text: String,
        turnStatus: String = "complete"
    ) -> CodexThreadItem {
        CodexThreadItem(
            id: id,
            turnId: "turn",
            turnStatus: turnStatus,
            type: type,
            title: type == "userMessage" ? "User" : "Claude Code",
            text: text,
            options: nil,
            status: nil,
            createdAt: "2026-08-12T03:55:44.520Z"
        )
    }
}
