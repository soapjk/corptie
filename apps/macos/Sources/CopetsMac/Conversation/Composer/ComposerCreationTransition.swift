import AppKit
import SwiftUI
import Observation

/// One-shot cross-host handoff. No resize observer, display link or retained page snapshot.
@MainActor @Observable
final class ComposerCreationTransition {
    static let shared = ComposerCreationTransition()
    var concealedSessionID: String?
    @ObservationIgnored weak var source: NSView?
    @ObservationIgnored weak var title: NSView?
    @ObservationIgnored weak var footer: NSView?
    @ObservationIgnored private var overlays: [NSImageView] = []
    @ObservationIgnored private weak var root: NSView?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var animating = false

    func begin(sessionID: String) {
        cancel()
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,
              let source, let window = source.window, let root = window.contentView,
              let image = snapshot(source, in: root) else { return }
        self.root = root
        overlays = [image]
        for decoration in [title, footer].compactMap({ $0 }) {
            if let view = snapshot(decoration, in: root) { overlays.append(view) }
        }
        for view in overlays { root.addSubview(view, positioned: .above, relativeTo: nil) }
        concealedSessionID = sessionID
        let token = generation
        // A failed/cancelled mount cannot leave an invisible input or snapshot behind.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, self.generation == token else { return }
            self.cancel()
        }
    }

    func destinationReady(_ view: NSView, sessionID: String) {
        guard concealedSessionID == sessionID, !animating else { return }
        animating = true
        let token = generation
        DispatchQueue.main.async { [weak self, weak view] in
            guard let self, let view, self.generation == token,
                  self.concealedSessionID == sessionID, let root = self.root,
                  view.window === root.window, let image = self.overlays.first else { return }
            root.layoutSubtreeIfNeeded()
            let target = view.convert(view.bounds, to: root)
            guard target.width > 0, target.height > 0 else { self.cancel(); return }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.23
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                image.animator().frame = target
                for decoration in self.overlays.dropFirst() { decoration.animator().alphaValue = 0 }
            } completionHandler: { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.generation == token else { return }
                    self.cancel()
                }
            }
        }
    }

    func cancel(sessionID: String? = nil) {
        if let sessionID, concealedSessionID != sessionID { return }
        generation += 1
        animating = false
        overlays.forEach { $0.layer?.removeAllAnimations(); $0.removeFromSuperview() }
        overlays.removeAll()
        root = nil
        concealedSessionID = nil
    }

    private func snapshot(_ view: NSView, in root: NSView) -> NSImageView? {
        let rect = view.convert(view.bounds, to: root)
        guard rect.width > 0, rect.height > 0,
              let bitmap = root.bitmapImageRepForCachingDisplay(in: rect) else { return nil }
        root.cacheDisplay(in: rect, to: bitmap)
        let image = NSImage(size: rect.size); image.addRepresentation(bitmap)
        let overlay = PassThroughImage(frame: rect)
        overlay.image = image; overlay.imageScaling = .scaleAxesIndependently
        overlay.wantsLayer = true
        return overlay
    }
    private final class PassThroughImage: NSImageView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

struct ComposerTransitionAnchor: NSViewRepresentable {
    let sessionID: String?
    var decoration: String? = nil
    func makeNSView(context: Context) -> Anchor { Anchor() }
    func updateNSView(_ view: Anchor, context: Context) {
        view.sessionID = sessionID
        if let sessionID {
            if view.window != nil { ComposerCreationTransition.shared.destinationReady(view, sessionID: sessionID) }
        } else if decoration == "title" { ComposerCreationTransition.shared.title = view }
        else if decoration == "footer" { ComposerCreationTransition.shared.footer = view }
        else { ComposerCreationTransition.shared.source = view }
    }
    final class Anchor: NSView {
        var sessionID: String?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let sessionID, window != nil { ComposerCreationTransition.shared.destinationReady(self, sessionID: sessionID) }
            else if let sessionID { ComposerCreationTransition.shared.cancel(sessionID: sessionID) }
        }
    }
}
