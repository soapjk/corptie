import Foundation
import Testing
@testable import CorptieMac

struct WorkCanvasCameraTests {
    @Test func zoomKeepsWorldPointUnderPointerIncludingLimits() {
        var camera = WorkCanvasCamera()
        camera.translation = CGPoint(x: -1200, y: 480)
        let pointer = CGPoint(x: 340, y: 270)
        let expected = camera.worldPoint(at: pointer)
        for factor in [1.3, 0.7, 100, 0.001, 2] {
            camera.zoom(by: factor, at: pointer)
            let actual = camera.worldPoint(at: pointer)
            #expect(abs(actual.x - expected.x) < 0.000001)
            #expect(abs(actual.y - expected.y) < 0.000001)
            #expect(camera.scale >= 0.2 && camera.scale <= 3)
        }
    }

    @Test func invalidWheelInputDoesNotCorruptCamera() {
        var camera = WorkCanvasCamera()
        let original = camera
        camera.zoom(by: .nan, at: .zero)
        camera.zoom(by: .infinity, at: .zero)
        camera.zoom(by: -1, at: .zero)
        #expect(camera == original)
    }

    @Test func scaledDragHasSameScreenDistanceAndAllowsNegativeWorldPositions() throws {
        for scale in [0.2, 0.5, 1, 2, 3] {
            let delta = WorkCanvasCamera.worldDelta(CGSize(width: -120, height: -60), scale: scale)
            #expect(abs(delta.width * scale + 120) < 0.000001)
            let position = FreeWorkCanvasGeometry.moved(.zero, by: delta)
            #expect(position.x < 0 && position.y < 0)
            let data = try JSONEncoder().encode(["a": position])
            let saved = try JSONDecoder().decode([String: CGPoint].self, from: data)
            let items = [WorkPackingEngine.Item(id: "a", size: CGSize(width: 240, height: 120))]
            #expect(FreeWorkCanvasGeometry.frames(items: items, positions: saved, initialWidth: 600)[0].origin == position)
        }
    }

    @Test func negativeLayoutOriginDoesNotMoveWorldContentOnScreen() {
        let camera = WorkCanvasCamera(scale: 0.5, translation: CGPoint(x: 400, y: 300))
        let world = CGPoint(x: -320, y: -170)
        for origin in [CGPoint.zero, CGPoint(x: -500, y: -1000)] {
            let local = CGPoint(x: world.x - origin.x, y: world.y - origin.y)
            let screen = CGPoint(x: (local.x + origin.x) * camera.scale + camera.translation.x,
                                 y: (local.y + origin.y) * camera.scale + camera.translation.y)
            #expect(camera.worldPoint(at: screen) == world)
        }
    }
}
