import Foundation
import Testing
@testable import CorptieClientCore

struct ConversationProcessPresentationTests {
    @Test func durationUsesProjectedBoundsAndDoesNotInventMissingTime() throws {
        func item(_ fields: [String: String]) throws -> ClientMessage {
            let data = try JSONSerialization.data(withJSONObject:
                ["id": "tool", "type": "commandExecution", "text": "result"].merging(fields) { _, next in next })
            return try JSONDecoder().decode(ClientMessage.self, from: data)
        }
        let start = "2026-09-19T00:00:00Z"
        let single = try item(["createdAt": start, "turnStatus": "completed"])
        #expect(ConversationProcessPresentation.durationText(for: [single]) == nil)
        let completed = try item(["createdAt": "2026-09-19T00:00:10Z", "turnStatus": "completed",
            "processStartedAt": start, "processEndedAt": "2026-09-19T00:01:12Z"])
        #expect(ConversationProcessPresentation.durationText(for: [completed]) == "1m 12s")
        let running = try item(["processStartedAt": start, "turnStatus": "running"])
        let base = try #require(ISO8601DateFormatter().date(from: start))
        for (seconds, expected) in [(0.01, nil), (4.2, "4.2s"), (17.0, "17s"),
                                    (60.0, "1m"), (3660.0, "1h 1m")] {
            #expect(ConversationProcessPresentation.durationText(for: [running],
                now: base.addingTimeInterval(seconds)) == expected)
        }
        #expect(ConversationProcessPresentation.durationText(for: [running],
            now: base.addingTimeInterval(-5)) == nil)
        #expect(ConversationProcessPresentation.startedAt(for: [running]) == base)
        #expect(ConversationProcessPresentation.durationText(
            startedAt: base, endingAt: base.addingTimeInterval(5)) == "5.0s")
        #expect(ConversationProcessPresentation.durationText(
            startedAt: base, endingAt: base.addingTimeInterval(6)) == "6.0s")
        #expect(ConversationProcessPresentation.durationText(
            startedAt: base, endingAt: base.addingTimeInterval(60), showSeconds: true) == "1m 0s")
        #expect(ConversationProcessPresentation.durationText(
            startedAt: base, endingAt: base.addingTimeInterval(3_660), showSeconds: true) == "1h 1m 0s")
        #expect(ConversationProcessPresentation.durationText(
            startedAt: base, endingAt: base.addingTimeInterval(3_661), showSeconds: true) == "1h 1m 1s")
        let invalid = try item(["createdAt": "bad-date", "turnStatus": "completed"])
        #expect(ConversationProcessPresentation.durationText(for: [invalid]) == nil)
    }

    @Test func outcomeUsesTurnLifecycleInsteadOfIndividualToolFailure() throws {
        for (turn, expected) in [("running", ConversationProcessState.running), ("completed", .completed),
                                  ("failed", .failed), ("interrupted", .cancelled)] {
            let data = try JSONSerialization.data(withJSONObject: ["id": "tool", "type": "commandExecution",
                "text": "output", "status": "failed", "turnStatus": turn])
            let item = try JSONDecoder().decode(ClientMessage.self, from: data)
            #expect(ConversationProcessPresentation.state(for: [item]) == expected)
        }
    }

    @Test func summariesKeepDesktopWordingAndDurationRules() {
        #expect(ConversationProcessPresentation(state: .running, count: 2).summary == "Working… · 2 steps")
        #expect(ConversationProcessPresentation(state: .completed, count: 1).summary == "Completed · 1 step")
        #expect(ConversationProcessPresentation(state: .failed, count: 2, duration: "· 3s").summary == "Execution failed after 3s · 2 steps")
        #expect(ConversationProcessPresentation(state: .cancelled, count: 2).summary == "Execution stopped · 2 steps")
    }
}
