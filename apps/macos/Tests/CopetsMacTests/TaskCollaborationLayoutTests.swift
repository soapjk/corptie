import Testing
import Foundation
@testable import CorptieMac

struct TaskCollaborationLayoutTests {
    @Test func singleTaskWorkDoesNotRoundUpAgainAndChildFillsInterior() {
        for available in [360.0, 600, 900] {
            let work = WorkCardGrid.resolvedWidth(ideal: 336 + 24, available: available, gap: 12,
                contentSized: true, fillsAvailable: false)
            #expect(work == 360)
            let task = WorkCardGrid.resolvedWidth(ideal: 220, available: work - 24, gap: 8,
                contentSized: false, fillsAvailable: true)
            #expect(task + 24 == work)
        }
        #expect(WorkCardGrid.resolvedWidth(ideal: 360, available: 200, gap: 12,
            contentSized: true, fillsAvailable: false) == 200)
    }
    @Test func gridUsesIntegralSpansIncludingGutters() {
        for width in [180.0, 320, 600, 900] {
            let columns = max(1, Int((width + 12) / 192))
            let unit = floor((width + 12) / Double(columns))
            for ideal in [80.0, 200, 360, 800] {
                let value = WorkCardGrid.width(ideal: ideal, available: width, gap: 12)
                #expect(value <= width)
                #expect(value > 0)
                #expect(abs((value + 12) / unit - round((value + 12) / unit)) < 0.001)
            }
        }
    }

    @Test func flowEventDecodesOnlyRequiredMetadata() throws {
        let data = Data(#"{"payload":{"message":{"messageId":"m","channelId":"c","senderSessionId":"logical:a","createdAt":"2026-09-08T00:00:00.000Z","body":"ignored"}}}"#.utf8)
        let event = try JSONDecoder().decode(TaskCollaborationFlowEvent.Envelope.self, from: data)
        #expect(event.payload.message.senderSessionId == "logical:a")
        #expect(event.payload.message.channelId == "c")
    }
}
