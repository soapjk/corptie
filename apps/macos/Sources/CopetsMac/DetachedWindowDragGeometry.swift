import CoreGraphics

enum DetachedWindowDragGeometry {
    static func windowOrigin(
        initialWindowOrigin: CGPoint,
        initialMouseScreenPoint: CGPoint,
        currentMouseScreenPoint: CGPoint
    ) -> CGPoint {
        CGPoint(
            x: initialWindowOrigin.x + currentMouseScreenPoint.x - initialMouseScreenPoint.x,
            y: initialWindowOrigin.y + currentMouseScreenPoint.y - initialMouseScreenPoint.y
        )
    }
}
