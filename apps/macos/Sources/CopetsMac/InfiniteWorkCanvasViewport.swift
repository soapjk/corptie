import AppKit
import SwiftUI

/// Camera coordinates are screen points; card coordinates never depend on zoom.
struct WorkCanvasCamera: Equatable {
    var scale: CGFloat = 1
    var translation = CGPoint(x: 10, y: 10)

    static func located(frames: [String: CGRect], viewport: CGSize, selectedID: String?) -> WorkCanvasCamera {
        let valid = frames.filter { $0.value.minX.isFinite && $0.value.minY.isFinite &&
            $0.value.width.isFinite && $0.value.height.isFinite && $0.value.width > 0 && $0.value.height > 0 }
        guard viewport.width.isFinite, viewport.height.isFinite, viewport.width > 20, viewport.height > 20,
              let first = valid.values.first else { return WorkCanvasCamera() }
        let bounds = valid.values.reduce(first) { $0.union($1) }
        let fits = bounds.width <= viewport.width - 20 && bounds.height <= viewport.height - 20
        let target = fits ? bounds : (selectedID.flatMap { valid[$0] } ?? bounds)
        return WorkCanvasCamera(scale: 1, translation: CGPoint(
            x: target.width <= viewport.width - 20 ? viewport.width / 2 - target.midX : 10 - target.minX,
            y: target.height <= viewport.height - 20 ? viewport.height / 2 - target.midY : 10 - target.minY))
    }

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

/// Read only by gesture callbacks. Its identity is stable in the environment;
/// changing zoom must not invalidate every card's body or layout measurement.
@MainActor final class WorkCanvasInteractionTransform {
    var scale: CGFloat = 1
}

@Observable @MainActor
final class WorkCanvasViewportState {
    private(set) var camera = WorkCanvasCamera()
    private(set) var renderScaleMultiplier: CGFloat = 1
    let interactionTransform = WorkCanvasInteractionTransform()
    private var renderScaleUpdate: Task<Void, Never>?
    @ObservationIgnored private(set) var entryPending = true

    func prepareForEntry() { entryPending = true }
    func cancelAutomaticEntry() { entryPending = false }

    func initialize(snapshot: WorkCanvasLayoutSnapshot, viewport: CGSize, ids: [String],
                    selectedID: String?, previousAnchor: String?,
                    commit: ([String: CGRect], String) -> Void) async {
        guard viewport.width > 20, viewport.height > 20, !ids.isEmpty else { return }
        let expectedIDs = Set(ids)
        // Bounded first-layout handshake, never a recurring model-update timer.
        for _ in 0..<32 {
            guard !Task.isCancelled, entryPending else { return }
            let frames = snapshot.frames
            if Set(frames.keys) == expectedIDs, frames.values.allSatisfy({
                $0.width.isFinite && $0.height.isFinite && $0.width > 0 && $0.height > 0
            }) {
                let anchor = [selectedID, previousAnchor, ids.first].compactMap { $0 }
                    .first(where: { frames[$0] != nil })!
                let clustered = WorkCanvasClusterGeometry.resolve(frames, active: anchor,
                    width: max(1, viewport.width - 20), order: ids)
                var transaction = Transaction(animation: nil)
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    commit(clustered, anchor)
                    locate(frames: clustered, viewport: viewport, selectedID: selectedID)
                }
                return
            }
            do { try await Task.sleep(for: .milliseconds(16)) } catch { return }
        }
    }

    func locate(frames: [String: CGRect], viewport: CGSize, selectedID: String?) {
        reset()
        camera = WorkCanvasCamera.located(frames: frames, viewport: viewport, selectedID: selectedID)
    }

    func zoom(by factor: CGFloat, at point: CGPoint) {
        cancelAutomaticEntry()
        var next = camera
        next.zoom(by: factor, at: point)
        guard next != camera else { return }
        interactionTransform.scale = next.scale
        camera = next
        settleRendering(at: next.scale)
    }

    func pan(by delta: CGSize) {
        cancelAutomaticEntry()
        camera.translation.x += delta.width
        camera.translation.y += delta.height
    }

    func reset() {
        cancelAutomaticEntry()
        renderScaleUpdate?.cancel()
        renderScaleUpdate = nil
        renderScaleMultiplier = 1
        interactionTransform.scale = 1
        camera = WorkCanvasCamera()
    }

    private func settleRendering(at scale: CGFloat) {
        renderScaleUpdate?.cancel()
        let multiplier = max(1, scale)
        if multiplier == 1 {
            renderScaleUpdate = nil
            renderScaleMultiplier = 1
            return
        }
        renderScaleUpdate = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            self?.renderScaleMultiplier = multiplier
        }
    }
}
private struct WorkCanvasTransformKey: EnvironmentKey {
    static let defaultValue: WorkCanvasInteractionTransform? = nil
}
extension EnvironmentValues {
    var workCanvasInteractionTransform: WorkCanvasInteractionTransform? {
        get { self[WorkCanvasTransformKey.self] }
        set { self[WorkCanvasTransformKey.self] = newValue }
    }
}

/// Only this small view observes camera movement. No packing, persistence,
/// transcript projection or bitmap rasterization is performed on wheel events.
struct InfiniteWorkCanvasViewport<Content: View>: View {
    @Environment(\.displayScale) private var displayScale
    let origin: CGPoint
    let isActive: Bool
    let cardDragging: Bool
    var layoutSnapshot: WorkCanvasLayoutSnapshot? = nil
    var selectedCardID: String? = nil
    @ViewBuilder let content: Content
    @State private var viewportState: WorkCanvasViewportState
    @GestureState private var pan = CGSize.zero

    init(origin: CGPoint, isActive: Bool, cardDragging: Bool,
         viewportState: WorkCanvasViewportState = WorkCanvasViewportState(),
         layoutSnapshot: WorkCanvasLayoutSnapshot? = nil, selectedCardID: String? = nil,
         @ViewBuilder content: () -> Content) {
        self.origin = origin
        self.isActive = isActive
        self.cardDragging = cardDragging
        self.layoutSnapshot = layoutSnapshot
        self.selectedCardID = selectedCardID
        self.content = content()
        _viewportState = State(initialValue: viewportState)
    }

    private var camera: WorkCanvasCamera { viewportState.camera }

    var body: some View {
        GeometryReader { viewport in
            ZStack(alignment: .topLeading) {
                Color.clear.contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 3, coordinateSpace: .global)
                        .updating($pan) { value, state, _ in state = value.translation }
                        .onChanged { _ in viewportState.cancelAutomaticEntry() }
                        .onEnded { value in
                            viewportState.pan(by: value.translation)
                        })
                    .accessibilityLabel("Work 画布，滚轮缩放，拖动空白处平移")
                content
                    .environment(\.workCanvasInteractionTransform, viewportState.interactionTransform)
                    // Keep wheel updates compositor-only, then redraw leaf
                    // content once at the settled zoom's pixel density.
                    .environment(\.displayScale, displayScale * viewportState.renderScaleMultiplier)
                    .fixedSize()
                    .scaleEffect(camera.scale, anchor: .topLeading)
                    .offset(x: camera.translation.x + pan.width + origin.x * camera.scale,
                            y: camera.translation.y + pan.height + origin.y * camera.scale)
            }
            .frame(width: viewport.size.width, height: viewport.size.height, alignment: .topLeading)
            .contentShape(Rectangle())
            .clipped()
            .background(CanvasWheelInput(enabled: isActive && !cardDragging && pan == .zero) { point, delta in
                viewportState.zoom(by: exp(delta * 0.008), at: point)
            })
            // Resolve transformed anchors in screen space. The drawing surface
            // stays viewport-sized even when world coordinates are far apart.
            .overlayPreferenceValue(TaskCardAnchors.self) { anchors in
                TaskCollaborationOverlay(anchors: anchors, active: isActive).clipped()
            }
            .overlay(alignment: .bottomTrailing) {
                Button("\(Int((camera.scale * 100).rounded()))%") {
                    if let layoutSnapshot {
                        viewportState.locate(frames: layoutSnapshot.frames, viewport: viewport.size,
                                             selectedID: selectedCardID)
                    } else { viewportState.reset() }
                }
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
