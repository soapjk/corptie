import AppKit
import XCTest
@testable import CorptieMac

@MainActor
final class MainWindowForegroundingTests: XCTestCase {
    private final class RecordingWindow: NSWindow {
        var events: [String] = []
        override func makeKeyAndOrderFront(_ sender: Any?) { events.append("key-front") }
        override func orderFrontRegardless() { events.append("front-regardless") }
    }

    func testExplicitRequestOrdersBeforeAsynchronousActivation() {
        _ = NSApplication.shared
        let window = RecordingWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 200),
                                     styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        MainWindowForegrounding.present(window) {
            XCTAssertEqual(window.events, ["key-front", "front-regardless"])
            window.events.append("activate")
        }
        XCTAssertEqual(window.events, ["key-front", "front-regardless", "activate"])
        XCTAssertEqual(window.level, .normal)
    }

    func testExplicitRequestRevealsExistingNativeWindowWithoutReplacingContent() {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 200),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let content = NSView()
        window.contentView = content
        window.orderOut(nil)
        MainWindowForegrounding.present(window, activate: {})
        XCTAssertTrue(window.isVisible)
        XCTAssertTrue(window.contentView === content)
        XCTAssertEqual(window.level, .normal)
    }
}
