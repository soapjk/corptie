import Foundation

public enum ConversationProcessState: Hashable, Sendable {
        case running
        case completed
        case failed
        case cancelled

    public var symbolName: String {
            switch self {
            case .running: "ellipsis.circle"
            case .completed: "checkmark.circle.fill"
            case .failed: "exclamationmark.circle.fill"
            case .cancelled: "stop.circle.fill"
            }
        }

}

public struct ConversationProcessPresentation: Sendable {
    public let state: ConversationProcessState
    public let count: Int
    public let duration: String?
    public let currentStepTitle: String?
    public init(state: ConversationProcessState, count: Int, duration: String? = nil, currentStepTitle: String? = nil) {
        self.state = state; self.count = count; self.duration = duration; self.currentStepTitle = currentStepTitle
    }
    public var summary: String {
        let steps = "\(count) \(count == 1 ? "step" : "steps")"
        let normalizedDuration = duration?
            .replacingOccurrences(of: "·", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        switch state {
        case .running:
            let currentStep = currentStepTitle.map { " · \($0)" } ?? ""
            if let normalizedDuration, !normalizedDuration.isEmpty {
                return "Working for \(normalizedDuration)\(currentStep) · \(steps)"
            }
            return "Working\(currentStep)… · \(steps)"
        case .completed:
            if let normalizedDuration, !normalizedDuration.isEmpty {
                return "Worked for \(normalizedDuration) · \(steps)"
            }
            return "Completed · \(steps)"
        case .failed:
            if let normalizedDuration, !normalizedDuration.isEmpty {
                return "Execution failed after \(normalizedDuration) · \(steps)"
            }
            return "Execution failed · \(steps)"
        case .cancelled:
            if let normalizedDuration, !normalizedDuration.isEmpty {
                return "Execution stopped after \(normalizedDuration) · \(steps)"
            }
            return "Execution stopped · \(steps)"
        }
    }
public static func state<Item: ConversationTimelineItem>(for items: [Item]) -> ConversationProcessState {
    guard let status = items.lazy
        .map({ $0.timelineTurnStatus.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() })
        .last(where: { !$0.isEmpty }) else {
        return .completed
    }

    switch status {
    case "failed", "error":
        return .failed
    case "cancelled", "canceled", "interrupted":
        return .cancelled
    case "completed", "complete":
        return .completed
    default:
        return .running
    }
}
}

