import Testing
import Foundation
@testable import CorptieMac

struct TaskCollaborationLayoutTests {
    @Test func contentWidthsUseFixedUnits() {
        for ideal in [80.0, 200, 360, 800] {
            let width = WorkCardGrid.width(ideal: ideal)
            #expect(width >= 192 && width <= 792)
            #expect(width.truncatingRemainder(dividingBy: 24) == 0)
        }
    }
    @Test func resizingOnlyChangesPositionsNotCardSizes() {
        let items = [WorkPackingEngine.Item(id: "a", size: CGSize(width: WorkCardGrid.width(ideal: 220), height: 160)),
                     WorkPackingEngine.Item(id: "b", size: CGSize(width: WorkCardGrid.width(ideal: 310), height: 240))]
        let contentWidth = WorkCardGrid.contentWidth(items: items, gap: 8)
        var engine = WorkPackingEngine()
        for viewport in [150.0, 400, 900, 300] {
            engine.update(items: items, width: max(viewport, items.map(\.size.width).max()!), spacing: 12, selectedWorkID: nil, refreshRevision: 0)
            #expect(engine.frames.map(\.size) == items.map(\.size))
            #expect(WorkCardGrid.contentWidth(items: items, gap: 8) == contentWidth)
        }
    }
    @Test func singleItemHasNoArtificialContentWidth() {
        let items = [WorkPackingEngine.Item(id: "a", size: CGSize(width: 240, height: 120))]
        #expect(WorkCardGrid.contentWidth(items: items, gap: 8) == 240)
    }
    @Test func flowEventDecodesOnlyRequiredMetadata() throws {
        let data = Data(#"{"payload":{"message":{"messageId":"m","channelId":"c","senderSessionId":"logical:a","createdAt":"2026-09-08T00:00:00.000Z","body":"ignored"}}}"#.utf8)
        let event = try JSONDecoder().decode(TaskCollaborationFlowEvent.Envelope.self, from: data)
        #expect(event.payload.message.senderSessionId == "logical:a")
    }
}
