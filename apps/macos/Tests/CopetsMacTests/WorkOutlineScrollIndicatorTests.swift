import AppKit
import Testing
@testable import CorptieMac

@MainActor struct WorkOutlineScrollIndicatorTests {
    @Test func workThumbUsesNativeSmallControlMetrics() {
        let thumb = WorkOutlineThinScroller()
        #expect(thumb.controlSize == .small)
        for style in [NSScroller.Style.overlay, .legacy] {
            #expect(WorkOutlineThinScroller.scrollerWidth(for: .small, scrollerStyle: style)
                == NSScroller.scrollerWidth(for: .small, scrollerStyle: style))
        }
    }
}
