import AppKit
import Testing
@testable import CorptieMac

@MainActor
struct CompactWindowControlsTests {
    private final class CloseRecorder: NSObject, NSWindowDelegate {
        var requests = 0
        func windowShouldClose(_ sender: NSWindow) -> Bool { requests += 1; return false }
    }

    @Test func mountingPreservesSystemControlsAndRestoresTheirPositions() throws {
        let window = makeWindow()
        defer { window.contentView = nil; window.close() }
        let native = try [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].map {
            try #require(window.standardWindowButton($0))
        }
        let frames = native.map(\.frame)
        let frameNotifications = native.map(\.postsFrameChangedNotifications)
        let parents = native.map(\.superview)
        let actions = native.map(\.action)
        let targets = native.map(\.target)
        let controls = mount(on: window)
        window.orderBack(nil)
        window.layoutIfNeeded()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
        #expect(controls.buttons.count == 3)
        for index in native.indices {
            let button = native[index]
            #expect(controls.buttons[index] === button)
            #expect(button.superview === parents[index])
            #expect(button.target === targets[index])
            #expect(button.action == actions[index])
            #expect(button.frame.size == frames[index].size)
            #expect(button.frame.minY == frames[index].minY)
            #expect(!button.isHidden)
            let rect = controls.convert(button.bounds, from: button)
            #expect(rect.minX >= 0 && rect.maxX <= 56)
        }
        #expect(controls.hitTest(.zero) == nil)
        // AppKit can lay out the native title bar after the SwiftUI anchor.
        // Exercise that later reset without calling our positioning method.
        for (button, original) in zip(native, frames) { button.setFrameOrigin(original.origin) }
        for button in native {
            let rect = controls.convert(button.bounds, from: button)
            #expect(rect.minX >= 0 && rect.maxX <= 56)
        }
        controls.viewDidMoveToWindow()
        window.setContentSize(NSSize(width: 900, height: 500))
        window.layoutIfNeeded()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
        for button in native {
            let rect = controls.convert(button.bounds, from: button)
            #expect(rect.minX >= 0 && rect.maxX <= 56)
        }
        controls.removeFromSuperview()
        #expect(native.map { $0.frame.minX } == frames.map(\.minX))
        #expect(native.map(\.postsFrameChangedNotifications) == frameNotifications)
    }

    @Test func closeUsesTheBoundWindowsDelegateAndDoesNotSelectAnotherWindow() throws {
        let window = makeWindow(), other = makeWindow()
        let first = CloseRecorder(), second = CloseRecorder()
        window.delegate = first; other.delegate = second
        defer { window.contentView = nil; other.contentView = nil; window.close(); other.close() }
        let controls = mount(on: window)
        window.orderBack(nil)
        controls.buttons[0].performClick(nil)
        #expect(first.requests == 1)
        #expect(second.requests == 0)
        #expect(window.isVisible)
    }

    private func makeWindow(style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]) -> MainWindow {
        _ = NSApplication.shared
        let window = MainWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400),
                                styleMask: style, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        return window
    }

    private func mount(on window: MainWindow) -> CompactWindowControlsView {
        let controls = CompactWindowControlsView()
        controls.frame.origin = NSPoint(x: 0, y: (window.contentView?.bounds.height ?? 400) - 32)
        window.contentView?.addSubview(controls)
        controls.layoutSubtreeIfNeeded()
        return controls
    }
}
