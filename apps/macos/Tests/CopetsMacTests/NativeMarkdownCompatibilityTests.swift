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

    func testExecutionDurationUsesTheCompleteTurnInsteadOfOnlyProcessItems() {
        let user = item(
            id: "user",
            type: "userMessage",
            text: "run tests",
            createdAt: "2026-08-12T03:55:40.000Z"
        )
        let command = item(
            id: "command",
            type: "commandExecution",
            text: "swift test",
            createdAt: "2026-08-12T03:55:44.000Z"
        )
        var final = item(
            id: "final",
            type: "agentMessage",
            text: "Done",
            createdAt: "2026-08-12T03:55:52.000Z"
        )
        final.presentationRole = "final_answer"

        let entries = makeChatDisplayEntriesForTurn([user, command, final])
        guard case .process(_, let processItems) = entries[1].kind else {
            return XCTFail("Expected an execution process")
        }

        XCTAssertEqual(processItems.first?.processStartedAt, user.createdAt)
        XCTAssertEqual(processItems.first?.processEndedAt, final.createdAt)
        XCTAssertEqual(executionProcessDurationText(for: processItems), "12s")
    }

    func testSingleTimestampDoesNotInventSubsecondExecutionDuration() {
        let command = item(id: "command", type: "commandExecution", text: "swift test")

        XCTAssertNil(executionProcessDurationText(for: [command]))
    }

    @MainActor
    func testCollaborationCardPresentsRouteSessionTaskStatusAndMessage() throws {
        var collaboration = item(
            id: "collaboration",
            type: "userMessage",
            text: "trusted envelope"
        )
        collaboration.sourceType = "collaboration"
        collaboration.presentationRole = "collaboration"
        collaboration.presentationText = "Please review the API contract."
        collaboration.collaborationSenderName = "Platform Agent"
        collaboration.collaborationSenderAgentId = "agent:platform"
        collaboration.collaborationRecipientName = "macOS Agent"
        collaboration.collaborationRecipientAgentId = "agent:macos"
        collaboration.collaborationRecipientSessionTitle = "Sessions UI"
        collaboration.collaborationRecipientSessionId = "session:ui"
        collaboration.collaborationRecipientSessionKind = "worker"
        collaboration.collaborationTargetWorkItemId = "work_item:ui"
        collaboration.collaborationInitiatorSessionTitle = "Platform Objective Chat"
        collaboration.collaborationInitiatorSessionId = "session:platform"
        collaboration.collaborationInitiatorSessionKind = "objectiveChat"
        collaboration.collaborationSourceObjectiveName = "Platform"
        collaboration.collaborationSourceObjectiveId = "objective:platform"
        collaboration.collaborationTargetObjectiveName = "macOS"
        collaboration.collaborationTargetObjectiveId = "objective:macos"
        collaboration.collaborationTaskTitle = "Review collaboration card"
        collaboration.collaborationMessageKind = "change_request"
        collaboration.collaborationProcessingStatus = "running"

        let presentation = try XCTUnwrap(nativeCollaborationCardPresentation(
            for: collaboration,
            currentSessionTitle: "Fallback Session"
        ))

        XCTAssertTrue(presentation.title.contains(L10n("Agent 协作")))
        XCTAssertTrue(presentation.title.contains(L10n("修改请求")))
        XCTAssertTrue(presentation.metadata.contains(L10n("处理中")))
        XCTAssertTrue(presentation.bodyMarkdown.contains("Platform Agent · agent:platform"))
        XCTAssertTrue(presentation.bodyMarkdown.contains("macOS Agent · agent:macos"))
        XCTAssertTrue(presentation.bodyMarkdown.contains("Sessions UI · session:ui"))
        XCTAssertTrue(presentation.bodyMarkdown.contains("worker · work\\_item:ui"))
        XCTAssertTrue(presentation.bodyMarkdown.contains("Platform · objective:platform"))
        XCTAssertTrue(presentation.bodyMarkdown.contains("macOS · objective:macos"))
        XCTAssertTrue(presentation.bodyMarkdown.contains("Review collaboration card"))
        XCTAssertTrue(presentation.bodyMarkdown.contains("Please review the API contract."))
        XCTAssertEqual(presentation.messageText, "Please review the API contract.")
    }

    @MainActor
    func testInboundCollaborationFallsBackToCurrentSessionTitle() throws {
        var collaboration = item(id: "collaboration", type: "userMessage", text: "Need context")
        collaboration.sourceType = "collaboration"
        collaboration.collaborationSenderName = "Peer Agent"
        collaboration.collaborationRecipientName = "Current Agent"

        let presentation = try XCTUnwrap(nativeCollaborationCardPresentation(
            for: collaboration,
            currentSessionTitle: "Current Work Session"
        ))

        XCTAssertTrue(presentation.bodyMarkdown.contains("Current Work Session"))
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
        turnStatus: String = "complete",
        createdAt: String = "2026-08-12T03:55:44.520Z"
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
            createdAt: createdAt
        )
    }
}
