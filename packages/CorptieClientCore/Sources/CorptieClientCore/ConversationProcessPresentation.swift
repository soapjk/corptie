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
    public var summary: String { summary(languageCode: "en") }

    public func summary(languageCode: String) -> String {
        let chinese = languageCode.lowercased().hasPrefix("zh")
        let steps = chinese ? "\(count) 步" : "\(count) \(count == 1 ? "step" : "steps")"
        let normalizedDuration = duration?
            .replacingOccurrences(of: "·", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let displayedDuration = normalizedDuration.map { value in
            chinese ? value.replacingOccurrences(of: "h", with: "小时")
                .replacingOccurrences(of: "m", with: "分钟")
                .replacingOccurrences(of: "s", with: "秒") : value
        }
        switch state {
        case .running:
            let currentStep = currentStepTitle.map { " · \($0)" } ?? ""
            if let displayedDuration, !displayedDuration.isEmpty {
                return chinese ? "处理中 \(displayedDuration)\(currentStep) · \(steps)"
                    : "Working for \(displayedDuration)\(currentStep) · \(steps)"
            }
            return chinese ? "处理中\(currentStep)… · \(steps)" : "Working\(currentStep)… · \(steps)"
        case .completed:
            if let displayedDuration, !displayedDuration.isEmpty {
                return chinese ? "已处理 \(displayedDuration) · \(steps)" : "Processed for \(displayedDuration) · \(steps)"
            }
            return chinese ? "已处理 · \(steps)" : "Completed · \(steps)"
        case .failed:
            if let displayedDuration, !displayedDuration.isEmpty {
                return chinese ? "处理失败，耗时 \(displayedDuration) · \(steps)"
                    : "Execution failed after \(displayedDuration) · \(steps)"
            }
            return chinese ? "处理失败 · \(steps)" : "Execution failed · \(steps)"
        case .cancelled:
            if let displayedDuration, !displayedDuration.isEmpty {
                return chinese ? "已停止处理，耗时 \(displayedDuration) · \(steps)"
                    : "Execution stopped after \(displayedDuration) · \(steps)"
            }
            return chinese ? "已停止处理 · \(steps)" : "Execution stopped · \(steps)"
        }
    }
public static func state<Item: ConversationTimelineItem>(for items: [Item]) -> ConversationProcessState {
    if let first = items.first, first.processEndedAt != nil {
        guard let status = items.lazy
            .map({ $0.timelineTurnStatus.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() })
            .last(where: { !$0.isEmpty }) else {
            return .completed
        }
        if status == "failed" || status == "error" { return .failed }
        if status == "cancelled" || status == "canceled" || status == "interrupted" { return .cancelled }
        return .completed
    }

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
