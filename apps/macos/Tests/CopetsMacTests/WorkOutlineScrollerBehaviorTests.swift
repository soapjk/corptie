import AppKit
import SwiftUI
import XCTest
@testable import CorptieMac

@MainActor
final class WorkOutlineScrollerBehaviorTests: XCTestCase {
    private struct Row: Identifiable { let id: String }

    func testAllWorkSurfacesUseTheSameOverlayInsideTheViewportAtDifferentWidths() throws {
        _ = NSApplication.shared
        let native = ConsoleNativeOutline(groups: {
            [ConsoleNativeOutlineGroup(id: "work", header: AnyView(Text("Work")),
                rows: (0..<100).map { Row(id: "row-\($0)") }, isExpanded: true)]
        }) { Text($0.id) }
        let list = List {
            Text("Chat").background(ConsoleOverlayScroller(usesWorkStyle: true))
            ForEach(0..<100, id: \.self) { Text("Session \($0)") }
        }.listStyle(.plain)
        let cards = ScrollView {
            LazyVStack {
                ForEach(0..<100, id: \.self) { Text("Task \($0)").frame(height: 60) }
            }.background(ConsoleOverlayScroller(usesWorkStyle: true))
        }
        for surface in [AnyView(native), AnyView(list), AnyView(cards)] {
            let host = NSHostingView(rootView: surface)
            let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 200),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = host
            defer { window.contentView = nil; window.orderOut(nil) }
            func findScroll(_ view: NSView) -> NSScrollView? {
                if let scroll = view as? NSScrollView { return scroll }
                return view.subviews.lazy.compactMap(findScroll).first
            }
            for width in [220.0, 400.0, 284.0] {
                window.setContentSize(.init(width: width, height: 200))
                host.layoutSubtreeIfNeeded()
                RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
                let scroll = try XCTUnwrap(findScroll(host))
                scroll.tile()
                let thumb = try XCTUnwrap(scroll.verticalScroller as? WorkOutlineThinScroller)
                XCTAssertEqual(scroll.scrollerStyle, .overlay)
                XCTAssertTrue(scroll.autohidesScrollers)
                XCTAssertEqual(thumb.controlSize, .small)
                XCTAssertEqual(scroll.scrollerInsets.right, WorkNavigationScrollStyle.trailingClearance)
                let frame = scroll.convert(thumb.bounds, from: thumb)
                XCTAssertLessThanOrEqual(frame.maxX, scroll.bounds.maxX - WorkNavigationScrollStyle.trailingClearance + 0.5)
                XCTAssertGreaterThanOrEqual(frame.minX, scroll.bounds.minX)
                let knob = thumb.rect(for: .knob)
                XCTAssertGreaterThan(knob.minX, thumb.bounds.minX)
                XCTAssertLessThan(knob.maxX, thumb.bounds.maxX)
                XCTAssertEqual(scroll.contentView.frame.width, scroll.bounds.width, accuracy: 0.5,
                    "An overlay inset must not shrink or shift the content column")
            }
        }
    }

    func testCapsulePixelsAreSymmetricAtOneAndTwoTimesScale() throws {
        _ = NSApplication.shared
        for thumb in [WorkOutlineThinScroller(frame: .init(x: 0, y: 0, width: 20, height: 200)),
                      TimelineIntentScroller(frame: .init(x: 0, y: 0, width: 20, height: 200))] {
            for size in [NSControl.ControlSize.small, .regular] {
                thumb.controlSize = size
                thumb.scrollerStyle = .overlay
                thumb.knobProportion = 0.25
                thumb.doubleValue = 0.5
                let knob = thumb.rect(for: .knob)
                for scale in [1, 2] {
                    let width = Int(knob.width) * scale
                    let height = Int(ceil(knob.height * CGFloat(scale)))
                    let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width,
                        pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: width * 4, bitsPerPixel: 32))
                    memset(try XCTUnwrap(bitmap.bitmapData), 0, bitmap.bytesPerRow * height)
                    NSGraphicsContext.saveGraphicsState()
                    NSGraphicsContext.current = try XCTUnwrap(NSGraphicsContext(bitmapImageRep: bitmap))
                    let context = try XCTUnwrap(NSGraphicsContext.current?.cgContext)
                    context.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
                    context.translateBy(x: -knob.minX, y: -knob.minY)
                    thumb.drawKnob()
                    NSGraphicsContext.restoreGraphicsState()
                    var paintedRows: [[Int]] = []
                    var paintedY: [Int] = []
                    for y in 0..<height {
                        var painted: [Int] = []
                        for x in 0..<width {
                            let alpha = bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0
                            let mirrored = bitmap.colorAt(x: width - 1 - x, y: y)?.alphaComponent ?? 0
                            XCTAssertEqual(alpha, mirrored, accuracy: 0.025,
                                "Every row must have symmetric caps at \(scale)x, size \(size)")
                            if alpha > 0.1 { painted.append(x) }
                        }
                        if !painted.isEmpty { paintedRows.append(painted); paintedY.append(y) }
                    }
                    // At 1x an antialiased corner can have partial coverage. Its
                    // alpha must taper below the center rather than form a flat end.
                    for y in [try XCTUnwrap(paintedY.first), try XCTUnwrap(paintedY.last)] {
                        let edge = bitmap.colorAt(x: 0, y: y)?.alphaComponent ?? 0
                        let center = bitmap.colorAt(x: width / 2, y: y)?.alphaComponent ?? 0
                        XCTAssertLessThan(edge, center - 0.05)
                    }
                    XCTAssertEqual(paintedRows[paintedRows.count / 2].count, width)
                }
            }
        }
    }

    func testTimelineReusesWorkStyleWithoutReplacingIntentOrShrinkingContent() throws {
        _ = NSApplication.shared
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: NSTableView())
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 200),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = scroll
        defer { window.contentView = nil; window.orderOut(nil) }
        scroll.documentView = NSView(frame: .init(x: 0, y: 0, width: 300, height: 3000))
        let thumb = try XCTUnwrap(scroll.verticalScroller as? TimelineIntentScroller)
        WorkNavigationScrollStyle.configure(scroll)
        XCTAssertTrue(scroll.verticalScroller === thumb)
        XCTAssertTrue(scroll.autohidesScrollers)
        XCTAssertEqual(thumb.controlSize, .small)
        XCTAssertEqual(scroll.scrollerInsets.right, WorkNavigationScrollStyle.trailingClearance)
        for width in [220.0, 400.0, 284.0] {
            window.setContentSize(.init(width: width, height: 200))
            scroll.layoutSubtreeIfNeeded()
            scroll.tile()
            XCTAssertEqual(scroll.contentView.frame.width, width, accuracy: 0.5)
            XCTAssertEqual(thumb.frame.maxX, width - WorkNavigationScrollStyle.trailingClearance, accuracy: 0.5)
            let knob = thumb.rect(for: .knob)
            if knob.width > 0 {
                XCTAssertGreaterThan(knob.minX, thumb.bounds.minX)
                XCTAssertLessThan(knob.maxX, thumb.bounds.maxX)
            }
        }
    }

    func testNativeThumbDragStillMovesTheDocument() throws {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 200),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let scroll = WorkOutlineScrollView(frame: .init(x: 0, y: 0, width: 300, height: 200))
        scroll.documentView = NSView(frame: .init(x: 0, y: 0, width: 300, height: 3000))
        WorkNavigationScrollStyle.configure(scroll)
        window.contentView = scroll
        window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        scroll.layoutSubtreeIfNeeded()
        scroll.contentView.scroll(to: .init(x: 0, y: 1000))
        scroll.reflectScrolledClipView(scroll.contentView)
        scroll.flashScrollers()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
        let thumb = try XCTUnwrap(scroll.verticalScroller)
        let knob = thumb.rect(for: .knob)
        let start = thumb.convert(NSPoint(x: knob.midX, y: knob.midY), to: nil)
        let end = NSPoint(x: start.x, y: start.y + 30)
        func event(_ type: NSEvent.EventType, _ point: NSPoint) throws -> NSEvent {
            try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
        }
        let before = scroll.contentView.bounds.origin.y
        // Queue only into this test application's native tracking loop.
        NSApp.postEvent(try event(.leftMouseUp, end), atStart: true)
        NSApp.postEvent(try event(.leftMouseDragged, end), atStart: true)
        thumb.mouseDown(with: try event(.leftMouseDown, start))
        XCTAssertGreaterThan(abs(scroll.contentView.bounds.origin.y - before), 10)
    }

    func testWorkKeepsOverlayWhenSystemRequestsLegacyStyle() throws {
        let scroll = WorkOutlineScrollView(frame: .init(x: 0, y: 0, width: 300, height: 180))
        scroll.hasVerticalScroller = true
        scroll.verticalScroller = WorkOutlineThinScroller()
        scroll.documentView = NSView(frame: .init(x: 0, y: 0, width: 300, height: 1200))
        for style in [NSScroller.Style.legacy, .overlay, .legacy] {
            scroll.scrollerStyle = style
            scroll.tile()
            XCTAssertEqual(scroll.scrollerStyle, .overlay)
            XCTAssertEqual(scroll.verticalScroller?.scrollerStyle, .overlay)
            XCTAssertEqual(scroll.contentView.frame.width, 300, accuracy: 0.5)
        }
    }

    func testTrackDrawingLeavesEveryPixelTransparentEvenWhenHighlighted() throws {
        let scroller = WorkOutlineThinScroller(frame: .init(x: 0, y: 0, width: 16, height: 180))
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 16, pixelsHigh: 180,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 64, bitsPerPixel: 32))
        let pixels = try XCTUnwrap(bitmap.bitmapData)
        memset(pixels, 0, bitmap.bytesPerRow * bitmap.pixelsHigh)
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current = try XCTUnwrap(NSGraphicsContext(bitmapImageRep: bitmap))
        for highlighted in [false, true] {
            scroller.drawKnobSlot(in: scroller.bounds, highlight: highlighted)
            XCTAssertTrue((0..<(bitmap.bytesPerRow * bitmap.pixelsHigh)).allSatisfy { pixels[$0] == 0 })
        }
    }

    func testNativeKnobFadesAfterFlashWithoutChangingItsGeometry() throws {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 180),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let scroll = WorkOutlineScrollView(frame: .init(x: 0, y: 0, width: 300, height: 180))
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        let scroller = WorkOutlineThinScroller()
        scroll.verticalScroller = scroller
        scroll.documentView = NSView(frame: .init(x: 0, y: 0, width: 300, height: 1200))
        WorkNavigationScrollStyle.configure(scroll)
        window.contentView = scroll
        window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        scroll.layoutSubtreeIfNeeded()
        let frame = scroller.frame
        func peakAlpha() throws -> Int {
            let rep = try XCTUnwrap(scroller.bitmapImageRepForCachingDisplay(in: scroller.bounds))
            scroller.cacheDisplay(in: scroller.bounds, to: rep)
            var peak = 0
            for y in 0..<rep.pixelsHigh {
                for x in 0..<rep.pixelsWide {
                    peak = max(peak, Int((rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) * 255))
                }
            }
            if peak > 10 {
                let left = (0..<rep.pixelsHigh).map { rep.colorAt(x: 0, y: $0)?.alphaComponent ?? 0 }.max() ?? 0
                let right = (0..<rep.pixelsHigh).map { rep.colorAt(x: rep.pixelsWide - 1, y: $0)?.alphaComponent ?? 0 }.max() ?? 0
                XCTAssertLessThan(left, 0.05, "The painted knob must not be cut at its left edge")
                XCTAssertLessThan(right, 0.05, "The painted knob must not be cut at its right edge")
            }
            return peak
        }
        scroll.flashScrollers()
        var shown = 0
        for _ in 0..<5 {
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
            shown = max(shown, try peakAlpha())
        }
        guard shown > 10 else {
            throw XCTSkip("Native overlay did not render a visible knob in this background test window; idle fading requires visual acceptance")
        }
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 2.5))
        let hidden = try peakAlpha()
        XCTAssertLessThan(hidden, shown / 4, "The native knob must fade after activity stops")
        XCTAssertEqual(scroller.frame, frame, "Fading must not resize the scroller or the content lane")
    }
}
