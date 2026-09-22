import Foundation

/// Provider-neutral execution state shared by desktop and device clients.
public enum SessionExecutionState: String, Sendable, CaseIterable {
    case running, blocked, complete, failed, cancelled

    public init?(executionStatus: String?) {
        switch executionStatus?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "running", "working", "processing": self = .running
        case "blocked": self = .blocked
        case "completed", "complete", "idle": self = .complete
        case "failed": self = .failed
        case "cancelled", "canceled", "interrupted": self = .cancelled
        default: return nil
        }
    }

    public var label: String {
        switch self {
        case .running: "Running"
        case .blocked: "Blocked"
        case .complete: "Complete"
        case .failed: "Failed"
        case .cancelled: "Interrupted"
        }
    }
}
