import AppKit
import XCTest
@testable import CorptieMac

@MainActor
final class MainWindowMouseActivationTests: XCTestCase {
    private final class RecordingWindow: MainWindow {
        var keyed = false
        var steps: [String] = []
        var draggedEvents: [NSEvent] = []
        override var isKeyWindow: Bool { keyed }
        override func makeKey() { steps.append("key"); keyed = true }
        override func performDrag(with event: NSEvent) {
            steps.append(keyed ? "drag-key" : "drag-inactive")
            draggedEvents.append(event)
        }
    }
    private final class FocusProbe: NSResponder { override var acceptsFirstResponder: Bool { true } }
    private func event(_ window: NSWindow, kind: NSEvent.EventType = .leftMouseDown,
                       flags: NSEvent.ModifierFlags = []) throws -> NSEvent {
        try XCTUnwrap(NSEvent.mouseEvent(with: kind, location: .init(x: 240, y: 130), modifierFlags: flags,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, eventNumber: 7, clickCount: 1, pressure: 1))
    }
    private func window() -> RecordingWindow {
        _ = NSApplication.shared
        let window = RecordingWindow(contentRect: .init(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        return window
    }
    func testInactiveApplicationIsActivatedBeforeKeyAndAlreadyActiveClicksAreNoOps() throws {
        let window = self.window()
        defer { window.close() }
        let click = try event(window)
        MainWindowMouseActivation.prepare(click, window: window, applicationIsActive: false, modalWindow: nil) {
            window.steps.append("activate")
        }
        XCTAssertEqual(window.steps, ["activate", "key"])
        MainWindowMouseActivation.prepare(click, window: window, applicationIsActive: true, modalWindow: nil) {
            XCTFail("An already active application must not be activated again")
        }
        XCTAssertEqual(window.steps, ["activate", "key"])
    }
    func testBackgroundCommandClickOtherMouseButtonsAndModalWindowKeepNativeRouting() throws {
        let window = self.window(), modal = self.window()
        defer { window.close(); modal.close() }
        for (kind, flags, blockedByModal) in [(NSEvent.EventType.leftMouseDown, NSEvent.ModifierFlags.command, false),
                                              (.rightMouseDown, [], false), (.leftMouseDown, [], true)] {
            MainWindowMouseActivation.prepare(try event(window, kind: kind, flags: flags), window: window,
                applicationIsActive: false, modalWindow: blockedByModal ? modal : nil) {
                XCTFail("Background or blocked clicks must not steal activation")
            }
        }
        XCTAssertTrue(window.steps.isEmpty)
    }
    func testRealSendEventKeysBeforeBlankCanvasDragAndUsesOriginalEventOnce() throws {
        let window = self.window()
        defer { window.close() }
        let scroll = NSScrollView(frame: .init(x: 0, y: 0, width: 400, height: 300))
        scroll.documentView = NSView(frame: scroll.bounds)
        window.contentView = scroll
        let responder = FocusProbe()
        window.makeFirstResponder(responder)
        let click = try event(window)
        window.sendEvent(click)
        XCTAssertEqual(window.steps, ["key", "drag-key"])
        XCTAssertEqual(window.draggedEvents.count, 1)
        XCTAssertTrue(window.draggedEvents.first === click)
        XCTAssertTrue(window.firstResponder === responder, "Activation must not force focus into the editor")
    }
}
