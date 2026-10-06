import Foundation
import Testing
@testable import CorptieMac

struct WorkCanvasClusterTests {
    @Test func realWideWorkCardsFormMultipleColumnsEvenInNarrowViewport() {
        for cardWidth in [CGFloat(576), 792] {
            for count in [2, 3, 12] {
                let frames = Dictionary(uniqueKeysWithValues: (0..<count).map { i in
                    (String(i), CGRect(x: 0, y: CGFloat(i) * 1000, width: cardWidth, height: 400))
                })
                let narrow = WorkCanvasClusterGeometry.resolve(frames, active: "0", width: 320)
                for viewportWidth in [CGFloat(320), 600, 1600] {
                    let result = WorkCanvasClusterGeometry.resolve(frames, active: "0", width: viewportWidth)
                    #expect(result == narrow)
                    check(result, original: frames, active: "0")
                    #expect(Set(result.values.map(\.minX)).count >= 2)
                    let bounds = result.values.reduce(CGRect.null) { $0.union($1) }
                    #expect(bounds.width > cardWidth)
                    #expect(bounds.height < CGFloat(count) * 400)
                    #expect(result.values.contains { $0.minY == frames["0"]!.minY && $0.minX != frames["0"]!.minX })
                }
            }
        }
    }

    @Test func tallWidePairStaysAdjacentRatherThanSeparatingAcrossOversizedBin() {
        let frames = ["pin": CGRect(x: -777.123, y: 300.43, width: 792, height: 20_000),
                      "other": CGRect(x: 0, y: 30_000, width: 792, height: 20_000)]
        let result = WorkCanvasClusterGeometry.resolve(frames, active: "pin", width: 320)
        check(result, original: frames, active: "pin")
        #expect(result["other"]!.minY == frames["pin"]!.minY)
        #expect(abs(abs(result["other"]!.minX - frames["pin"]!.minX) - 804) < 0.000001)
    }

    private func scene(_ count: Int) -> [String: CGRect] {
        Dictionary(uniqueKeysWithValues: (0..<count).map { i -> (String, CGRect) in
            let x = CGFloat(-4000 + i * 700), y = CGFloat(6000 + i * 1200)
            let width = CGFloat(192 + i % 4 * 24), height = CGFloat(80 + i % 7 * 31)
            return (String(i), CGRect(x: x, y: y, width: width, height: height))
        })
    }

    private func check(_ result: [String: CGRect], original: [String: CGRect], active: String) {
        #expect(result[active] == original[active])
        #expect(Set(result.keys) == Set(original.keys))
        let ids = result.keys.sorted()
        for i in ids.indices {
            #expect(result[ids[i]]!.size == original[ids[i]]!.size)
            for j in ids.indices where j > i {
                #expect(!WorkCanvasDropGeometry.conflicts(result[ids[i]]!, result[ids[j]]!))
            }
        }
    }

    @Test func everyCardClustersAroundExactFractionalNegativeAnchor() {
        var frames = scene(20)
        frames["7"]!.origin = CGPoint(x: -777.125, y: -333.75)
        for width in [200.0, 420, 800, 1400] {
            let result = WorkCanvasClusterGeometry.resolve(frames, active: "7", width: width)
            check(result, original: frames, active: "7")
            #expect(result["19"] != frames["19"])
            let bounds = result.values.reduce(CGRect.null) { $0.union($1) }
            #expect(bounds.width <= WorkCanvasClusterGeometry.packingWidth(frames, active: "7") + 0.001)
            #expect(bounds.height < 20 * 300)
            #expect(result == WorkCanvasClusterGeometry.resolve(frames, active: "7", width: width))
            #expect(result == WorkCanvasClusterGeometry.resolve(result, active: "7", width: width))
            let ids = result.keys.sorted()
            let items = ids.map { WorkPackingEngine.Item(id: $0, size: result[$0]!.size) }
            #expect(FreeWorkCanvasGeometry.frames(items: items, positions: result.mapValues(\.origin), initialWidth: width)
                    == ids.map { result[$0]! })
        }
    }

    @Test func nativePackingFillsSpaceBesidePinnedCardBeforeGrowingDownward() {
        let frames = ["pin": CGRect(x: 500.25, y: 800.75, width: 192, height: 300),
                      "left": CGRect(x: -900, y: -900, width: 192, height: 100),
                      "right": CGRect(x: 9000, y: 9000, width: 192, height: 100)]
        let result = WorkCanvasClusterGeometry.resolve(frames, active: "pin", width: 800,
                                                       order: ["left", "right", "pin"])
        check(result, original: frames, active: "pin")
        #expect(result["left"]!.minY == frames["pin"]!.minY)
        #expect(result["right"]!.maxY <= frames["pin"]!.maxY)
    }

    @Test func equallyCompactOrientationPrefersLessMovement() {
        let frames = ["pin": CGRect(x: 300, y: 0, width: 192, height: 300),
                      "other": CGRect(x: 720, y: 0, width: 192, height: 100)]
        let result = WorkCanvasClusterGeometry.resolve(frames, active: "pin", width: 800)
        #expect(result["other"]!.minX > frames["pin"]!.maxX)
        check(result, original: frames, active: "pin")
    }

    @Test func nonBinaryDragCoordinatesReplayWithoutDriftingPinnedCard() {
        for point in [CGPoint(x: -777.123, y: -333.777), CGPoint(x: 1234.12, y: 5678.43),
                      CGPoint(x: 100 / 3.0, y: -200 / 7.0)] {
            var frames = scene(20)
            frames["7"]!.origin = point
            let result = WorkCanvasClusterGeometry.resolve(frames, active: "7", width: 800)
            #expect(result["7"] == frames["7"])
            let ids = result.keys.sorted()
            let items = ids.map { WorkPackingEngine.Item(id: $0, size: result[$0]!.size) }
            #expect(FreeWorkCanvasGeometry.frames(items: items, positions: result.mapValues(\.origin), initialWidth: 800)
                    == ids.map { result[$0]! })
        }
    }

    @Test func orderIsDeterministicAndHasPriorityWithoutDictionaryIterationDependence() {
        let frames = scene(12)
        let reversed = Dictionary(uniqueKeysWithValues: frames.sorted { $0.key > $1.key })
        let order = (0..<12).map(String.init)
        let result = WorkCanvasClusterGeometry.resolve(frames, active: "5", width: 700, order: order)
        #expect(result == WorkCanvasClusterGeometry.resolve(reversed, active: "5", width: 700, order: order))
        #expect(result != WorkCanvasClusterGeometry.resolve(frames, active: "5", width: 700, order: order.reversed()))
        check(result, original: frames, active: "5")
    }

    @Test func extremeInventoryHasBoundedNonoverlappingFallback() {
        let frames = scene(1025)
        let result = WorkCanvasClusterGeometry.resolve(frames, active: "100", width: 200)
        #expect(result.count == 1025)
        #expect(result["100"] == frames["100"])
        let rows = Dictionary(grouping: result.filter { $0.key != "100" }.values, by: \.minY)
            .sorted { $0.key < $1.key }
        var bottom = frames["100"]!.maxY
        for row in rows {
            #expect(row.key >= bottom + 12)
            let cells = row.value.sorted { $0.minX < $1.minX }
            for i in 1..<cells.count { #expect(cells[i].minX >= cells[i - 1].maxX + 12) }
            bottom = cells.map(\.maxY).max()!
        }
    }

    @Test func fastShelfFallbackStillUsesMultipleColumnsAndPreservesAnchor() {
        let frames = scene(300)
        let result = WorkCanvasClusterGeometry.resolve(frames, active: "100", width: 1000)
        #expect(result["100"] == frames["100"])
        #expect(Set(result.values.map(\.minX)).count > 1)
        check(result, original: frames, active: "100")
    }

    @Test func invalidInputsAndMissingAnchorCannotCorruptCoordinates() {
        let frames = scene(3)
        #expect(WorkCanvasClusterGeometry.resolve(frames, active: "missing", width: 800) == frames)
        let result = WorkCanvasClusterGeometry.resolve(frames, active: "1", width: .infinity)
        check(result, original: frames, active: "1")
        #expect(WorkCanvasClusterGeometry.resolve([:], active: "missing", width: 800).isEmpty)
    }

    @Test func reportsOneShotPackingBudgetForTwentyHundredAndTwoHundredCards() {
        for count in [20, 100, 200] {
            let frames = scene(count)
            var samples: [Double] = []
            for _ in 0..<12 {
                let start = ProcessInfo.processInfo.systemUptime
                let result = WorkCanvasClusterGeometry.resolve(frames, active: "7", width: 1000)
                samples.append((ProcessInfo.processInfo.systemUptime - start) * 1000)
                #expect(result.count == count)
            }
            samples.sort()
            print("WORK_CLUSTER count=\(count) p95_ms=\(samples[11])")
            #expect(samples[11] < 16)
            check(WorkCanvasClusterGeometry.resolve(frames, active: "7", width: 1000), original: frames, active: "7")
        }
    }
}
