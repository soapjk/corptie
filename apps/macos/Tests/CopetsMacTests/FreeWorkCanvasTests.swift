import Testing
import Foundation
@testable import CorptieMac

struct FreeWorkCanvasTests {
    @Test func positionsStayExactAcrossResizeAndAllowOverlap() {
        let items = [WorkPackingEngine.Item(id: "a", size: CGSize(width: 240, height: 120)),
                     WorkPackingEngine.Item(id: "b", size: CGSize(width: 360, height: 200))]
        let positions = ["a": CGPoint(x: 17.25, y: 39.75), "b": CGPoint(x: 17.25, y: 39.75)]
        for width in [200.0, 600, 1000] {
            let frames = FreeWorkCanvasGeometry.frames(items: items, positions: positions, initialWidth: width)
            #expect(frames[0].origin == positions["a"]!)
            #expect(frames[1].origin == positions["b"]!)
            #expect(frames[0].intersects(frames[1]))
        }
    }
    @Test func movesDoNotSnapOrDisplaceOtherCards() {
        let result = FreeWorkCanvasGeometry.moved(CGPoint(x: 20, y: 30), by: CGSize(width: 3.75, height: 9.25))
        #expect(result == CGPoint(x: 23.75, y: 39.25))
    }
    @Test func newCardsDoNotRepositionExistingCards() {
        let items = [WorkPackingEngine.Item(id: "a", size: CGSize(width: 240, height: 120)),
                     WorkPackingEngine.Item(id: "new", size: CGSize(width: 240, height: 120))]
        let frames = FreeWorkCanvasGeometry.frames(items: items, positions: ["a": CGPoint(x: 51, y: 41)], initialWidth: 600)
        #expect(frames[0].origin == CGPoint(x: 51, y: 41))
        #expect(frames[1].minY > frames[0].maxY)
    }
    @Test func positionsRoundTripWithoutRounding() throws {
        let positions = ["work": CGPoint(x: 23.75, y: 39.25)]
        let data = try JSONEncoder().encode(positions)
        #expect(try JSONDecoder().decode([String: CGPoint].self, from: data) == positions)
    }
}
