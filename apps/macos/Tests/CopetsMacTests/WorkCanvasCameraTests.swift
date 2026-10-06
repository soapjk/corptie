import Foundation
import Testing
@testable import CorptieMac

struct WorkCanvasCameraTests {
    @MainActor @Test func entryWaitsForVisibleLayoutThenClustersAndLocatesOnlyOnce() async throws {
        let state = WorkCanvasViewportState(), snapshot = WorkCanvasLayoutSnapshot()
        let frames = ["a": CGRect(x: -1000, y: -2000, width: 240, height: 100),
                      "selected": CGRect(x: 5000.25, y: 9000.75, width: 240, height: 100)]
        var commits = 0
        let entry = Task { @MainActor in
            await state.initialize(snapshot: snapshot, viewport: CGSize(width: 800, height: 600),
                ids: ["a", "selected"], selectedID: "selected", previousAnchor: "a") { clustered, anchor in
                    commits += 1
                    #expect(anchor == "selected")
                    #expect(clustered["selected"] == frames["selected"])
                    #expect(clustered["a"] != frames["a"])
                    snapshot.frames = clustered
                }
        }
        try await Task.sleep(for: .milliseconds(25))
        #expect(commits == 0)
        snapshot.frames = frames
        await entry.value
        #expect(commits == 1)
        let camera = state.camera
        // Changed content, selection and layout after entry cannot steal the camera.
        snapshot.frames = ["a": CGRect(x: 20_000, y: 20_000, width: 240, height: 100)]
        await state.initialize(snapshot: snapshot, viewport: CGSize(width: 800, height: 600),
            ids: ["a"], selectedID: "a", previousAnchor: nil) { _, _ in commits += 1 }
        #expect(commits == 1)
        #expect(state.camera == camera)
    }

    @MainActor @Test func interactionDuringFirstLayoutCancelsCompactionAndCameraJump() async throws {
        let state = WorkCanvasViewportState(), snapshot = WorkCanvasLayoutSnapshot()
        var commits = 0
        let entry = Task { @MainActor in
            await state.initialize(snapshot: snapshot, viewport: CGSize(width: 800, height: 600),
                ids: ["a"], selectedID: nil, previousAnchor: nil) { _, _ in commits += 1 }
        }
        try await Task.sleep(for: .milliseconds(20))
        state.pan(by: CGSize(width: 12, height: -10))
        let camera = state.camera
        snapshot.frames = ["a": CGRect(x: 20_000, y: 20_000, width: 240, height: 100)]
        await entry.value
        #expect(commits == 0)
        #expect(state.camera == camera)
    }

    @Test func entryCentersCompactBoundsAtReadableScaleIncludingNegativeCoordinates() {
        let frames = ["a": CGRect(x: -700, y: -800, width: 240, height: 120),
                      "b": CGRect(x: -448, y: -800, width: 240, height: 120)]
        let camera = WorkCanvasCamera.located(frames: frames, viewport: CGSize(width: 800, height: 600), selectedID: nil)
        #expect(camera.scale == 1)
        let bounds = frames.values.reduce(CGRect.null) { $0.union($1) }
        #expect(bounds.midX + camera.translation.x == 400)
        #expect(bounds.midY + camera.translation.y == 300)
    }

    @Test func largeInventoryPrioritizesSelectedWorkWithoutShrinkingText() {
        let frames = ["a": CGRect(x: 1200, y: 3000, width: 240, height: 120),
                      "selected": CGRect(x: 1500, y: 9000, width: 300, height: 900)]
        let camera = WorkCanvasCamera.located(frames: frames, viewport: CGSize(width: 800, height: 600), selectedID: "selected")
        #expect(camera.scale == 1)
        #expect(frames["selected"]!.midX + camera.translation.x == 400)
        #expect(frames["selected"]!.minY + camera.translation.y == 10)
        let start = WorkCanvasCamera.located(frames: frames, viewport: CGSize(width: 800, height: 600), selectedID: nil)
        #expect(frames["a"]!.minY + start.translation.y == 10)
    }

    @MainActor @Test func userInteractionCancelsPendingEntryAndLocateIsOneShot() {
        let state = WorkCanvasViewportState()
        #expect(state.entryPending)
        state.pan(by: CGSize(width: 1, height: 0))
        #expect(!state.entryPending)
        state.prepareForEntry()
        state.zoom(by: 1.1, at: .zero)
        #expect(!state.entryPending)
        state.prepareForEntry()
        state.cancelAutomaticEntry()
        #expect(!state.entryPending)
        state.prepareForEntry()
        state.locate(frames: ["a": CGRect(x: 1200, y: 4000, width: 240, height: 100)],
                     viewport: CGSize(width: 800, height: 600), selectedID: nil)
        #expect(!state.entryPending)
        #expect(state.camera.scale == 1)
        #expect(state.interactionTransform.scale == 1)
    }
    @MainActor
    @Test func settledZoomRaisesRenderResolutionWithoutOversamplingZoomedOutContent() async throws {
        let state = WorkCanvasViewportState()
        state.zoom(by: 2, at: .zero)
        #expect(state.renderScaleMultiplier == 1)
        // The 120 ms debounce runs on the main actor; loaded test runs may
        // resume this assertion later than a fixed 180 ms sleep.
        for _ in 0..<40 {
            if state.renderScaleMultiplier == 2 { break }
            try await Task.sleep(for: .milliseconds(25))
        }
        #expect(state.renderScaleMultiplier == 2)

        state.zoom(by: 0.25, at: .zero)
        #expect(state.camera.scale == 0.5)
        #expect(state.renderScaleMultiplier == 1)
    }

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
