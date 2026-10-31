import AppKit
import QuartzCore
import Testing
@testable import CorptieMac

struct CorptieLoadingLogoTests {
    @Test @MainActor
    func transparentConcentricArtworkKeepsThreeSeparateArcs() throws {
        let view = CorptieLoadingLogoView(frame: CGRect(x: 0, y: 0, width: 128, height: 128))
        view.layoutSubtreeIfNeeded()
        let root = try #require(view.layer)
        let artwork = try #require(root.sublayers?.first)
        let outer = try #require(artwork.sublayers?.first)
        let inner = try #require(artwork.sublayers?.last)
        #expect(root.backgroundColor == nil)
        #expect(artwork.backgroundColor == nil)
        #expect(outer.position == inner.position)
        #expect(outer.bounds == inner.bounds)
        let arcs = try #require(outer.sublayers?.first as? CAShapeLayer)
        var moves = 0
        arcs.path?.applyWithBlock { if $0.pointee.type == .moveToPoint { moves += 1 } }
        #expect(moves == 3)
        let ring = try #require(inner.sublayers?[1] as? CAShapeLayer)
        #expect(ring.path?.boundingBoxOfPath.midX == 0)
        #expect(ring.path?.boundingBoxOfPath.midY == 0)
        #expect(ring.fillColor == nil)
        #expect(inner.sublayers?.count == 5)
        let colorNodes = try #require(inner.sublayers).suffix(3)
        let directions = [CGPoint(x: 0, y: -1), CGPoint(x: -sqrt(3) / 2, y: 0.5),
                          CGPoint(x: sqrt(3) / 2, y: 0.5)]
        for (node, direction) in zip(colorNodes, directions) {
            let box = try #require((node as? CAShapeLayer)?.path?.boundingBoxOfPath)
            #expect(abs(box.midX * direction.y - box.midY * direction.x) < 0.0001)
            #expect(abs(hypot(box.midX, box.midY) - 152) < 0.0001)
        }
        // Resizing changes only the group transform, never recreates paths/layers.
        view.frame.size = CGSize(width: 256, height: 256)
        view.needsLayout = true
        view.layoutSubtreeIfNeeded()
        #expect(outer.sublayers?.first === arcs)
        #expect(abs(artwork.affineTransform().a - 0.4) < 0.001)
    }

    @Test @MainActor
    func selectedSpeedsAndReducedMotionFollowWindowLifecycle() throws {
        let view = CorptieLoadingLogoView(frame: CGRect(x: 0, y: 0, width: 128, height: 128))
        let window = LogoVisibilityWindow(contentRect: view.bounds, styleMask: [.borderless],
                                          backing: .buffered, defer: false)
        window.contentView = view
        view.configure(reduceMotion: false)
        let groups = try #require(view.layer?.sublayers?.first?.sublayers)
        let outer = try #require(groups.first)
        let inner = try #require(groups.last)
        let outerAnimation = try #require(outer.animation(forKey: "rotation") as? CABasicAnimation)
        let innerAnimation = try #require(inner.animation(forKey: "rotation") as? CABasicAnimation)
        #expect(abs(outerAnimation.duration - 60 / 31.5) < 0.0001)
        #expect(abs(innerAnimation.duration - 60 / 25.5) < 0.0001)
        #expect((outerAnimation.toValue as? Double) == 2 * Double.pi)
        #expect((innerAnimation.toValue as? Double) == -2 * Double.pi)
        view.configure(reduceMotion: true)
        #expect(outer.animationKeys()?.isEmpty != false)
        #expect(inner.animationKeys()?.isEmpty != false)
        view.configure(reduceMotion: false)
        #expect(outer.animationKeys()?.count == 1)
        window.visibleForTest = false
        NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: window)
        #expect(outer.animationKeys()?.isEmpty != false)
        window.visibleForTest = true
        NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: window)
        #expect(outer.animationKeys()?.count == 1)
        view.removeFromSuperview()
        #expect(outer.animationKeys()?.isEmpty != false)
        #expect(inner.animationKeys()?.isEmpty != false)
    }
}

// WindowServer may report every test window as occluded on a background host.
// Supply deterministic visibility to exercise the real notification/layer path.
private final class LogoVisibilityWindow: NSWindow {
    var visibleForTest = true
    override var isVisible: Bool { visibleForTest }
    override var occlusionState: NSWindow.OcclusionState { visibleForTest ? [.visible] : [] }
}
