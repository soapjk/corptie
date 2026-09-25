import Foundation
import Testing
@testable import CorptieClientCore

struct ConversationTimelineTests {
    private func message(_ id: String, _ type: String, role: String? = nil,
                         turn: String? = "turn", status: String = "running",
                         date: String? = nil) throws -> ClientMessage {
        var value: [String: Any] = ["id": id, "type": type, "text": id, "turnStatus": status]
        value["turnId"] = turn
        value["presentationRole"] = role
        value["createdAt"] = date
        return try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: value))
    }

    @Test func commentaryAndToolsShareProcessButFinalAndUnclassifiedRepliesRemainVisible() throws {
        let items = try [message("u", "userMessage", date: "2026-09-19T00:00:00Z"),
                         message("p", "agentMessage", role: "commentary"),
                         message("t", "mcpToolCall"),
                         message("legacy", "agentMessage"),
                         message("a", "agentMessage", role: "final_answer", status: "completed", date: "2026-09-19T00:00:03Z")]
        let entries = ConversationTimeline.makeEntries(from: items)
        #expect(entries.map(\.id) == ["message:u", "process:turn", "message:legacy", "message:a"])
        guard case let .process(_, process) = entries[1].kind else { Issue.record("Missing process"); return }
        #expect(process.map(\.id) == ["p", "t"])
        #expect(process[0].processStartedAt == "2026-09-19T00:00:00Z")
        #expect(process[0].processEndedAt == "2026-09-19T00:00:03Z")
        #expect(items[1].processStartedAt == nil)
        #expect(entries[1].displayWeight == 0)
    }

    @Test func missingTurnIDsRecoverBoundariesWithoutCollapsingConversation() throws {
        let items = try [message("u1", "userMessage", turn: nil), message("a1", "agentMessage", turn: nil),
                         message("u2", "userMessage", turn: nil), message("t2", "commandExecution", turn: nil),
                         message("a2", "agentMessage", role: "final_answer", turn: nil)]
        #expect(ConversationTimeline.makeEntries(from: items).map(\.id) == [
            "message:u1", "message:a1", "message:u2", "process::display-segment:1", "message:a2"])
    }

    @Test func mixedTimestampFormatsSortStablyAndMissingDatesPreserveSourceOrder() throws {
        let late = try message("late", "agentMessage", date: "2026-09-19T08:00:02+08:00")
        let early = try message("early", "userMessage", date: "2026-09-19T00:00:01.000Z")
        #expect(ConversationTimeline.orderedItems([late, early]).map(\.id) == ["early", "late"])
        let undated = try message("unknown", "mcpToolCall")
        #expect(ConversationTimeline.orderedItems([late, undated, early]).map(\.id) == ["late", "unknown", "early"])
    }

    @Test func providerExecutionEventsDoNotBecomeStandaloneChatBubbles() throws {
        let executionTypes = ["sleep", "imageView", "collabAgentToolCall", "collabToolCall",
                              "functionCallOutput", "enteredReviewMode", "exitedReviewMode"]
        let items = try [message("user", "userMessage")]
            + executionTypes.enumerated().map { index, type in try message("step:\(index)", type) }
            + [message("answer", "agentMessage", role: "final_answer", status: "completed")]
        let entries = ConversationTimeline.makeEntries(from: items)
        #expect(entries.map(\.id) == ["message:user", "process:turn", "message:answer"])
        guard case let .process(_, process) = entries[1].kind else {
            Issue.record("Missing process group"); return
        }
        #expect(process.map(\.type) == executionTypes)
    }

    @Test func interactionsErrorsAndUnknownEventsRemainVisible() throws {
        let standaloneTypes = ["approval", "choice", "userInput", "error", "system",
                               "automationEvent", "systemEvent", "imageGeneration", "futureProviderEvent"]
        let items = try standaloneTypes.enumerated().map { index, type in
            try message("event:\(index)", type)
        }
        let entries = ConversationTimeline.makeEntries(from: items)
        #expect(entries.map(\.id) == items.map { "message:\($0.id)" })
    }
}
