import Foundation

/// Execution of the Session bound to a Task; distinct from the Task lifecycle.
public enum TaskSessionActivity: String, Equatable, Sendable, CaseIterable {
    case noSession, processing, waitingForInput, idle, paused, interrupted, failed, unknown

    public static func resolve(hasBinding: Bool, sessionExecutionStatus: String?,
                               taskExecutionStatus: String?) -> Self {
        guard hasBinding else { return .noSession }
        let raw = sessionExecutionStatus ?? taskExecutionStatus
        if raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "paused" { return .paused }
        switch SessionExecutionState(executionStatus: raw) {
        case .running: return .processing
        case .blocked: return .waitingForInput
        case .complete: return .idle
        case .cancelled: return .interrupted
        case .failed: return .failed
        case nil: return .unknown
        }
    }

    public var labelKey: String {
        switch self {
        case .noSession: "No Session"
        case .processing: "Processing"
        case .waitingForInput: "Waiting for Input"
        case .idle: "Idle"
        case .paused: "Paused"
        case .interrupted: "Interrupted"
        case .failed: "Failed"
        case .unknown: "Unknown"
        }
    }

    public enum IndicatorTone: Sendable { case connected, green, orange, red, secondary }

    /// Retain the desktop lifecycle fallback only when no runtime state is known.
    public func indicatorTone(lifecycleState: String = "") -> IndicatorTone {
        switch self {
        case .processing: return .connected
        case .waitingForInput, .paused, .idle: return .orange
        case .interrupted, .failed: return .red
        case .noSession, .unknown:
            switch lifecycleState.lowercased() {
            case "completed", "complete": return .green
            case "blocked", "failed": return .red
            case "running", "in_progress", "active": return .connected
            default: return .secondary
            }
        }
    }
}
