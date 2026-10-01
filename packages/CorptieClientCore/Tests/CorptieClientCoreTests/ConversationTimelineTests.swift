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
        #expect(entries.map(\.id) == ["message:u", "message:p", "process:turn", "message:legacy", "message:a"])
        guard case let .process(_, process) = entries[2].kind else { Issue.record("Missing process"); return }
        #expect(process.map(\.id) == ["t"])
        #expect(process[0].processStartedAt == "2026-09-19T00:00:00Z")
        #expect(process[0].processEndedAt == "2026-09-19T00:00:03Z")
        #expect(items[1].processStartedAt == nil)
        #expect(entries[2].displayWeight == 0)
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

    @Test func concurrentUserMessageDoesNotSplitActiveTurnExecutionProcess() throws {
        // Turn 1 starts with u1, then runs tool t1
        let u1 = try message("u1", "userMessage", turn: "turn:1", date: "2026-09-19T00:00:00Z")
        let t1 = try message("t1", "commandExecution", turn: "turn:1", status: "running", date: "2026-09-19T00:00:01Z")
        // User concurrently sends u2 while turn 1 is still in progress
        let u2 = try message("u2", "userMessage", turn: "turn:2", date: "2026-09-19T00:00:02Z")
        // Turn 1 continues executing: emits t2 and final answer a1
        let t2 = try message("t2", "mcpToolCall", turn: "turn:1", status: "running", date: "2026-09-19T00:00:03Z")
        let a1 = try message("a1", "agentMessage", role: "final_answer", turn: "turn:1", status: "completed", date: "2026-09-19T00:00:04Z")

        let entries = ConversationTimeline.makeEntries(from: [u1, t1, u2, t2, a1])
        // Turn 1 entries should stay causally grouped together, followed by u2
        #expect(entries.map(\.id) == ["message:u1", "process:turn:1", "message:a1", "message:u2"])
        guard case let .process(_, processItems) = entries[1].kind else {
            Issue.record("Expected process group for turn:1")
            return
        }
        #expect(processItems.map(\.id) == ["t1", "t2"])
    }

    @Test func interleavedProcessSegmentsSplitByDirectPlanAndCommentaryCards() throws {
        let u = try message("u", "userMessage", turn: "turn:1", date: "2026-09-19T00:00:00Z")
        let t1 = try message("t1", "commandExecution", turn: "turn:1", date: "2026-09-19T00:00:01Z")
        let plan = try message("plan", "executionPlan", turn: "turn:1", date: "2026-09-19T00:00:02Z")
        let t2 = try message("t2", "mcpToolCall", turn: "turn:1", date: "2026-09-19T00:00:03Z")
        let comm = try message("c", "agentMessage", role: "commentary", turn: "turn:1", date: "2026-09-19T00:00:04Z")
        let t3 = try message("t3", "commandExecution", turn: "turn:1", date: "2026-09-19T00:00:05Z")
        let a = try message("a", "agentMessage", role: "final_answer", turn: "turn:1", status: "completed", date: "2026-09-19T00:00:06Z")

        let entries = ConversationTimeline.makeEntries(from: [u, t1, plan, t2, comm, t3, a])
        #expect(entries.map(\.id) == [
            "message:u",
            "process:turn:1",
            "message:plan",
            "process:turn:1:process-segment:1",
            "message:c",
            "process:turn:1:process-segment:2",
            "message:a"
        ])

        guard case let .process(p0Turn, p0Items) = entries[1].kind,
              case let .process(p1Turn, p1Items) = entries[3].kind,
              case let .process(p2Turn, p2Items) = entries[5].kind else {
            Issue.record("Missing expected interleaved process segments")
            return
        }

        #expect(p0Turn == "turn:1")
        #expect(p0Items.map(\.id) == ["t1"])
        #expect(p0Items[0].processStartedAt == "2026-09-19T00:00:00Z")
        #expect(p0Items[0].processEndedAt == "2026-09-19T00:00:01Z")
        #expect(ConversationProcessPresentation.state(for: p0Items) == .completed)

        #expect(p1Turn == "turn:1:process-segment:1")
        #expect(p1Items.map(\.id) == ["t2"])
        #expect(p1Items[0].processStartedAt == "2026-09-19T00:00:03Z")
        #expect(p1Items[0].processEndedAt == "2026-09-19T00:00:03Z")
        #expect(ConversationProcessPresentation.state(for: p1Items) == .completed)

        #expect(p2Turn == "turn:1:process-segment:2")
        #expect(p2Items.map(\.id) == ["t3"])
        #expect(p2Items[0].processStartedAt == "2026-09-19T00:00:05Z")
        #expect(p2Items[0].processEndedAt == "2026-09-19T00:00:06Z")
        #expect(ConversationProcessPresentation.state(for: p2Items) == .completed)
    }
}
