import SwiftUI

public enum ConsoleWorkOutlineMetrics {
    public static let childIndent: CGFloat = 24
    public static let groupCornerRadius: CGFloat = 8
    public static let groupHorizontalInset: CGFloat = 6
    public static let disclosureAnimation = Animation.easeInOut(duration: 0.22)
    public static let workingGradientDuration: Double = 2.6
    public static let workingGradientFrameInterval: Double = 1.0 / 24.0
}

public enum WorkActivityAnimation {
    public static let duration = 2.6
    public static let frameInterval = 1.0 / 24.0
}
public enum ConsoleWorkFlowingGradientPolicy {
    public static func progress(at date: Date) -> CGFloat {
        let elapsed = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: WorkActivityAnimation.duration)
        return CGFloat(elapsed / WorkActivityAnimation.duration)
    }
}
/// Shared running-title treatment for Work groups and experimental Task cards.
public struct ConsoleWorkTitle: View {
    public init(title: String, isWorking: Bool, isActive: Bool = true) {
        self.title = title
        self.isWorking = isWorking
        self.isActive = isActive
    }
    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    let title: String
    let isWorking: Bool
    var isActive = true

    public var body: some View {
        if isWorking {
            ConsoleFlowingGradientWorkTitle(
                title: title,
                animates: !accessibilityReduceMotion && isActive
            )
        } else {
            Text(title)
        }
    }
}

private struct ConsoleFlowingGradientWorkTitle: View {
    let title: String
    let animates: Bool
    #if os(iOS)
    @Environment(\.scenePhase) private var scenePhase
    @State private var isVisible = false
    #endif

    @ViewBuilder
    var body: some View {
        #if os(iOS)
        // Color the glyphs directly: an overlay/mask must never be the only
        // visible copy of a title in a recycled lazy-list row.
        Text(title)
            .keyframeAnimator(initialValue: CGFloat.zero,
                              repeating: animates && isVisible && scenePhase == .active) { content, phase in
                content.foregroundStyle(LinearGradient(
                    colors: [.cyan, .blue, .purple, .pink, .orange, .cyan,
                             .blue, .purple, .pink, .orange, .cyan],
                    startPoint: UnitPoint(x: phase - 1, y: 0.5),
                    endPoint: UnitPoint(x: phase + 1, y: 0.5)))
            } keyframes: { _ in
                LinearKeyframe(CGFloat(1), duration: WorkActivityAnimation.duration)
            }
            .onAppear { isVisible = true }
            .onDisappear { isVisible = false }
        #else
        // macOS keeps the colour treatment but must not own a SwiftUI repeating
        // animation: once started it never stops, and every frame re-evaluates
        // the whole window's attribute graph and layout tree.
        Text(title)
            .foregroundStyle(staticGradient)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(title)
        #endif
    }

    private var staticGradient: LinearGradient {
        LinearGradient(
            colors: [.cyan, .blue, .purple, .pink, .orange],
            startPoint: .leading,
            endPoint: .trailing
        )
    }
}


/// An isolated, paint-only overlay: never changes button geometry or hit testing.
public struct ConsoleDiscussionActivityBorder: View {
    public init(isRunning: Bool, isActive: Bool = true) {
        self.isRunning = isRunning
        self.isActive = isActive
    }
    let isRunning: Bool
    var isActive = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isVisible = false

    public var body: some View {
        Group {
            if isRunning {
                TimelineView(.animation(
                    minimumInterval: WorkActivityAnimation.frameInterval,
                    paused: !isVisible || !isActive || reduceMotion
                )) { context in
                    let progress = reduceMotion ? 0 : ConsoleWorkFlowingGradientPolicy.progress(at: context.date)
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(AngularGradient(
                            colors: [.cyan, .blue, .purple, .pink, .orange, .cyan],
                            center: .center,
                            angle: .degrees(Double(progress) * 360)
                        ), lineWidth: 1.5)
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
    }
}
