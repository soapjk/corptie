import CorptieClientCore
import SwiftUI

public struct TaskActivityIndicator: View {
    let activity: TaskSessionActivity
    let lifecycleState: String
    let label: String
    let isActive: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isVisible = false

    public init(activity: TaskSessionActivity, lifecycleState: String = "", label: String? = nil, isActive: Bool = true) {
        self.isActive = isActive
        self.activity = activity
        self.lifecycleState = lifecycleState
        self.label = label ?? activity.labelKey
    }

    private var color: Color {
        switch activity.indicatorTone(lifecycleState: lifecycleState) {
        case .connected:
            .blue
        case .green: .green
        case .orange: .orange
        case .red: .red
        case .secondary: .secondary
        }
    }

    public var body: some View {
        Group {
            if activity == .processing {
                Circle().trim(from: 0, to: 0.75)
                    .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .padding(1)
                    .rotationEffect(.degrees(animates ? 360 : 0))
                    .animation(animates ? .linear(duration: 0.8).repeatForever(autoreverses: false) : nil,
                               value: animates)
                    .onAppear { isVisible = true }
                    .onDisappear { isVisible = false }
            } else {
                Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(color)
            }
        }
            .frame(width: 12, height: 12)
            .accessibilityLabel(label)
            .help(label)
    }

    private var animates: Bool {
        isVisible && isActive && scenePhase == .active && !reduceMotion
    }

    private var symbol: String {
        switch activity {
        case .processing: "circle"
        case .waitingForInput, .paused: "pause.circle.fill"
        case .failed: "exclamationmark.circle.fill"
        case .interrupted: "stop.circle"
        case .idle: "checkmark.circle"
        case .noSession, .unknown: "circle.dashed"
        }
    }
}
