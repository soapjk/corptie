import Foundation
import Testing
@testable import CorptieClientCore

struct ConversationProcessPresentationTests {
    @Test(arguments: [(0.01, "0.01s"), (4.2, "4.20s"), (9.999, "10.00s"),
        (59.994, "59.99s"), (59.999, "1m 0.00s"), (60.01, "1m 0.01s"),
        (3599.999, "1h 0m 0.00s"), (3661.234, "1h 1m 1.23s")])
    func hundredthsRemainVisibleAcrossMinuteAndHourBoundaries(seconds: Double, expected: String) {
        let start = Date(timeIntervalSince1970: 1000)
        #expect(ConversationProcessPresentation.durationText(startedAt: start,
            endingAt: start.addingTimeInterval(seconds)) == expected)
        let completed = ConversationProcessPresentation(state: .completed, count: 1, duration: "12.34s")
        #expect(completed.summary(languageCode: "en") == "Processed for 12.34s · 1 step")
        #expect(completed.summary(languageCode: "zh-Hans") == "已处理 12.34秒 · 1 步")
    }

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
        #expect(ConversationProcessPresentation.durationText(for: [completed]) == "1m 12.00s")
        #expect(ConversationProcessPresentation.durationText(for: [completed],
            now: Date(timeIntervalSince1970: 2_000_000_000)) == "1m 12.00s")
        let running = try item(["processStartedAt": start, "turnStatus": "running"])
        let base = try #require(ISO8601DateFormatter().date(from: start))
        for (seconds, expected) in [(0.01, "0.01s"), (4.2, "4.20s"), (17.0, "17.00s"),
                                    (60.0, "1m 0.00s"), (3660.0, "1h 1m 0.00s")] {
            #expect(ConversationProcessPresentation.durationText(for: [running],
                now: base.addingTimeInterval(seconds)) == expected)
        }
        #expect(ConversationProcessPresentation.durationText(for: [running],
            now: base.addingTimeInterval(-5)) == nil)
        #expect(ConversationProcessPresentation.startedAt(for: [running]) == base)
        #expect(ConversationProcessPresentation.durationText(for: [running], now: base) == "0.00s")
        #expect(ConversationProcessPresentation.elapsedRefreshInterval == 1.0 / 100.0)
        #expect(ConversationProcessPresentation.durationText(
            startedAt: base, endingAt: base.addingTimeInterval(5)) == "5.00s")
        #expect(ConversationProcessPresentation.durationText(
            startedAt: base, endingAt: base.addingTimeInterval(6)) == "6.00s")
        #expect(ConversationProcessPresentation.durationText(
            startedAt: base, endingAt: base.addingTimeInterval(60), showSeconds: true) == "1m 0.00s")
        #expect(ConversationProcessPresentation.durationText(
            startedAt: base, endingAt: base.addingTimeInterval(3_660), showSeconds: true) == "1h 1m 0.00s")
        #expect(ConversationProcessPresentation.durationText(
            startedAt: base, endingAt: base.addingTimeInterval(3_661), showSeconds: true) == "1h 1m 1.00s")
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
        let completed = ConversationProcessPresentation(state: .completed, count: 3, duration: "1.2s")
        #expect(completed.summary(languageCode: "en") == "Processed for 1.2s · 3 steps")
        #expect(completed.summary(languageCode: "zh-Hans") == "已处理 1.2秒 · 3 步")
        #expect(ConversationProcessPresentation(state: .completed, count: 1, duration: "1m 12.00s")
            .summary(languageCode: "zh") == "已处理 1分钟 12.00秒 · 1 步")
        #expect(ConversationProcessPresentation(state: .completed, count: 1, duration: "1h 2m")
            .summary(languageCode: "zh") == "已处理 1小时 2分钟 · 1 步")
        #expect(ConversationProcessPresentation(state: .running, count: 2).summary == "Working… · 2 steps")
        #expect(ConversationProcessPresentation(state: .completed, count: 1).summary == "Completed · 1 step")
        #expect(ConversationProcessPresentation(state: .failed, count: 2, duration: "· 3s").summary == "Execution failed after 3s · 2 steps")
        #expect(ConversationProcessPresentation(state: .cancelled, count: 2).summary == "Execution stopped · 2 steps")
    }
}
