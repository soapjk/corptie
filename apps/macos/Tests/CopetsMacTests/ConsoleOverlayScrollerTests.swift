import AppKit
import SwiftUI
import CorptieConversation
import Testing
@testable import CorptieMac

@MainActor
struct ConsoleOverlayScrollerTests {
    @Test func timelineTrackClicksAreIgnoredWithoutChangingReaderIntent() throws {
        let scroller = TimelineIntentScroller(frame: NSRect(x: 0, y: 0, width: 16, height: 400))
        let window = NSWindow(contentRect: scroller.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = scroller
        defer { window.orderOut(nil) }
        scroller.scrollerStyle = .legacy
        scroller.isEnabled = true
        scroller.knobProportion = 0.2
        scroller.doubleValue = 0.5
        var begins = 0
        var ends = 0
        scroller.onBegin = { begins += 1 }
        scroller.onEnd = { ends += 1 }
        let knob = scroller.rect(for: .knob)
        #expect(!knob.isEmpty)
        let knobPoint = scroller.convert(NSPoint(x: knob.midX, y: knob.midY), to: nil)
        #expect(scroller.testPart(knobPoint) == .knob)
        let trackPoint = scroller.convert(NSPoint(x: knob.midX, y: max(1, knob.minY - 10)), to: nil)
        #expect(scroller.testPart(trackPoint) == .noPart)
        let event = try #require(NSEvent.mouseEvent(with: .leftMouseDown, location: trackPoint,
            modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
            eventNumber: 0, clickCount: 1, pressure: 1))
        scroller.mouseDown(with: event)
        #expect(scroller.doubleValue == 0.5)
        #expect(begins == 0)
        #expect(ends == 0)
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
        #expect(NSScroller.scrollerWidth(for: .regular, scrollerStyle: .overlay)
                > ConsoleThinScroller.scrollerWidth(for: .regular, scrollerStyle: .overlay))
        #expect(!scroll.drawsBackground)
        #expect(!scroll.contentView.drawsBackground)
        #expect(scroll.autohidesScrollers)
        #expect(scroll.verticalScroller?.isOpaque == false)
    }

    @Test func sessionListUsesTransparentAutoHidingOverlayWithoutAContentGutter() throws {
        let scroll = AppKitSessionListView.makeScrollView(tableView: NSTableView())
        scroll.setFrameSize(NSSize(width: 320, height: 240))
        scroll.tile()
        #expect(scroll.scrollerStyle == .overlay)
        #expect(scroll.autohidesScrollers)
        #expect(scroll.verticalScroller is ConsoleThinScroller)
        #expect(!scroll.drawsBackground)
        #expect(!scroll.contentView.drawsBackground)
        #expect(scroll.borderType == .noBorder)
        #expect(scroll.contentView.frame.width == 320)
        #expect(scroll.scrollerInsets.right == 0)
    }

    @Test func scrollerPaintsOnlyThreePointKnobAndNoTrackInBothAppearances() throws {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            for width: CGFloat in [8, 12, 16] {
                let scroller = TimelineIntentScroller(frame: NSRect(x: 0, y: 0, width: width, height: 240))
                // Exercise the drawing independently of AppKit's overlay fade state.
                scroller.scrollerStyle = .legacy
                scroller.isEnabled = true
                scroller.knobProportion = 0.2
                scroller.doubleValue = 0.5
                let bounds = scroller.bounds
                let knob = scroller.rect(for: .knob)
                #expect(!knob.isEmpty)
                let bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil,
                    pixelsWide: Int(bounds.width), pixelsHigh: Int(bounds.height), bitsPerSample: 8,
                    samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
                let context = try #require(NSGraphicsContext(bitmapImageRep: bitmap))
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = context
                NSColor.clear.setFill()
                bounds.fill(using: .copy)
                NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance {
                    scroller.draw(bounds)
                    scroller.drawKnobSlot(in: bounds, highlight: true)
                }
                context.flushGraphics()
                NSGraphicsContext.restoreGraphicsState()
                var paintedColumns = Set<Int>()
                var paintedRows = Set<Int>()
                var maximumAlpha: CGFloat = 0
                for y in 0..<bitmap.pixelsHigh {
                    for x in 0..<bitmap.pixelsWide {
                        let pixel = bitmap.colorAt(x: x, y: y)
                        maximumAlpha = max(maximumAlpha, pixel?.alphaComponent ?? 0)
                        if (pixel?.alphaComponent ?? 0) > 0.01 {
                            #expect((pixel?.redComponent ?? 0) > 0.95)
                            #expect((pixel?.greenComponent ?? 0) > 0.95)
                            #expect((pixel?.blueComponent ?? 0) > 0.95)
                            paintedColumns.insert(x)
                            paintedRows.insert(y)
                        }
                    }
                }
                #expect(!paintedColumns.isEmpty)
                #expect(maximumAlpha > 0.3 && maximumAlpha < 0.4)
                // At most one anti-aliased edge pixel per side at 1x.
                #expect(paintedColumns.count == Int(ConsoleThinScroller.knobWidth))
                #expect(scroller.knobColor == NSColor.white.withAlphaComponent(0.38))
                #expect(paintedColumns.max() == Int(bounds.maxX) - 2)
                let visibleThumbPoint = scroller.convert(NSPoint(x: bounds.maxX - 2, y: knob.midY), to: nil)
                #expect(scroller.testPart(visibleThumbPoint) == .knob)
                #expect(paintedRows.count <= Int(ceil(knob.height)) + 2)
                #expect(paintedRows.count < bitmap.pixelsHigh / 2)
            }
        }
    }

    @Test func timelineThumbFadesAfterIdleAndCanReappear() async throws {
        let scroller = TimelineIntentScroller(frame: NSRect(x: 0, y: 0, width: 8, height: 240))
        #expect(scroller.alphaValue == 0)
        scroller.beginScrollInteraction()
        #expect(scroller.alphaValue == 1)
        scroller.endScrollInteraction()
        try await Task.sleep(for: .milliseconds(450))
        #expect(scroller.alphaValue == 1)
        scroller.beginScrollInteraction()
        scroller.endScrollInteraction()
        try await Task.sleep(for: .milliseconds(450))
        #expect(scroller.alphaValue == 1)
        try await Task.sleep(for: .milliseconds(650))
        #expect(scroller.alphaValue == 0)
        scroller.beginScrollInteraction()
        #expect(scroller.alphaValue == 1)
        scroller.endScrollInteraction()
        let event = NSEvent()
        scroller.mouseEntered(with: event)
        try await Task.sleep(for: .milliseconds(1000))
        #expect(scroller.alphaValue == 1)
        scroller.mouseExited(with: event)
        try await Task.sleep(for: .milliseconds(1100))
        #expect(scroller.alphaValue == 0)
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

private struct WorkContentBoundsProbe: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.identifier = .init("test.work-content-bounds")
        return view
    }
    func updateNSView(_ view: NSView, context: Context) {}
}
