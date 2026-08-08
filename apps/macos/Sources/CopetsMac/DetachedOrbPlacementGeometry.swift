import CoreGraphics

enum DetachedOrbPlacementRegion {
    static func rightThird(of visibleFrame: CGRect) -> CGRect {
        let width = max(0, visibleFrame.width / 3)
        return CGRect(
            x: visibleFrame.maxX - width,
            y: visibleFrame.minY,
            width: width,
            height: visibleFrame.height
        )
    }

    static func automaticPlacementFrame(in visibleFrame: CGRect) -> CGRect {
        rightThird(of: visibleFrame)
    }
}

enum DetachedOrbPlacementGeometry {
    static func origin(
        visibleFrame: CGRect,
        windowSize: CGSize,
        occupiedFrames: [CGRect],
        margin: CGFloat = 16,
        spacing: CGFloat = 12
    ) -> CGPoint {
        let placementFrame = DetachedOrbPlacementRegion.rightThird(of: visibleFrame)
        let usableWidth = max(0, placementFrame.width - margin * 2)
        let usableHeight = max(0, placementFrame.height - margin * 2)
        let columnStep = windowSize.width + spacing
        let rowStep = windowSize.height + spacing
        let columnCount = max(1, Int((usableWidth + spacing) / columnStep))
        let rowCount = max(1, Int((usableHeight + spacing) / rowStep))

        for column in 0..<columnCount {
            for row in 0..<rowCount {
                let candidate = CGRect(
                    origin: CGPoint(
                        x: placementFrame.maxX - margin - windowSize.width - CGFloat(column) * columnStep,
                        y: placementFrame.maxY - margin - windowSize.height - CGFloat(row) * rowStep
                    ),
                    size: windowSize
                )
                if occupiedFrames.allSatisfy({ !$0.intersects(candidate) }) {
                    return candidate.origin
                }
            }
        }

        return CGPoint(
            x: placementFrame.maxX - margin - windowSize.width,
            y: placementFrame.maxY - margin - windowSize.height
        )
    }
}
