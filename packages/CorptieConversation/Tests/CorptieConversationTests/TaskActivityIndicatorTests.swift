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

    @Test func staggeredAndReattachedRingsShareTheSameMediaTimeOrigin() throws {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 80, height: 40))
        let window = NSWindow(contentRect: container.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = container
        defer { window.contentView = nil; window.close() }
        let first = TaskRunningRingView()
        container.addSubview(first)
        func origin(_ view: TaskRunningRingView) throws -> Double {
            let animation = try #require(view.ring.animation(forKey: "runningRotation"))
            #expect(animation.beginTime != 0)
            return view.ring.convertTime(animation.beginTime, to: nil)
        }
        let expected = try origin(first)
        RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        let second = TaskRunningRingView()
        container.addSubview(second)
        #expect(abs(try origin(second) - expected) < 0.000001)
        second.removeFromSuperview()
        #expect(second.ring.animation(forKey: "runningRotation") == nil)
        RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        container.addSubview(second)
        #expect(abs(try origin(second) - expected) < 0.000001)
        #expect(abs(try origin(first) - expected) < 0.000001)
    }

    private func findRing(_ view: NSView) -> TaskRunningRingView? {
        (view as? TaskRunningRingView) ?? view.subviews.lazy.compactMap(findRing).first
    }
}
#endif
