import CoreGraphics
import Testing
@testable import CorptieMac

struct CollapsibleDetailTextTests {
    @Test func detectsContentThatExceedsCollapsedHeight() {
        #expect(CollapsibleDetailTextLayout.isOverflowing(fullHeight: 120, collapsedHeight: 80))
    }

    @Test func hidesControlWhenContentFits() {
        #expect(!CollapsibleDetailTextLayout.isOverflowing(fullHeight: 80, collapsedHeight: 80))
    }

    @Test func ignoresSubpixelMeasurementNoise() {
        #expect(!CollapsibleDetailTextLayout.isOverflowing(fullHeight: 80.4, collapsedHeight: 80))
    }
}
