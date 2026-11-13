import AppKit
import SwiftUI
import CorptieConversation
import Testing
@testable import CorptieMac

@MainActor
struct ConsoleOverlayScrollerTests {
    @Test func workStyleConfigurationNeverReopensAClosedIndicatorGate() throws {
        let scroll = IndicatorEnableProbeScrollView(frame: NSRect(x: 0, y: 0, width: 320, height: 240))
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 900))
        scroll.documentView = content
        scroll.hasVerticalScroller = true
        scroll.enableAttempts = 0
        let probe = ConsoleOverlayScroller.Probe(usesWorkStyle: true, allowsVerticalIndicator: false)
        content.addSubview(probe)
        for _ in 0..<3 { probe.configure() }
        #expect(!scroll.hasVerticalScroller)
        #expect(scroll.enableAttempts == 0, "Closed-gate configuration must never enable then hide")
        #expect(scroll.verticalScroller is WorkOutlineThinScroller)
        #expect(scroll.autohidesScrollers)
        #expect(scroll.scrollerStyle == .overlay)
        #expect(scroll.scrollerInsets.right == WorkNavigationScrollStyle.trailingClearance)

        probe.allowsVerticalIndicator = true
        probe.configure()
        #expect(scroll.hasVerticalScroller)
        let sharedScroller = try #require(scroll.verticalScroller)
        #expect(sharedScroller is WorkOutlineThinScroller)
        probe.allowsVerticalIndicator = false
        scroll.enableAttempts = 0
        for _ in 0..<3 { probe.configure() }
        #expect(!scroll.hasVerticalScroller)
        #expect(scroll.enableAttempts == 0)
        #expect(scroll.verticalScroller === sharedScroller)

        // Other Work navigation callers retain their existing default policy.
        WorkNavigationScrollStyle.configure(scroll)
        #expect(scroll.hasVerticalScroller)
        #expect(scroll.verticalScroller === sharedScroller)
    }

    @Test func hostedWorkOutlineKeepsScrollerLeftAndOutsideContentAfterResize() throws {
        let host = NSHostingView(rootView: ScrollView {
            VStack {
                Color.clear.frame(height: 900).background(WorkContentBoundsProbe())
            }
            .padding(.horizontal, ConsoleWorkOutlineMetrics.groupHorizontalInset)
            .background(ConsoleOverlayScroller(placeOnLeadingEdge: true))
        }.contentMargins(.leading, ConsoleOverlayScroller.leadingContentInset, for: .scrollContent))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 240),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.orderOut(nil) }
        func scrollView(in view: NSView) -> NSScrollView? {
            (view as? NSScrollView) ?? view.subviews.lazy.compactMap(scrollView).first
        }
        func contentProbe(in view: NSView) -> NSView? {
            if view.identifier?.rawValue == "test.work-content-bounds" { return view }
            return view.subviews.lazy.compactMap(contentProbe).first
        }
        for width in [320.0, 420.0, 260.0] {
            window.setContentSize(NSSize(width: width, height: 240))
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
            let scroll = try #require(scrollView(in: host))
            scroll.tile()
            let scroller = try #require(scroll.verticalScroller)
            #expect(scroller.frame.minX < 16)
            let content = try #require(contentProbe(in: host))
            let contentFrame = content.convert(content.bounds, to: scroll)
            #expect(scroller.frame.maxX + 4 <= contentFrame.minX)
        }
    }
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
        #expect(scroll.verticalScroller?.controlSize == .small)
        #expect(NSScroller.scrollerWidth(for: .small, scrollerStyle: .overlay)
                == ConsoleThinScroller.scrollerWidth(for: .small, scrollerStyle: .overlay))
        #expect(!scroll.drawsBackground)
        #expect(!scroll.contentView.drawsBackground)
        #expect(scroll.autohidesScrollers)
        #expect(scroll.verticalScroller?.isOpaque == false)
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
        #expect(try #require(scroll.verticalScroller).controlSize == .small)
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

    /// The native transcript owns the full detail width. Its overlay indicator
    /// must live in the trailing reading gutter, never over the last card.
    @Test func timelineScrollerParksAtTheFarEdgeOfTheTrailingGutter() throws {
        let table = AppKitChatTimelineView.makeTableView()
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: table)
        let coordinator = AppKitChatTimelineView.Coordinator(followsLatest: .constant(true),
            onToggleExpansion: { _ in }, onAction: { _ in }, onNearTop: {})
        // Mirrors the standard-page callsite: set the opt-in before attaching,
        // exactly like NSViewRepresentable.makeNSView does.
        coordinator.setCentersReadingLane(true)
        coordinator.attach(tableView: table, scrollView: scroll)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 600),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = scroll
        defer { window.contentView = nil; window.close() }
        coordinator.updateSkin(.codexFlat)
        // A hidden overlay scroller has a zero frame. Real scrollable content
        // makes AppKit place it, which is what the user actually sees.
        let rows = (0..<40).map { index in
            AppKitChatTimelineRow(id: "gutter-row-\(index)", contentRevision: 1,
                nativeText: String(repeating: "A readable paragraph with enough content to wrap. ", count: 12),
                copyText: "Answer", nativeStyle: .agent, title: "", metadata: "",
                expandableTurnId: nil, isExpanded: false)
        }
        coordinator.apply(rows: rows)

        for width: CGFloat in [1200, 900, 1600, 1200] {
            window.setContentSize(NSSize(width: width, height: 600))
            window.layoutIfNeeded()
            scroll.layoutSubtreeIfNeeded()
            scroll.tile()
            let scroller = try #require(scroll.verticalScroller)
            let viewport = scroll.contentView.bounds.width
            let lane = WorkbenchStyle.lane(viewportWidth: viewport)
            #expect(scroller.frame.width > 0, "the indicator must be placed")
            #expect(abs(scroller.frame.maxX - (scroll.bounds.maxX - WorkNavigationScrollStyle.trailingClearance)) <= 1,
                    "indicator must share the Work column trailing clearance")
            #expect(scroller.frame.minX >= lane.maxX - 0.5,
                    "indicator must stay entirely inside the trailing gutter")
            #expect(abs(table.frame.minX - lane.minX) <= 0.5)
            #expect(abs(table.frame.maxX - lane.maxX) <= 0.5)
            #expect(abs(table.tableColumns[0].width - lane.width) <= 0.5,
                    "column autoresizing must not pull the message lane back to full width")
        }
        withExtendedLifetime(coordinator) {}
    }

    @Test func timelineCallSiteKeepsTheFullWidthViewportAndNativeLane() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")
        let conversation = try String(contentsOf: root.appendingPathComponent("Conversation/SessionConversationContent.swift"), encoding: .utf8)
        let coordinator = try String(contentsOf: root.appendingPathComponent("Conversation/Timeline/AppKitChatTimelineCoordinator.swift"), encoding: .utf8)
        let scrollViews = try String(contentsOf: root.appendingPathComponent("Conversation/Timeline/TimelineScrollViews.swift"), encoding: .utf8)
        let content = try String(contentsOf: root.appendingPathComponent("AppKitChatTimelineView.swift"), encoding: .utf8)

        #expect(conversation.contains(".modifier(WorkbenchTimelineViewport())"))
        #expect(conversation.contains("reservesVerticalScrollerGutter: !compactComposer"))
        #expect(conversation.contains("centersReadingLane: !compactComposer"))
        #expect(coordinator.contains("WorkbenchStyle.lane(viewportWidth: viewportWidth)"))
        #expect(coordinator.contains("tableView.frame = laneFrame"))
        #expect(coordinator.contains("centersReadingLane && reservesVerticalScrollerGutter"))
        #expect(content.contains("context.coordinator.setCentersReadingLane(centersReadingLane)"))
        #expect(scrollViews.contains("guard trailingScrollerExtension > 0 else { return }"))
    }
}

private final class IndicatorEnableProbeScrollView: NSScrollView {
    var enableAttempts = 0
    override var hasVerticalScroller: Bool {
        get { super.hasVerticalScroller }
        set {
            if newValue { enableAttempts += 1 }
            super.hasVerticalScroller = newValue
        }
    }
}

private struct WorkContentBoundsProbe: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.identifier = .init("test.work-content-bounds")
        return view
    }
    func updateNSView(_ view: NSView, context: Context) {}
}
