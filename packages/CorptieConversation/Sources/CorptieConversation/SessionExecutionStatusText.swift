import CorptieClientCore
import SwiftUI

/// Stateless shared status element; hosts supply localization and theme overrides.
public struct SessionExecutionStatusText: View {
    public let state: SessionExecutionState
    private let label: String
    private let tint: Color?
    @Environment(\.colorScheme) private var colorScheme

    public init(state: SessionExecutionState, label: String? = nil, tint: Color? = nil) {
        self.state = state
        self.label = label ?? state.label
        self.tint = tint
    }

    private var statusColor: Color {
        if let tint { return tint }
        switch state {
        case .running:
            return colorScheme == .dark
                ? Color(red: 0.62, green: 0.82, blue: 0.66)
                : Color(red: 0.08, green: 0.70, blue: 0.34)
        case .blocked, .complete: return .orange
        case .failed, .cancelled: return .red
        }
    }

    public var body: some View {
        Text(label)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(statusColor)
    }
}
