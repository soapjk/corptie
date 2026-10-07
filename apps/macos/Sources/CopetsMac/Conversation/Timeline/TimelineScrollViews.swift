import AppKit
import SwiftUI
import CorptieConversation
import CorptieClientCore

final class FirstLayoutRestoringScrollView: NSScrollView {
    var onLayout: (() -> Void)?
    var onUserScrollWillBegin: (() -> Void)?
    var onUserScrollDidEnd: (() -> Void)?

    override func scrollWheel(with event: NSEvent) {
        onUserScrollWillBegin?()
        defer { onUserScrollDidEnd?() }
        super.scrollWheel(with: event)
    }

    override func layout() {
        super.layout()
        onLayout?()
    }
}

final class IntrinsicHeightTableView: NSTableView {
    override func keyDown(with event: NSEvent) {
        guard [UInt16(116), 121, 115, 119, 125, 126].contains(event.keyCode),
              let scroll = enclosingScrollView as? FirstLayoutRestoringScrollView else {
            super.keyDown(with: event)
            return
        }
        scroll.onUserScrollWillBegin?()
        defer { scroll.onUserScrollDidEnd?() }
        super.keyDown(with: event)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        enclosingScrollView?.contentView.postsBoundsChangedNotifications = true
    }
}

final class TimelineIntentScroller: ConsoleThinScroller {
    var onBegin: (() -> Void)?
    var onEnd: (() -> Void)?

    override func testPart(_ point: NSPoint) -> NSScroller.Part {
        super.testPart(point) == .knob ? .knob : .noPart
    }

    override func mouseDown(with event: NSEvent) {
        guard testPart(event.locationInWindow) == .knob else { return }
        onBegin?()
        defer { onEnd?() }
        super.mouseDown(with: event)
    }
}
