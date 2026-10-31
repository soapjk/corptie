import Foundation
import Testing
@testable import CorptieClientCore

struct ConversationReplyProgressProjectionTests {
    private func message(_ id: String, type: String = "agentMessage", role: String? = "commentary",
                         status: String = "running", turn: String? = "turn", origin: String? = nil,
                         date: String? = nil, image: Bool = false, end: String? = nil) throws -> ClientMessage {
        var value: [String: Any] = ["id": id, "type": type, "text": String(repeating: id + "\n", count: 30), "turnStatus": status]
        value["turnId"] = turn; value["presentationRole"] = role; value["messageOrigin"] = origin
        value["createdAt"] = date; value["processEndedAt"] = end
        if image { value["images"] = [["managedPath": "chat-resources/test/image.png"]] }
        return try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: value))
    }

    private func project(_ items: [ClientMessage]) -> ConversationReplyProgressProjection.Result<ClientMessage> {
        ConversationReplyProgressProjection.project(ConversationTimeline.makeEntries(from: items))
    }

    @Test func runningKeepsOnlyLatestExplanationAndPreservesFullPayload() throws {
        let old = try message("old"), latest = try message("latest")
        let tool = try message("tool", type: "mcpToolCall", role: nil)
        let result = project([old, tool, latest])
        #expect(result.entries.map(\.id) == ["process:turn", "message:latest"])
        guard case .process(_, let archived) = result.entries[0].kind else { Issue.record("Missing archive"); return }
        #expect(archived.map(\.id) == ["old", "tool"])
        #expect(archived[0].text == old.text)
        #expect(result.entries[0].processReplyState == .running)
        #expect(result.resolveRowID("message:old") == "process:turn")
        #expect(result.resolveRowID("message:latest") == "message:latest")
    }

    @Test(arguments: ["completed", "complete", "failed", "error", "cancelled", "canceled", "interrupted"])
    func terminalArchivesAllAndRemainsIdempotent(status: String) throws {
        let old = try message("old"), latest = try message("latest")
        let final = try message("final", role: "final_answer", status: status)
        let result = project([old, latest, final])
        #expect(result.entries.map(\.id) == ["process:commentary:old", "message:final"])
        let expected: ConversationProcessState = ["complete", "completed"].contains(status) ? .completed
            : (["failed", "error"].contains(status) ? .failed : .cancelled)
        #expect(result.entries[0].processReplyState == expected)
        #expect(result.entries[0].processReplyCompleted == (expected == .completed))
        let repeated = ConversationReplyProgressProjection.project(result.entries)
        #expect(repeated.entries.map(\.id) == result.entries.map(\.id))
        #expect(repeated.entries[0].processReplyState == expected)
        #expect(result.resolveRowID("message:latest") == result.entries[0].id)
    }

    @Test func scheduledMediaInteractionsAndUnknownMessagesStayIndependent() throws {
        let items = try [message("old"), message("scheduled", origin: "scheduled_task"),
            message("media", image: true), message("unknown", role: nil),
            message("question", type: "userInput", role: nil),
            message("approval", type: "approval", role: nil),
            message("choice", type: "choice", role: nil),
            message("system", type: "systemEvent", role: "system_event"),
            message("collab", type: "agentMessage", role: "collaboration", status: "completed"),
            message("final", role: "final_answer", status: "completed")]
        let result = project(items)
        for id in ["scheduled", "media", "unknown", "question", "approval", "choice", "system", "collab", "final"] {
            #expect(result.entries.contains { $0.id == "message:" + id })
        }
        #expect(result.resolveRowID("message:old")?.hasPrefix("process:") == true)
    }

    @Test func unknownTurnAndRoleAreNotHidden() throws {
        let result = project(try [message("one", turn: nil), message("two", turn: nil),
                                  message("final", role: "final_answer", status: "completed", turn: nil)])
        #expect(result.entries.map(\.id) == ["message:one", "message:two", "message:final"])
    }

    @Test func turnsAndUserBoundariesDoNotMerge() throws {
        let result = project(try [message("one", turn: "a"),
            message("user", type: "userMessage", role: nil, turn: "b"), message("two", turn: "b")])
        #expect(result.entries.map(\.id) == ["message:one", "message:user", "message:two"])
    }

    @Test func fullReplyClockIgnoresClosedToolSegmentsAndIncludesFinal() throws {
        let user = try message("user", type: "userMessage", role: nil, date: "2026-10-31T00:00:00Z")
        let tool = try message("tool", type: "mcpToolCall", role: nil,
            date: "2026-10-31T00:00:01Z", end: "2026-10-31T00:00:02Z")
        let comment = try message("comment", date: "2026-10-31T00:00:03Z")
        let live = project([user, tool, comment])
        #expect(live.entries[1].processReplyState == .running)
        #expect(live.boundsByRowID[live.entries[1].id]?.endedAt == nil)
        let final = try message("final", role: "final_answer", status: "completed", date: "2026-10-31T00:00:10Z")
        let ended = project([user, tool, comment, final])
        let bounds = try #require(ended.boundsByRowID[ended.entries[1].id])
        #expect(bounds.startedAt == ConversationTimestampText.date(from: "2026-10-31T00:00:00Z"))
        #expect(bounds.endedAt?.timeIntervalSince(try #require(bounds.startedAt)) == 10)
        #expect(tool.processEndedAt == "2026-10-31T00:00:02Z")
    }

    @Test func mergedProcessSegmentsResolveOldIdentities() throws {
        let first = try message("first", type: "mcpToolCall", role: nil)
        let second = try message("second", type: "mcpToolCall", role: nil)
        let source: [ConversationEntry<ClientMessage>] = [
            .init(kind: .process(turnId: "turn", items: [first])),
            .init(kind: .message(try message("explanation"))),
            .init(kind: .process(turnId: "turn:process-segment:1", items: [second]))]
        let result = ConversationReplyProgressProjection.project(source)
        #expect(result.resolveRowID("process:turn:process-segment:1") == "process:turn")
    }

    @Test func reusedTurnIDDoesNotMergeReplyClocksAcrossUserBoundaries() throws {
        let result = project(try [
            message("user:1", type: "userMessage", role: nil, date: "2026-10-31T00:00:00Z"),
            message("comment:1", status: "completed", date: "2026-10-31T00:00:01Z"),
            message("final:1", role: "final_answer", status: "completed", date: "2026-10-31T00:00:02Z"),
            message("user:2", type: "userMessage", role: nil, date: "2026-10-31T01:00:00Z"),
            message("comment:2", status: "completed", date: "2026-10-31T01:00:01Z"),
            message("final:2", role: "final_answer", status: "completed", date: "2026-10-31T01:00:03Z")])
        let cards = result.entries.filter(\.isProcessGroup)
        #expect(cards.count == 2)
        for (index, card) in cards.enumerated() {
            let bounds = try #require(result.boundsByRowID[card.id])
            #expect(bounds.endedAt?.timeIntervalSince(try #require(bounds.startedAt)) == Double(index + 2))
        }
    }

    @Test(arguments: ["2026-10-31T00:00:01Z", "2026-10-31T00:00:01.123Z", "2026-10-31T08:00:01+08:00", "2026-10-31T08:00:01.123+08:00"])
    func replyClockAcceptsSharedTimestampFormats(timestamp: String) throws {
        let result = project(try [message("comment", date: timestamp),
            message("final", role: "final_answer", status: "completed", date: timestamp)])
        let bounds = try #require(result.boundsByRowID[result.entries[0].id])
        let parsed = try #require(bounds.startedAt)
        let legacy = try #require(ConversationTimestampText.date(from: timestamp))
        // FormatStyle preserves sub-millisecond precision; ICU's formatter
        // rounds the same ISO value slightly differently in binary floating point.
        #expect(abs(parsed.timeIntervalSince(legacy)) < 0.000001)
        #expect(bounds.endedAt == bounds.startedAt)
    }

    @Test func projectionScalesAcrossResidentWindows() throws {
        for count in [1_000, 5_000, 10_000] {
            let formatter = ISO8601DateFormatter()
            let items = try (0..<count).map { index in
                try message("item:\(index)", role: index % 5 == 4 ? "final_answer" : "commentary",
                    status: "completed", turn: "turn:\(index / 5)",
                    date: formatter.string(from: Date(timeIntervalSince1970: 1_700_000_000 + Double(index))))
            }
            let base = ConversationTimeline.makeEntries(from: items)
            let clock = ContinuousClock()
            let groupingTime = clock.measure {
                #expect(ConversationReplyProgressProjection.entries(base).count == count / 5 * 2)
            }
            let elapsed = clock.measure {
                let result = ConversationReplyProgressProjection.project(base)
                #expect(result.entries.count == count / 5 * 2)
                #expect(result.rowIDsBySourceID.count >= count)
            }
            print("Reply progress projection \(count) items: grouping=\(groupingTime), full=\(elapsed)")
            // Record wall time, but do not turn contention on a shared build
            // host into a functional failure. Device frame/memory validation
            // remains a separate acceptance check, not a claim from this test.
        }
    }
}
