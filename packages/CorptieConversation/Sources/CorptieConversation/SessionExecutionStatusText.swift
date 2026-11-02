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
            return .blue
        case .blocked: return .orange
        case .failed: return .red
        case .complete, .cancelled: return .secondary
        }
    }

    public var body: some View {
        Text(label)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(statusColor)
    }
}
