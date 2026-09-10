import SwiftUI

/// An isolated, paint-only overlay: never changes button geometry or hit testing.
struct ConsoleDiscussionActivityBorder: View {
    let isRunning: Bool
    var isActive = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isVisible = false

    var body: some View {
        Group {
            if isRunning {
                TimelineView(.animation(
                    minimumInterval: ConsoleWorkOutlineMetrics.workingGradientFrameInterval,
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
