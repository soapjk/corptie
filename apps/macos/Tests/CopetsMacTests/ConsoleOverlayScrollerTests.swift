import AppKit
import Testing
@testable import CorptieMac

@MainActor
struct ConsoleOverlayScrollerTests {
    @Test func timelineUsesCompatibleTransparentOverlay() {
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: NSTableView())
        #expect(scroll.scrollerStyle == .overlay)
        #expect(type(of: scroll.verticalScroller!).isCompatibleWithOverlayScrollers)
        #expect(!scroll.drawsBackground)
        #expect(!scroll.contentView.drawsBackground)
    }

    @Test func floatingComposerInsetsTimelineWithoutPaintingAnOpaqueFooter() {
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: NSTableView())
        AppKitChatTimelineView.updateBottomInset(96, on: scroll)
        #expect(scroll.contentInsets.bottom == 96)
        #expect(scroll.scrollerInsets.bottom == 96)
        #expect(!scroll.drawsBackground)
        #expect(!scroll.contentView.drawsBackground)

        AppKitChatTimelineView.updateBottomInset(132, on: scroll)
        #expect(scroll.contentInsets.bottom == 132)
        AppKitChatTimelineView.updateBottomInset(0, on: scroll)
        #expect(scroll.contentInsets.bottom == 0)
    }

    @Test func bottomInsetMakesLastRowScrollableAboveComposer() {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 320, height: 300))
        scroll.documentView = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 600))
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 100, right: 0)
        scroll.layoutSubtreeIfNeeded()
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 400))
        #expect(scroll.contentView.bounds.minY >= 399)
    }

    @Test func contentProbeConfiguresOnlyItsEnclosingScrollView() {
        let scroll = NSScrollView()
        scroll.scrollerStyle = .legacy
        let content = NSView()
        scroll.documentView = content
        let probe = ConsoleOverlayScroller.Probe()
        content.addSubview(probe)
        probe.configure()
        #expect(scroll.scrollerStyle == .overlay)
        #expect(!scroll.drawsBackground)
        #expect(!scroll.contentView.drawsBackground)
    }

    @Test func workOutlineScrollerAutoHidesOnTheLeadingEdge() throws {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 320, height: 240))
        scroll.hasVerticalScroller = true
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 600))
        scroll.documentView = content
        let probe = ConsoleOverlayScroller.Probe(placeOnLeadingEdge: true)
        content.addSubview(probe)
        probe.configure()
        scroll.layoutSubtreeIfNeeded()

        #expect(scroll.scrollerStyle == .overlay)
        #expect(scroll.autohidesScrollers)
        #expect(try #require(scroll.verticalScroller).frame.minX < 16)
        #expect(scroll.contentView.frame.width == 320)

        scroll.setFrameSize(NSSize(width: 400, height: 240))
        probe.configure()
        scroll.layoutSubtreeIfNeeded()
        #expect(try #require(scroll.verticalScroller).frame.minX < 16)
    }
}
