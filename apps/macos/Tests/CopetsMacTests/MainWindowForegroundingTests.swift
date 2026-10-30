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

    func testNativeScrollCanvasDragsWhileControlsAndTextSelectionStayInteractive() {
        let window = NSWindow(contentRect: .init(x: 100, y: 100, width: 400, height: 300),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let content = NSView(frame: .init(x: 0, y: 0, width: 400, height: 300))
        let scroll = NSScrollView(frame: content.frame)
        scroll.documentView = content
        window.contentView = scroll
        let button = NSButton(frame: .init(x: 20, y: 20, width: 100, height: 30))
        let editor = NSTextView(frame: .init(x: 20, y: 80, width: 200, height: 80))
        content.addSubview(button)
        content.addSubview(editor)
        XCTAssertTrue(MainWindowBackgroundDragPolicy.canDrag(at: .init(x: 350, y: 250), in: scroll))
        XCTAssertFalse(MainWindowBackgroundDragPolicy.canDrag(at: .init(x: 60, y: 35), in: scroll))
        XCTAssertFalse(MainWindowBackgroundDragPolicy.canDrag(at: .init(x: 60, y: 110), in: scroll))
        XCTAssertFalse(MainWindowBackgroundDragPolicy.canDrag(at: .init(x: -1, y: 110), in: scroll))
    }

    func testEmptyTimelineCanvasDragsButScrollbarKeepsTracking() {
        let window = NSWindow(contentRect: .init(x: 100, y: 100, width: 400, height: 300),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: AppKitChatTimelineView.makeTableView())
        window.contentView = scroll
        window.layoutIfNeeded()
        XCTAssertTrue(MainWindowBackgroundDragPolicy.canDrag(at: .init(x: 150, y: 100), in: scroll))
    }

}
