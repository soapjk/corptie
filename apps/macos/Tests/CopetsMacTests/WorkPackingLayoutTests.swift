import Foundation
import Testing
@testable import CorptieMac

struct WorkPackingLayoutTests {
    private func item(_ id: String, _ width: CGFloat, _ height: CGFloat) -> WorkPackingEngine.Item {
        .init(id: id, size: CGSize(width: width, height: height))
    }

    @Test func fillsTheHoleUnderAShortCardWithoutRotation() {
        let items = [item("a", 200, 200), item("b", 100, 80), item("c", 100, 100)]
        var engine = WorkPackingEngine()
        engine.update(items: items, width: 320, spacing: 10, selectedWorkID: nil, refreshRevision: 0)
        #expect(engine.frames[2].minY == 90)
        #expect(engine.height == 200) // Row flow would need 310 points.
        #expect(engine.frames.map(\.size) == items.map(\.size))
        #expect(engine.frames[0].maxX + 10 <= engine.frames[1].minX)
    }

    @Test func selectionAndPaintOnlyUpdatesDoNotRepack() {
        let items = [item("a", 120, 100), item("b", 90, 80)]
        var engine = WorkPackingEngine()
        engine.update(items: items, width: 320, spacing: 12, selectedWorkID: nil, refreshRevision: 0)
        let before = engine.frames
        for _ in 0..<100 {
            engine.update(items: items, width: 320, spacing: 12, selectedWorkID: "b", refreshRevision: 0)
        }
        #expect(engine.packingCount == 1)
        #expect(engine.frames == before)
    }

    @Test func removingCardsCompactsEvenTheActiveWorkWithoutRefresh() {
        let a = item("a", 200, 200), b = item("b", 100, 80)
        var engine = WorkPackingEngine()
        engine.update(items: [a, b], width: 320, spacing: 10, selectedWorkID: "b", refreshRevision: 0)
        let pinned = engine.frames[1]
        engine.update(items: [b], width: 320, spacing: 10, selectedWorkID: "b", refreshRevision: 0)
        #expect(engine.frames[0] != pinned)
        #expect(engine.frames[0].origin == .zero)
        engine.update(items: [b], width: 320, spacing: 10, selectedWorkID: "b", refreshRevision: 1)
        #expect(engine.frames[0].origin == .zero)
    }

    @Test func sizeChangesAndNarrowWidthsNeverOverlap() {
        var engine = WorkPackingEngine()
        let items: [WorkPackingEngine.Item] = (0..<50).map { (index: Int) in
            let width = CGFloat(40 + (index * 17) % 180)
            let height = CGFloat(30 + (index * 31) % 200)
            return item(String(index), width, height)
        }
        for width: CGFloat in [700, 320, 240] {
            engine.update(items: items, width: width, spacing: 12, selectedWorkID: "3", refreshRevision: 0)
            #expect(engine.frames.count == items.count)
            for i in engine.frames.indices {
                #expect(engine.frames[i].maxX <= width)
                for j in engine.frames.indices where j > i {
                    #expect(!engine.frames[i].intersects(engine.frames[j]))
                }
            }
        }
    }

    @Test func emptyAndLargeInventoriesKeepAllItems() {
        var engine = WorkPackingEngine()
        engine.update(items: [], width: 320, spacing: 12, selectedWorkID: nil, refreshRevision: 0)
        #expect(engine.height == 0)
        let items = (0..<1025).map { item("\($0)", 80, 40) }
        engine.update(items: items, width: 320, spacing: 12, selectedWorkID: nil, refreshRevision: 0)
        #expect(engine.frames.count == 1025)
        #expect(engine.frames.last?.minY == CGFloat(1024 * 52))
    }

    @Test func reportsSyntheticPackingCostAndCacheCost() {
        for count in [20, 200, 1000] {
            let items: [WorkPackingEngine.Item] = (0..<count).map { (index: Int) in
                let width = CGFloat(60 + (index * 37) % 240)
                let height = CGFloat(40 + (index * 29) % 240)
                return item(String(index), width, height)
            }
            var engine = WorkPackingEngine()
            let start = ContinuousClock.now
            engine.update(items: items, width: 800, spacing: 12, selectedWorkID: nil, refreshRevision: 0)
            let packed = start.duration(to: .now)
            let cachedStart = ContinuousClock.now
            for _ in 0..<100 {
                engine.update(items: items, width: 800, spacing: 12, selectedWorkID: nil, refreshRevision: 0)
            }
            print("Work packing: \(count) cards, native=\(packed), 100 cache hits=\(cachedStart.duration(to: .now))")
            #expect(engine.packingCount == 1)
            #expect(engine.frames.count == count)
        }
    }
}
