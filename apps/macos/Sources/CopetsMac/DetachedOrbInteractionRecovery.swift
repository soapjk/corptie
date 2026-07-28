import CoreGraphics

struct DetachedOrbPointerInteractionState: Equatable, Sendable {
    let isPointerDown: Bool
    let isPointerHovering: Bool
}

enum DetachedOrbInteractionRecovery {
    static func reconcile(
        reportedPointerDown: Bool,
        reportedPointerHovering: Bool,
        pressedMouseButtons: Int,
        mouseLocation: CGPoint,
        windowFrame: CGRect
    ) -> DetachedOrbPointerInteractionState {
        DetachedOrbPointerInteractionState(
            isPointerDown: reportedPointerDown && pressedMouseButtons & 1 != 0,
            isPointerHovering: reportedPointerHovering && windowFrame.contains(mouseLocation)
        )
    }
}
