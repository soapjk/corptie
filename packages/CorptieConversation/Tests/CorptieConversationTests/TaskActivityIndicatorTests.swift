import SwiftUI
import Testing
#if os(macOS)
import AppKit
@testable import CorptieConversation

@MainActor
struct TaskActivityIndicatorTests {
    @Test func nativeHostRotatesEvenWithoutSwiftUISceneActivation() throws {
        let host = NSHostingView(rootView: TaskActivityIndicator(activity: .processing)
            .environment(\.scenePhase, .background))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 40, height: 40),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderBack(nil)
        defer { window.contentView = nil; window.close() }
        host.layoutSubtreeIfNeeded()
        let view = try #require(findRing(host))
        let animation = try #require(view.ring.animation(forKey: "runningRotation") as? CABasicAnimation)
        #expect(animation.keyPath == "transform.rotation.z")
        #expect(animation.duration == 0.8)
        #expect(animation.repeatCount.isInfinite)
        #expect(view.ring.strokeEnd == 0.75)
        #expect(view.ring.lineCap == CAShapeLayerLineCap.round)
        let beginTime = animation.beginTime
        view.synchronizeAnimation()
        #expect(view.ring.animation(forKey: "runningRotation")?.beginTime == beginTime)
        host.rootView = TaskActivityIndicator(activity: .processing, isActive: false)
            .environment(\.scenePhase, .background)
        host.layoutSubtreeIfNeeded()
        #expect(try #require(findRing(host)) === view)
        #expect(view.ring.animationKeys()?.isEmpty != false)
    }

    @Test func inactiveAndDetachedRingsStopAndReattachRestarts() throws {
        let view = TaskRunningRingView()
        let window = NSWindow(contentRect: view.frame, styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.contentView = nil; window.close() }
        window.contentView = view
        #expect(view.ring.animation(forKey: "runningRotation") != nil)
        view.animates = false
        view.synchronizeAnimation()
        #expect(view.ring.animation(forKey: "runningRotation") == nil)
        view.animates = true
        view.synchronizeAnimation()
        #expect(view.ring.animation(forKey: "runningRotation") != nil)
        window.contentView = nil
        #expect(view.ring.animation(forKey: "runningRotation") == nil)
        window.contentView = view
        #expect(view.ring.animation(forKey: "runningRotation") != nil)
    }

    private func findRing(_ view: NSView) -> TaskRunningRingView? {
        (view as? TaskRunningRingView) ?? view.subviews.lazy.compactMap(findRing).first
    }
}
#endif
