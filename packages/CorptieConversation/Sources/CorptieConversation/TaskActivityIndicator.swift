import CorptieClientCore
import SwiftUI

public struct TaskActivityIndicator: View {
    let activity: TaskSessionActivity
    let lifecycleState: String
    let label: String
    @Environment(\.colorScheme) private var colorScheme

    public init(activity: TaskSessionActivity, lifecycleState: String = "", label: String? = nil) {
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
        Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
            .foregroundStyle(color).frame(width: 12, height: 12)
            .accessibilityLabel(label)
            .help(label)
    }

    private var symbol: String {
        switch activity {
        case .processing: "arrow.triangle.2.circlepath"
        case .waitingForInput, .paused: "pause.circle.fill"
        case .failed: "exclamationmark.circle.fill"
        case .interrupted: "stop.circle"
        case .idle: "checkmark.circle"
        case .noSession, .unknown: "circle.dashed"
        }
    }
}
