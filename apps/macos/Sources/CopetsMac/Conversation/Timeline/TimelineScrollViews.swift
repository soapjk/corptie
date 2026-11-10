import AppKit
import SwiftUI
import CorptieConversation
import CorptieClientCore

final class FirstLayoutRestoringScrollView: NSScrollView {
    var forcesOverlayScrollers = false {
        didSet {
            if forcesOverlayScrollers { scrollerStyle = .overlay }
        }
    }

    override var scrollerStyle: NSScroller.Style {
        get { super.scrollerStyle }
        set { super.scrollerStyle = forcesOverlayScrollers ? .overlay : newValue }
    }

    /// The host borrows existing page spacing; the message viewport stays unchanged.
    var trailingScrollerExtension: CGFloat = 0 {
        didSet {
            guard oldValue != trailingScrollerExtension else { return }
            tile()
            needsLayout = true
        }
    }

    override func tile() {
        super.tile()
        // With a viewport-wide scroll view AppKit already parks the overlay
        // indicator on its trailing edge; the centred message table leaves
        // that whole gutter empty. No manual scroller placement is needed.
        guard trailingScrollerExtension > 0 else { return }
        let contentWidth = max(0, bounds.width - trailingScrollerExtension)
        contentView.setFrameSize(NSSize(width: contentWidth, height: contentView.frame.height))
        if let scroller = verticalScroller {
            scroller.frame = NSRect(x: bounds.maxX - 12, y: scroller.frame.minY,
                width: 12, height: scroller.frame.height)
        }
    }

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
    #if DEBUG
    private(set) var fullReloadCount = 0
    override func reloadData() {
        fullReloadCount += 1
        super.reloadData()
    }
    #endif
    var onLayout: (() -> Void)?

    override func layout() {
        super.layout()
        onLayout?()
    }

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

/// Preserve reader intent while AppKit owns painting, hit testing and fading.
class TimelineIntentScroller: ConsoleThinScroller {
    var onBegin: (() -> Void)?
    var onEnd: (() -> Void)?
    func beginScrollInteraction() { enclosingScrollView?.flashScrollers() }
    func endScrollInteraction() { }
    override func mouseDown(with event: NSEvent) {
        onBegin?()
        defer { onEnd?() }
        super.mouseDown(with: event)
    }
}
