import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

@MainActor
struct WorkCanvasRenderingTests {
    @Test func nativeViewportZoomDoesNotRebuildCardsOrRewriteWorldFrames() async throws {
        let state = WorkCanvasViewportState()
        let snapshot = WorkCanvasLayoutSnapshot()
        let probe = RenderProbe()
        var positions: [String: CGPoint] = [:]
        for index in 0..<20 {
            positions[String(index)] = CGPoint(x: CGFloat(index % 4) * 280, y: CGFloat(index / 4) * 160)
        }
        let view = InfiniteWorkCanvasViewport(origin: .zero, isActive: false, cardDragging: false,
                                             viewportState: state) {
            FreeWorkCanvasLayout(positions: positions, viewport: CGSize(width: 800, height: 600), snapshot: snapshot) {
                ForEach(0..<20, id: \.self) { id in
                    ProbeCard(probe: probe).layoutValue(key: WorkPackingID.self, value: String(id))
                }
            }
        }.environmentObject(BackendClient.shared)
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 800, height: 600),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.contentView = nil; window.close() }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        host.layoutSubtreeIfNeeded()
        let initial = snapshot.frames
        #expect(initial.count == 20)
        let initialBuilds = probe.builds
        let start = ContinuousClock.now
        for step in 0..<120 {
            state.zoom(by: step < 60 ? 0.94 : 1.06, at: CGPoint(x: 300, y: 240))
            state.pan(by: CGSize(width: 0.25, height: -0.5))
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(2))
            #expect(snapshot.frames == initial)
            #expect(state.interactionTransform.scale == state.camera.scale)
        }
        print("Native canvas 120 zoom/pan updates: \(start.duration(to: .now)); card builds: \(initialBuilds) -> \(probe.builds)")
        #expect(probe.builds == initialBuilds)
        state.reset()
        #expect(state.interactionTransform.scale == 1)
    }

    @Test func renderingCannotPersistOrFeedBackAnchorCoordinates() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/CopetsMac/ConsoleCardWorkspace.swift"), encoding: .utf8)
        #expect(!source.contains("onPreferenceChange(WorkCanvasOrigins"))
        #expect(!source.contains("@State private var canvasFrames"))
        #expect(source.contains("frames: layoutSnapshot.frames"))
        #expect(source.components(separatedBy: "saveCanvasPositions()").count == 3) // declaration + drop only
    }
}

@MainActor private final class RenderProbe { var builds = 0 }
private struct ProbeCard: View {
    let probe: RenderProbe
    @Environment(\.workCanvasInteractionTransform) private var transform
    var body: some View {
        let _ = probe.builds += 1
        HStack {
            ConsoleWorkTitle(title: "Task sample", isWorking: true)
            ConsoleScheduledWakeIcon()
        }.frame(width: 240, height: 100)
            .gesture(DragGesture().onChanged { value in
                _ = WorkCanvasCamera.worldDelta(value.translation, scale: transform?.scale ?? 1)
            })
    }
}
