import AppKit
import Testing
@testable import CorptieMac

@MainActor
struct ConsoleOverlayScrollerTests {
    @Test func classicTaskListsDoNotAddASecondVisibleIndicator() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/Console/UnifiedConsoleWorkTaskList.swift"),
            encoding: .utf8)
        #expect(source.components(separatedBy: ".scrollIndicators(.hidden)").count - 1 == 3)
        #expect(!source.contains("ConsoleOverlayScroller(placeOnLeadingEdge: true)"))
    }

    @Test func timelineUsesCompatibleTransparentOverlay() {
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: NSTableView())
        #expect(scroll.scrollerStyle == .overlay)
        #expect(type(of: scroll.verticalScroller!).isCompatibleWithOverlayScrollers)
        #expect(scroll.verticalScroller is ConsoleThinScroller)
        #expect(NSScroller.scrollerWidth(for: .regular, scrollerStyle: .overlay)
                > ConsoleThinScroller.scrollerWidth(for: .regular, scrollerStyle: .overlay))
        #expect(!scroll.drawsBackground)
        #expect(!scroll.contentView.drawsBackground)
    }

    @Test func contentProbeConfiguresOnlyItsEnclosingScrollView() {
        let scroll = NSScrollView()
        scroll.scrollerStyle = .legacy
        scroll.hasVerticalScroller = true
        let content = NSView()
        scroll.documentView = content
        let probe = ConsoleOverlayScroller.Probe()
        content.addSubview(probe)
        probe.configure()
        #expect(scroll.scrollerStyle == .overlay)
        #expect(scroll.verticalScroller is ConsoleThinScroller)
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
        #expect(scroll.verticalScroller is ConsoleThinScroller)
        #expect(try #require(scroll.verticalScroller).frame.minX < 16)
        #expect(try #require(scroll.verticalScroller).frame.width <= 8)
        #expect(scroll.contentView.frame.width == 320)

        scroll.setFrameSize(NSSize(width: 400, height: 240))
        probe.configure()
        scroll.layoutSubtreeIfNeeded()
        #expect(try #require(scroll.verticalScroller).frame.minX < 16)
    }

    @Test func workRailScrollerAutoHidesOnTheLeadingEdge() throws {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 64, height: 240))
        scroll.hasVerticalScroller = true
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 64, height: 600))
        scroll.documentView = content
        let probe = ConsoleOverlayScroller.Probe(placeOnLeadingEdge: true)
        content.addSubview(probe)
        probe.configure()
        scroll.layoutSubtreeIfNeeded()

        #expect(scroll.scrollerStyle == .overlay)
        #expect(scroll.autohidesScrollers)
        #expect(scroll.verticalScroller is ConsoleThinScroller)
        #expect(try #require(scroll.verticalScroller).frame.minX < 16)
        #expect(scroll.contentView.frame.width == 64)
    }
}
