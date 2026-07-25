import CoreGraphics
import Foundation

enum SessionReorderLayout {
    static func sessionId(
        at point: CGPoint,
        using frames: [String: CGRect],
        eligibleIds: Set<String>
    ) -> String? {
        frames
            .lazy
            .filter { id, frame in
                eligibleIds.contains(id) && frame.contains(point)
            }
            .sorted { lhs, rhs in
                if lhs.value.minY == rhs.value.minY {
                    return lhs.key < rhs.key
                }
                return lhs.value.minY < rhs.value.minY
            }
            .first?
            .key
    }

    static func draggedTopY(initialTopY: CGFloat, mouseDeltaY: CGFloat) -> CGFloat {
        initialTopY + mouseDeltaY
    }

    static func draggedCenterY(
        initialCenterY: CGFloat,
        mouseDeltaY: CGFloat
    ) -> CGFloat {
        initialCenterY + mouseDeltaY
    }

    static func insertionTargetSessionId(
        forDraggedCenterY centerY: CGFloat,
        excluding draggedId: String,
        using frames: [String: CGRect],
        eligibleIds: Set<String>
    ) -> String? {
        frames
            .lazy
            .filter { id, _ in
                id != draggedId && eligibleIds.contains(id)
            }
            .sorted { lhs, rhs in
                if lhs.value.minY == rhs.value.minY {
                    return lhs.key < rhs.key
                }
                return lhs.value.minY < rhs.value.minY
            }
            .first { _, frame in
                centerY < frame.midY
            }?
            .key
    }
}
