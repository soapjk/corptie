import Foundation
import Testing
@testable import CorptieMac

@MainActor
struct WorkCanvasDropTests {
    private var scene: [String: CGRect] {
        ["a": CGRect(x: 0, y: 0, width: 120, height: 100),
         "b": CGRect(x: 160, y: 0, width: 140, height: 120),
         "c": CGRect(x: 160, y: 132, width: 140, height: 120),
         "far": CGRect(x: 800, y: 500, width: 240, height: 200)]
    }

    @Test func draggingOnlyMovesGrabbedCardEvenAcrossNeighbours() {
        let controller = WorkCanvasDragController()
        #expect(controller.begin(id: "a", frames: scene))
        for x in [20.25, 80.5, 160.75, 250.125] {
            controller.update(id: "a", translation: CGSize(width: x, height: 0))
            #expect(controller.motion(for: "a").offset.width == CGFloat(x))
            for id in ["b", "c", "far"] { #expect(controller.motion(for: id).offset == .zero) }
        }
        controller.cancel()
        #expect(controller.motion(for: "a").offset == .zero)
    }

    @Test func droppingPinsActiveAndResolvesChainWithoutResizing() {
        var frames = scene
        frames["a"]!.origin = CGPoint(x: 160.75, y: 3.25)
        let result = WorkCanvasDragController.landingFrames(frames, active: "a")
        #expect(result["a"] == frames["a"])
        #expect(result["far"] == frames["far"])
        #expect(result["b"]!.origin == CGPoint(x: 160, y: -128.75))
        #expect(result["c"] == frames["c"])
        let ids = result.keys.sorted()
        for i in ids.indices {
            let a = result[ids[i]]!
            #expect(a.size == frames[ids[i]]!.size)
            for j in ids.indices where j > i {
                let b = result[ids[j]]!
                #expect(a.maxX + 12 <= b.minX || b.maxX + 12 <= a.minX ||
                        a.maxY + 12 <= b.minY || b.maxY + 12 <= a.minY)
            }
        }
    }

    @Test func movingAwayBeforeDroppingLeavesNeighboursUntouched() {
        let controller = WorkCanvasDragController()
        #expect(controller.begin(id: "a", frames: scene))
        controller.update(id: "a", translation: CGSize(width: 160, height: 0))
        controller.update(id: "a", translation: CGSize(width: 20.5, height: 20.25))
        var calls = 0
        controller.finish(id: "a") { result in
            calls += 1
            #expect(result["a"]!.origin == CGPoint(x: 20.5, y: 20.25))
            for id in ["b", "c", "far"] { #expect(result[id] == self.scene[id]) }
        }
        #expect(calls == 1 && controller.activeID == nil)
    }

    @Test func reducedMotionCommitsResolvedPositionsOnce() {
        let controller = WorkCanvasDragController()
        #expect(controller.begin(id: "a", frames: scene, reducedMotion: true))
        controller.update(id: "a", translation: CGSize(width: 160.75, height: 0))
        var calls = 0
        controller.finish(id: "a") { result in
            calls += 1
            #expect(result["a"]!.minX == 160.75)
            #expect(result["b"]!.origin == CGPoint(x: 160, y: -132))
        }
        controller.finish(id: "a") { _ in calls += 1 }
        #expect(calls == 1 && controller.activeID == nil)
    }

    @Test func reportsOneShotDropCost() {
        let frames = Dictionary(uniqueKeysWithValues: (0..<200).map { i in
            (String(i), CGRect(x: 10, y: Double(i) * 172, width: 240, height: 160))
        })
        let start = ContinuousClock.now
        let result = WorkCanvasDragController.landingFrames(frames, active: "199")
        print("One-shot drop layout, 200 cards: \(start.duration(to: .now))")
        #expect(result.count == 200)
    }

    @Test func grazingBottomEdgeMovesOtherCardSlightlyUp() {
        let frames = ["active": CGRect(x: 100, y: 195.25, width: 120, height: 80),
                      "other": CGRect(x: 100, y: 100, width: 120, height: 100)]
        let result = WorkCanvasDragController.landingFrames(frames, active: "active")
        #expect(result["active"] == frames["active"])
        #expect(result["other"] == CGRect(x: 100, y: 83.25, width: 120, height: 100))
        let ids = result.keys.sorted()
        let items = ids.map { WorkPackingEngine.Item(id: $0, size: result[$0]!.size) }
        #expect(FreeWorkCanvasGeometry.frames(items: items, positions: result.mapValues(\.origin), initialWidth: 600)
                == ids.map { result[$0]! })
    }

    @Test func checksAllFourDirectionsAndPreservesFreeCoordinates() {
        let other = CGRect(x: 200, y: 200, width: 100, height: 100)
        let cases: [(CGRect, CGPoint)] = [
            (CGRect(x: 200, y: 295.5, width: 100, height: 100), CGPoint(x: 200, y: 183.5)),
            (CGRect(x: 200, y: 104.5, width: 100, height: 100), CGPoint(x: 200, y: 216.5)),
            (CGRect(x: 295.5, y: 200, width: 100, height: 100), CGPoint(x: 183.5, y: 200)),
            (CGRect(x: 104.5, y: 200, width: 100, height: 100), CGPoint(x: 216.5, y: 200))
        ]
        for (active, expected) in cases {
            let result = WorkCanvasDropGeometry.resolve(["a": active, "b": other], active: "a")
            #expect(result["b"]!.origin == expected)
            #expect(result["a"] == active)
        }
    }

    @Test func blockedUpwardMoveChoosesSideWithoutMovingThirdCard() {
        let frames = ["a": CGRect(x: 100, y: 195, width: 120, height: 80),
                      "b": CGRect(x: 100, y: 100, width: 120, height: 100),
                      "c": CGRect(x: 100, y: 0, width: 120, height: 80)]
        let result = WorkCanvasDropGeometry.resolve(frames, active: "a")
        #expect(result["b"]!.origin == CGPoint(x: -32, y: 100))
        #expect(result["c"] == frames["c"])
        #expect(!WorkCanvasDropGeometry.conflicts(result["b"]!, result["a"]!))
    }

    @Test func denseDropIsDeterministicAndNonoverlapping() {
        var frames: [String: CGRect] = [:]
        for i in 0..<100 {
            let x = Double(i % 10) * 132
            let y = Double(i / 10) * 112
            frames[String(i)] = CGRect(x: x, y: y, width: 120, height: 100)
        }
        frames["active"] = CGRect(x: 230.25, y: 210.75, width: 260, height: 200)
        let result = WorkCanvasDropGeometry.resolve(frames, active: "active")
        #expect(result == WorkCanvasDropGeometry.resolve(frames, active: "active"))
        #expect(result["active"] == frames["active"])
        let ids = result.keys.sorted()
        for i in ids.indices {
            #expect(result[ids[i]]!.size == frames[ids[i]]!.size)
            for j in ids.indices where j > i {
                #expect(!WorkCanvasDropGeometry.conflicts(result[ids[i]]!, result[ids[j]]!))
            }
        }
    }
}
