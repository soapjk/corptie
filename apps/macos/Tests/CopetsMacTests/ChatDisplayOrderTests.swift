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

    private func item(id: String, type: String, turnId: String) -> CodexThreadItem {
        var result = CodexThreadItem(
            id: id,
            turnId: turnId,
            turnStatus: "complete",
            type: type,
            title: type == "userMessage" ? "User" : "Agent",
            text: id,
            options: nil,
            status: type == "commandExecution" ? "complete" : nil,
            createdAt: "2026-08-17T00:00:00Z"
        )
        if type == "agentMessage" {
            result.presentationRole = "final_answer"
        }
        return result
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
