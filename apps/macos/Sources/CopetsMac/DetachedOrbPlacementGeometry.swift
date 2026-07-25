import CoreGraphics

enum DetachedOrbPlacementGeometry {
    static func origin(
        visibleFrame: CGRect,
        windowSize: CGSize,
        occupiedFrames: [CGRect],
        margin: CGFloat = 16,
        spacing: CGFloat = 12
    ) -> CGPoint {
        let usableWidth = max(0, visibleFrame.width - margin * 2)
        let usableHeight = max(0, visibleFrame.height - margin * 2)
        let columnStep = windowSize.width + spacing
        let rowStep = windowSize.height + spacing
        let columnCount = max(1, Int((usableWidth + spacing) / columnStep))
        let rowCount = max(1, Int((usableHeight + spacing) / rowStep))

        for column in 0..<columnCount {
            for row in 0..<rowCount {
                let candidate = CGRect(
                    origin: CGPoint(
                        x: visibleFrame.maxX - margin - windowSize.width - CGFloat(column) * columnStep,
                        y: visibleFrame.maxY - margin - windowSize.height - CGFloat(row) * rowStep
                    ),
                    size: windowSize
                )
                if occupiedFrames.allSatisfy({ !$0.intersects(candidate) }) {
                    return candidate.origin
                }
            }
        }

        return CGPoint(
            x: visibleFrame.maxX - margin - windowSize.width,
            y: visibleFrame.maxY - margin - windowSize.height
        )
    }
}
