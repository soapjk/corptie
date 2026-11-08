import AppKit
import XCTest
@testable import CorptieMac

@MainActor
final class WorkOutlineScrollerBehaviorTests: XCTestCase {
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
