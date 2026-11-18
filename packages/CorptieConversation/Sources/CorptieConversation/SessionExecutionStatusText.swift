import CorptieClientCore
import SwiftUI

/// Stateless shared status element; hosts supply localization and theme overrides.
public struct SessionExecutionStatusText: View {
    public let state: SessionExecutionState
    private let label: String
    private let tint: Color?
    private let compact: Bool
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(state: SessionExecutionState, label: String? = nil, tint: Color? = nil,
                compact: Bool = false) {
        self.state = state
        self.label = label ?? state.label
        self.tint = tint
        self.compact = compact
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
        Group {
            if compact {
                Circle()
                    .fill(statusColor)
                    .frame(width: 7, height: 7)
                    .transition(.opacity.combined(with: .scale(scale: 0.6)))
                    .accessibilityLabel(label)
            } else {
                Text(label)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(statusColor)
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: compact)
    }
}
