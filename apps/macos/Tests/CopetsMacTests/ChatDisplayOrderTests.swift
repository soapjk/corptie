import XCTest
@testable import CorptieMac

final class ChatDisplayOrderTests: XCTestCase {
    func testReusedTurnIDPreservesAlternatingConversationOrder() {
        let items = [
            item(id: "user-1", type: "userMessage", turnId: ""),
            item(id: "agent-1", type: "agentMessage", turnId: ""),
            item(id: "user-2", type: "userMessage", turnId: ""),
            item(id: "tool-2", type: "commandExecution", turnId: ""),
            item(id: "agent-2", type: "agentMessage", turnId: "")
        ]

        let entries = makeChatDisplayEntries(from: items)

        XCTAssertEqual(entries.map(\.id), [
            "message:user-1",
            "message:agent-1",
            "message:user-2",
            "process::display-segment:1",
            "message:agent-2"
        ])
        XCTAssertEqual(underlyingItemIDs(in: entries), [
            "user-1", "agent-1", "user-2", "tool-2", "agent-2"
        ])
    }

    func testNoncontiguousRepeatedTurnIDDoesNotMergeAcrossTimeline() {
        let items = [
            item(id: "user-a1", type: "userMessage", turnId: "turn-a"),
            item(id: "agent-a1", type: "agentMessage", turnId: "turn-a"),
            item(id: "user-b", type: "userMessage", turnId: "turn-b"),
            item(id: "agent-b", type: "agentMessage", turnId: "turn-b"),
            item(id: "user-a2", type: "userMessage", turnId: "turn-a"),
            item(id: "agent-a2", type: "agentMessage", turnId: "turn-a")
        ]

        let entries = makeChatDisplayEntries(from: items)

        XCTAssertEqual(underlyingItemIDs(in: entries), items.map(\.id))
    }

    func testVisibleWindowKeepsLatestRecoveredTurnTogetherInOrder() {
        let items = [
            item(id: "user-1", type: "userMessage", turnId: "legacy-turn"),
            item(id: "agent-1", type: "agentMessage", turnId: "legacy-turn"),
            item(id: "user-2", type: "userMessage", turnId: "legacy-turn"),
            item(id: "tool-2", type: "commandExecution", turnId: "legacy-turn"),
            item(id: "agent-2", type: "agentMessage", turnId: "legacy-turn")
        ]

        let visible = visibleDetailEntries(
            from: makeChatDisplayEntries(from: items),
            limit: 3
        )

        XCTAssertEqual(underlyingItemIDs(in: visible), ["user-2", "tool-2", "agent-2"])
    }

    func testMessagesAreOrderedByTimestampAcrossTurns() {
        let items = [
            item(
                id: "agent-late",
                type: "agentMessage",
                turnId: "turn-2",
                createdAt: "2026-08-17T00:02:00Z"
            ),
            item(
                id: "user-early",
                type: "userMessage",
                turnId: "turn-1",
                createdAt: "2026-08-17T00:00:00Z"
            ),
            item(
                id: "agent-middle",
                type: "agentMessage",
                turnId: "turn-1",
                createdAt: "2026-08-17T00:01:00Z"
            )
        ]

        XCTAssertEqual(
            underlyingItemIDs(in: makeChatDisplayEntries(from: items)),
            ["user-early", "agent-middle", "agent-late"]
        )
    }

    func testEqualTimestampsKeepStableProviderOrder() {
        let timestamp = "2026-08-17T00:00:00Z"
        let items = [
            item(id: "agent-first", type: "agentMessage", turnId: "turn-a", createdAt: timestamp),
            item(id: "system-second", type: "system", turnId: "turn-b", createdAt: timestamp),
            item(id: "user-third", type: "userMessage", turnId: "turn-c", createdAt: timestamp)
        ]

        XCTAssertEqual(
            underlyingItemIDs(in: makeChatDisplayEntries(from: items)),
            ["agent-first", "system-second", "user-third"]
        )
    }

    func testMissingTimestampPreservesProviderOrder() {
        let items = [
            item(
                id: "later-dated",
                type: "agentMessage",
                turnId: "turn-a",
                createdAt: "2026-08-17T00:02:00Z"
            ),
            item(id: "undated", type: "system", turnId: "turn-b", createdAt: nil),
            item(
                id: "earlier-dated",
                type: "userMessage",
                turnId: "turn-c",
                createdAt: "2026-08-17T00:00:00Z"
            )
        ]

        XCTAssertEqual(
            underlyingItemIDs(in: makeChatDisplayEntries(from: items)),
            ["later-dated", "undated", "earlier-dated"]
        )
    }

    func testMixedFractionalTimestampFormatsUseChronologicalFallback() {
        let items = [
            item(
                id: "later-fractional",
                type: "agentMessage",
                turnId: "turn-2",
                createdAt: "2026-08-17T00:00:00.500Z"
            ),
            item(
                id: "earlier-whole",
                type: "userMessage",
                turnId: "turn-1",
                createdAt: "2026-08-17T00:00:00Z"
            )
        ]

        XCTAssertEqual(
            stableChronologicalChatItems(items).map(\.id),
            ["earlier-whole", "later-fractional"]
        )
    }

    func testMalformedFixedWidthTimestampPreservesProviderOrder() {
        let items = [
            item(id: "first", type: "agentMessage", turnId: "turn-1", createdAt: "2026-99-99T99:99:99Z"),
            item(id: "second", type: "userMessage", turnId: "turn-2", createdAt: "2026-00-00T00:00:00Z")
        ]

        XCTAssertEqual(stableChronologicalChatItems(items).map(\.id), ["first", "second"])
    }

    func testOpenClackyPartialHistoryDoesNotStackDatedUserMessagesAtTheTop() {
        let items = [
            item(
                id: "user-1",
                type: "userMessage",
                turnId: "turn-1",
                createdAt: "2026-08-18T10:24:10Z"
            ),
            item(id: "agent-1", type: "agentMessage", turnId: "turn-1", createdAt: nil),
            item(
                id: "user-2",
                type: "userMessage",
                turnId: "turn-2",
                createdAt: "2026-08-18T10:24:11Z"
            ),
            item(id: "agent-2", type: "agentMessage", turnId: "turn-2", createdAt: nil)
        ]

        XCTAssertEqual(
            underlyingItemIDs(in: makeChatDisplayEntries(from: items)),
            ["user-1", "agent-1", "user-2", "agent-2"]
        )
    }

    func testUnreadTailRevisionIgnoresHistoryPrepends() {
        let current = [
            item(id: "user", type: "userMessage", turnId: "turn"),
            item(id: "agent", type: "agentMessage", turnId: "turn")
        ]
        let prepended = [
            item(id: "history", type: "agentMessage", turnId: "older")
        ] + current

        XCTAssertEqual(
            timelineTailContentRevision(for: prepended),
            timelineTailContentRevision(for: current)
        )
    }

    func testUnreadTailRevisionChangesWhenContentArrivesBelow() {
        let current = [
            item(id: "user", type: "userMessage", turnId: "turn")
        ]
        let withNewTailContent = current + [
            item(id: "agent", type: "agentMessage", turnId: "turn")
        ]

        XCTAssertNotEqual(
            timelineTailContentRevision(for: withNewTailContent),
            timelineTailContentRevision(for: current)
        )
    }

    func testDisplayProjectionChangesWhenFinalReplyBeforeExecutionTailCompletes() {
        let initial = detail(items: [
            item(id: "agent", type: "agentMessage", turnId: "turn", text: "Draft A"),
            item(id: "command", type: "commandExecution", turnId: "turn"),
            item(id: "plan", type: "plan", turnId: "turn")
        ])
        let completed = detail(items: [
            item(id: "agent", type: "agentMessage", turnId: "turn", text: "Final B"),
            item(id: "command", type: "commandExecution", turnId: "turn"),
            item(id: "plan", type: "plan", turnId: "turn")
        ])

        let initialCache = makeDetailDisplayCache(
            for: initial,
            sessionId: "session",
            visibleMessageLimit: 100
        )
        let completedCache = makeDetailDisplayCache(
            for: completed,
            sessionId: "session",
            visibleMessageLimit: 100
        )

        XCTAssertNotEqual(completedCache.sourceSignature, initialCache.sourceSignature)
        XCTAssertNotEqual(completedCache.signature, initialCache.signature)
    }

    func testUnclassifiedAssistantMessagesRemainVisibleInsteadOfBeingFoldedIntoExecution() {
        var first = item(id: "assistant-unknown-1", type: "agentMessage", turnId: "turn")
        var second = item(id: "assistant-unknown-2", type: "agentMessage", turnId: "turn")
        first.presentationRole = nil
        second.presentationRole = nil

        let entries = makeChatDisplayEntriesForTurn([first, second])

        XCTAssertEqual(entries.map(\.id), [
            "message:assistant-unknown-1",
            "message:assistant-unknown-2"
        ])
    }

    private func item(
        id: String,
        type: String,
        turnId: String,
        text: String? = nil,
        createdAt: String? = "2026-08-17T00:00:00Z"
    ) -> CodexThreadItem {
        var result = CodexThreadItem(
            id: id,
            turnId: turnId,
            turnStatus: "complete",
            type: type,
            title: type == "userMessage" ? "User" : "Agent",
            text: text ?? id,
            options: nil,
            status: type == "commandExecution" ? "complete" : nil,
            createdAt: createdAt
        )
        if type == "agentMessage" {
            result.presentationRole = "final_answer"
        }
        return result
    }

    private func detail(items: [CodexThreadItem]) -> CodexThreadDetail {
        CodexThreadDetail(
            id: "thread", title: "Session", status: .complete, source: nil,
            connectionStatus: nil, currentModel: "gpt-5.6-sol",
            currentReasoningLevel: "high", activityStatus: nil, cwd: "/tmp",
            createdAt: "2026-08-26T00:00:00Z", updatedAt: "2026-08-26T00:00:00Z",
            canSend: true, sendUnavailableReason: nil, capabilities: nil,
            turnCount: 1, items: items
        )
    }

    private func underlyingItemIDs(in entries: [ChatDisplayEntry]) -> [String] {
        entries.flatMap { entry in
            switch entry.kind {
            case .message(let item):
                return [item.id]
            case .process(_, let items):
                return items.map(\.id)
            }
        }
    }
}
