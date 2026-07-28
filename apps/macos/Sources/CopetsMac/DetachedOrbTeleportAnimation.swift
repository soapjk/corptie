import CoreGraphics
import Foundation

struct DetachedOrbTeleportAnimation: Equatable, Sendable {
    let disappearDuration: TimeInterval
    let appearDuration: TimeInterval
    let settleDuration: TimeInterval
    let collapsedScale: CGFloat
    let overshootScale: CGFloat

    var totalDuration: TimeInterval {
        disappearDuration + appearDuration + settleDuration
    }

    static func configuration(reduceMotion: Bool) -> Self {
        if reduceMotion {
            return Self(
                disappearDuration: 0.08,
                appearDuration: 0.08,
                settleDuration: 0,
                collapsedScale: 1,
                overshootScale: 1
            )
        }
        return Self(
            disappearDuration: 0.12,
            appearDuration: 0.13,
            settleDuration: 0.05,
            collapsedScale: 0.78,
            overshootScale: 1.04
        )
    }
}
