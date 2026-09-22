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
            colorScheme == .dark ? Color(red: 0.62, green: 0.82, blue: 0.66)
                : Color(red: 0.08, green: 0.70, blue: 0.34)
        case .green: .green
        case .orange: .orange
        case .red: .red
        case .secondary: .secondary
        }
    }

    public var body: some View {
        Circle().fill(color).frame(width: 7, height: 7)
            .accessibilityLabel(label)
    }
}
