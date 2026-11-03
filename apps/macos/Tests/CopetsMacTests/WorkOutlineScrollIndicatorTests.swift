import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

@MainActor
struct WorkOutlineScrollIndicatorTests {
    private struct Row: Identifiable { let id: String }

    @Test func actualWorkOutlineInstallsThreePointAutoHidingCapsuleWithoutChangingItsViewport() async throws {
        let host = NSHostingView(rootView: ConsoleNativeOutline(groups: {
            [ConsoleNativeOutlineGroup(id: "work", header: AnyView(Text("Work")),
                rows: (0..<80).map { Row(id: "task:\($0)") }, isExpanded: true)]
        }) { row in Text(row.id) })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 240),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil; window.orderOut(nil) }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        func findScroll(_ view: NSView) -> NSScrollView? {
            (view as? NSScrollView) ?? view.subviews.lazy.compactMap(findScroll).first
        }
        let scroll = try #require(findScroll(host) as? WorkOutlineScrollView)
        let thumb = try #require(scroll.verticalScroller as? WorkOutlineThinScroller)
        #expect(scroll.documentView is NSOutlineView)
        #expect(scroll.autohidesScrollers)
        #expect(thumb.paintedKnobWidth == 3)
        #expect(thumb.visibleKnobLayer.opacity == 0)
        let viewport = scroll.contentView.frame
        #expect(!scroll.showsTopDivider)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 200))
        scroll.reflectScrolledClipView(scroll.contentView)
        try await Task.sleep(for: .milliseconds(50))
        thumb.displayIfNeeded()
        thumb.updateLayer()
        #expect(thumb.visibleKnobLayer.opacity == 1)
        #expect(thumb.visibleKnobLayer.frame.width == 3)
        #expect(thumb.visibleKnobLayer.cornerRadius == 1.5)
        #expect(scroll.contentView.frame == viewport)
        #expect(scroll.showsTopDivider)
        #expect(scroll.topDividerFrame.width == scroll.bounds.width)
        try await Task.sleep(for: .milliseconds(1000))
        #expect(thumb.visibleKnobLayer.opacity == 0)
        #expect(scroll.contentView.frame == viewport)
        scroll.contentView.scroll(to: .zero)
        scroll.reflectScrolledClipView(scroll.contentView)
        #expect(!scroll.showsTopDivider)
        #expect(scroll.contentView.frame == viewport)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 400))
        scroll.reflectScrolledClipView(scroll.contentView)
        try await Task.sleep(for: .milliseconds(50))
        #expect(thumb.visibleKnobLayer.opacity == 1)
        #expect(scroll.contentView.frame == viewport)
    }

    @Test func workThumbKeepsSystemLaneWidthForEitherScrollerStyle() {
        for style in [NSScroller.Style.legacy, .overlay] {
            #expect(WorkOutlineThinScroller.scrollerWidth(for: .regular, scrollerStyle: style)
                == NSScroller.scrollerWidth(for: .regular, scrollerStyle: style))
        }
    }
}
