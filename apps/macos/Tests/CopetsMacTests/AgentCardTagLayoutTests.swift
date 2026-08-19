import CoreGraphics
import Testing
@testable import CorptieMac

@Suite("Agent card capped tag layout")
struct AgentCardTagLayoutTests {
    private let indicator = CGSize(width: 26, height: 20)

    @Test("Many tags stay within two rows and expose the overflow control")
    func manyTagsAreCapped() {
        let result = layout(width: 232, widths: Array(repeating: 70, count: 20))

        #expect(result.isOverflowing)
        #expect(result.visibleItemCount < 20)
        #expect(allFrames(result).allSatisfy { $0.maxX <= 232 && $0.maxY <= CappedFlowLayout.regionHeight })
    }

    @Test("A long tag is truncated and exposes the full-tags control")
    func longTagIsTruncated() {
        let result = layout(width: 232, widths: [600])

        #expect(result.isOverflowing)
        #expect(result.visibleItemCount == 1)
        #expect(result.itemFrames[0]?.width == 232)
        #expect(result.overflowFrame != nil)
    }

    @Test("Tags that fit do not show a false overflow control")
    func fittingTagsRemainUnchanged() {
        let result = layout(width: 392, widths: [52, 64, 48])

        #expect(!result.isOverflowing)
        #expect(result.visibleItemCount == 3)
    }

    @Test("Desktop and mobile card widths remain bounded", arguments: [172.0, 232.0, 292.0, 392.0])
    func responsiveWidths(width: Double) {
        let result = layout(width: CGFloat(width), widths: [96, 82, 120, 74, 180, 68, 130, 92])

        #expect(result.isOverflowing)
        #expect(allFrames(result).allSatisfy {
            $0.minX >= 0 && $0.maxX <= CGFloat(width) && $0.minY >= 0 && $0.maxY <= CappedFlowLayout.regionHeight
        })
    }

    private func layout(width: CGFloat, widths: [CGFloat]) -> CappedFlowLayoutResult {
        CappedFlowLayoutEngine.layout(
            itemSizes: widths.map { CGSize(width: $0, height: 20) },
            overflowSize: indicator,
            availableWidth: width,
            maxRows: 2,
            spacing: 6
        )
    }

    private func allFrames(_ result: CappedFlowLayoutResult) -> [CGRect] {
        result.itemFrames.compactMap { $0 } + [result.overflowFrame].compactMap { $0 }
    }
}
