import Foundation

/// Geometry of the owned native scroll view, not a SwiftUI lazy-stack estimate.
struct PadNativeTimelineGeometry: Equatable {
    let contentHeight: CGFloat
    let viewportHeight: CGFloat
    let topInset: CGFloat
    let bottomInset: CGFloat
    let offset: CGFloat

    var minimum: CGFloat { -topInset }
    var maximum: CGFloat { max(minimum, contentHeight - viewportHeight + bottomInset) }
    var remaining: CGFloat { max(0, maximum - min(maximum, max(minimum, offset))) }
    var isAtBottom: Bool { viewportHeight > 0 && remaining <= 0.5 }
    static func keyboardIntersectsWindow(frame: CGRect, bounds: CGRect) -> Bool {
        let intersection = bounds.intersection(frame)
        return !intersection.isNull && intersection.height > 1
    }
    func showsJump(hasMessages: Bool, keyboardVisible: Bool, keyboardChanging: Bool) -> Bool {
        hasMessages && viewportHeight > 0 && !keyboardVisible && !keyboardChanging && !isAtBottom
    }
}
