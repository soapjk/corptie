import SwiftUI

/// Execution state is distinct from connection readiness. Blue is active,
/// orange awaits input, red failed, and neutral states no longer imply a warning.
struct SessionStatusLight: View {
    let status: TaskStatus
    let diameter: CGFloat

    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: diameter, height: diameter)
            .shadow(color: color.opacity(0.45), radius: diameter * 0.55)
            .opacity(isBreathing ? breathOpacity : 1.0)
            .animation(
                accessibilityReduceMotion ? nil : .easeInOut(duration: 1.4).repeatForever(autoreverses: true),
                value: breathPhase
            )
            .onAppear { startBreathingIfNeeded() }
            .onChange(of: status) { _, _ in startBreathingIfNeeded() }
    }

    private var isBreathing: Bool {
        status == .running
    }

    private var color: Color {
        switch status {
        case .running:
            .blue
        case .failed:
            .red
        case .blocked:
            .orange
        case .complete, .cancelled:
            .secondary
        }
    }

    @State private var breathPhase = false
    private var breathOpacity: Double { breathPhase ? 0.35 : 1.0 }

    private func startBreathingIfNeeded() {
        guard isBreathing, !accessibilityReduceMotion else {
            breathPhase = false
            return
        }
        breathPhase = false
        DispatchQueue.main.async {
            guard self.isBreathing else { return }
            breathPhase = true
        }
    }
}
