import CoreGraphics

enum DetachedOrbObservationGeometry {
    static func searchRect(
        around orbFrame: CGRect,
        visibleFrame: CGRect,
        radius: CGFloat = 360
    ) -> CGRect? {
        clippedRect(
            orbFrame.insetBy(dx: -radius, dy: -radius),
            to: visibleFrame
        )
    }

    static func sourceRect(
        for appKitRect: CGRect,
        in screenFrame: CGRect
    ) -> CGRect? {
        guard let clipped = clippedRect(appKitRect, to: screenFrame) else {
            return nil
        }

        return CGRect(
            x: clipped.minX - screenFrame.minX,
            y: screenFrame.maxY - clipped.maxY,
            width: clipped.width,
            height: clipped.height
        )
    }

    private static func clippedRect(_ rect: CGRect, to bounds: CGRect) -> CGRect? {
        let clipped = rect.intersection(bounds)
        guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else {
            return nil
        }
        return clipped
    }
}
