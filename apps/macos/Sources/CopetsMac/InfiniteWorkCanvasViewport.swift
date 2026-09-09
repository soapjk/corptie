import AppKit
import SwiftUI

/// Camera coordinates are screen points; card coordinates never depend on zoom.
struct WorkCanvasCamera: Equatable {
    var scale: CGFloat = 1
    var translation = CGPoint(x: 10, y: 10)

    func worldPoint(at screen: CGPoint) -> CGPoint {
        CGPoint(x: (screen.x - translation.x) / scale, y: (screen.y - translation.y) / scale)
    }

    mutating func zoom(by factor: CGFloat, at pointer: CGPoint) {
        guard factor.isFinite, factor > 0, pointer.x.isFinite, pointer.y.isFinite else { return }
        let world = worldPoint(at: pointer)
        scale = min(3, max(0.2, scale * factor))
        translation = CGPoint(x: pointer.x - world.x * scale, y: pointer.y - world.y * scale)
    }

    static func worldDelta(_ screen: CGSize, scale: CGFloat) -> CGSize {
        CGSize(width: screen.width / scale, height: screen.height / scale)
    }
}

private struct WorkCanvasScaleKey: EnvironmentKey {
    static let defaultValue: CGFloat = 1
}
extension EnvironmentValues {
    var workCanvasScale: CGFloat {
        get { self[WorkCanvasScaleKey.self] }
        set { self[WorkCanvasScaleKey.self] = newValue }
    }
}

/// Only this small view observes camera movement. No packing, persistence,
/// transcript projection or bitmap rasterization is performed on wheel events.
struct InfiniteWorkCanvasViewport<Content: View>: View {
    let origin: CGPoint
    let isActive: Bool
    let cardDragging: Bool
    @ViewBuilder let content: Content
    @State private var camera = WorkCanvasCamera()
    @GestureState private var pan = CGSize.zero

    var body: some View {
        GeometryReader { viewport in
            ZStack(alignment: .topLeading) {
                Color.clear.contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 3, coordinateSpace: .global)
                        .updating($pan) { value, state, _ in state = value.translation }
                        .onEnded { value in
                            camera.translation.x += value.translation.width
                            camera.translation.y += value.translation.height
                        })
                    .accessibilityLabel("Work 画布，滚轮缩放，拖动空白处平移")
                content
                    .environment(\.workCanvasScale, camera.scale)
                    .fixedSize()
                    .scaleEffect(camera.scale, anchor: .topLeading)
                    .offset(x: camera.translation.x + pan.width + origin.x * camera.scale,
                            y: camera.translation.y + pan.height + origin.y * camera.scale)
            }
            .frame(width: viewport.size.width, height: viewport.size.height, alignment: .topLeading)
            .contentShape(Rectangle())
            .clipped()
            .background(CanvasWheelInput(enabled: isActive && !cardDragging && pan == .zero) { point, delta in
                camera.zoom(by: exp(delta * 0.008), at: point)
            })
            // Resolve transformed anchors in screen space. The drawing surface
            // stays viewport-sized even when world coordinates are far apart.
            .overlayPreferenceValue(TaskCardAnchors.self) { anchors in
                TaskCollaborationOverlay(anchors: anchors, active: isActive).clipped()
            }
            .overlay(alignment: .bottomTrailing) {
                Button("\(Int((camera.scale * 100).rounded()))%") { camera = WorkCanvasCamera() }
                    .font(.caption2.monospacedDigit()).buttonStyle(.bordered).controlSize(.mini)
                    .help("重置画布位置与缩放").padding(8)
            }
        }
    }
}

private struct CanvasWheelInput: NSViewRepresentable {
    var enabled: Bool
    var scroll: (CGPoint, CGFloat) -> Void
    func makeNSView(context: Context) -> WheelView { WheelView() }
    func updateNSView(_ view: WheelView, context: Context) {
        view.enabled = enabled
        view.scroll = scroll
    }
    static func dismantleNSView(_ view: WheelView, coordinator: ()) { view.stopMonitoring() }

    final class WheelView: NSView {
        var enabled = false
        var scroll: ((CGPoint, CGFloat) -> Void)?
        private var monitor: Any?
        override var isFlipped: Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stopMonitoring()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                guard let self, self.enabled, !self.isHiddenOrHasHiddenAncestor,
                      event.window === self.window,
                      self.visibleRect.contains(self.convert(event.locationInWindow, from: nil)) else { return event }
                // A wheel gesture belongs to the canvas, never its enclosing scroll view.
                guard event.momentumPhase.isEmpty else { return nil }
                let delta = event.scrollingDeltaY * (event.hasPreciseScrollingDeltas ? 1 : 12)
                if delta.isFinite, delta != 0 {
                    self.scroll?(self.convert(event.locationInWindow, from: nil), max(-80, min(80, delta)))
                }
                return nil
            }
        }
        func stopMonitoring() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }
    }
}
