import Foundation

/// Provider-neutral, versioned checklist delivered with a timeline item.
public struct ConversationExecutionPlan: Decodable, Sendable, Hashable {
    public struct Step: Decodable, Sendable, Hashable, Identifiable {
        public let stepId: String
        public let ordinal: Int
        public let text: String
        public let status: String
        public var id: String { stepId }

        public var marker: String {
            switch status {
            case "completed": "✓"
            case "inProgress": "●"
            case "failed": "!"
            case "cancelled": "■"
            default: "○"
            }
        }
    }

    public let schemaVersion: Int
    public let planId: String
    public let revision: Int
    public let lifecycle: String
    public let explanation: String?
    public let steps: [Step]
    public let updatedAt: String

    public var progressLabel: String {
        guard !steps.isEmpty else { return "No plan steps" }
        return "Plan \(steps.filter { $0.status == "completed" }.count)/\(steps.count)"
    }

    /// Unknown means the latest update could not be confirmed. Its retained
    /// steps may be stale, so they must not drive a current progress bar.
    public var completionFraction: Double? {
        guard lifecycle != "unknown", !steps.isEmpty else { return nil }
        return Double(steps.filter { $0.status == "completed" }.count) / Double(steps.count)
    }
}

/// Provider-neutral, bounded input/result summary for one stable tool item.
public struct ConversationToolExecution: Decodable, Sendable, Hashable {
    public let schemaVersion: Int
    public let toolId: String
    public let name: String
    public let status: String
    public let input: String?
    public let result: String?
}

/// Read-only file-change summary; actions remain separate Provider capabilities.
public struct ConversationChangeSet: Decodable, Sendable, Hashable {
    public struct Change: Decodable, Sendable, Hashable, Identifiable {
        public let path: String
        public let kind: String
        public let diffPreview: String?
        public let diffTruncated: Bool
        public var id: String { path }

        public var marker: String {
            switch kind {
            case "add": "+"
            case "delete": "−"
            default: "•"
            }
        }
    }

    public let schemaVersion: Int
    public let truncated: Bool
    public let changes: [Change]
}

/// Provider-neutral questions and their accepted answers, shown in the
/// original conversation card just like other user-visible conversation data.
public struct ConversationUserInput: Decodable, Sendable, Hashable {
    public struct Option: Decodable, Sendable, Hashable {
        public let label: String
        public let description: String
    }

    public struct Question: Decodable, Sendable, Hashable, Identifiable {
        public let id: String
        public let header: String
        public let question: String
        public let isOther: Bool
        public let isSecret: Bool
        public let options: [Option]?
        public let selectionMode: String?
        public let required: Bool?
    }

    public let schemaVersion: Int
    public let isBlocking: Bool
    public let questions: [Question]
    public let kind: String?
    public let responseMode: String?
    public let canCancel: Bool?
    public let url: String?
    public let selectedOptions: [String: [String]]?
    public let submittedAnswers: [String: [String]]?

    public func answers(selected: [String: Set<String>], typed: [String: String]) -> [String: [String]]? {
        var result: [String: [String]] = [:]
        for question in questions {
            let entered = (typed[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            var values = question.options?.compactMap { selected[question.id, default: []].contains($0.label) ? $0.label : nil } ?? []
            if !entered.isEmpty && (question.options == nil || question.isOther) {
                if question.selectionMode == "single" { values = [] }
                values.append(entered)
            }
            guard (question.required == false || !values.isEmpty), values.count <= 12,
                  question.selectionMode != "single" || values.count <= 1,
                  values.allSatisfy({ $0.count <= 4_000 }) else { return nil }
            result[question.id] = values
        }
        return result
    }
}

public protocol ConversationExecutionItem: ConversationTimelineItem {
    var executionTitle: String { get }
    var status: String? { get }
    var executionPlan: ConversationExecutionPlan? { get }
    var toolExecution: ConversationToolExecution? { get }
    var changeSet: ConversationChangeSet? { get }
}

public extension ConversationExecutionItem {
    var executionPlan: ConversationExecutionPlan? { nil }
    var toolExecution: ConversationToolExecution? { nil }
    var changeSet: ConversationChangeSet? { nil }
}

public struct ConversationExecutionStep: Identifiable, Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        case context
        case action
        case result

        public var label: String {
            switch self {
            case .context: "Execution Context"
            case .action: "Execution Action"
            case .result: "Execution Result"
            }
        }
    }

    public enum State: Hashable, Sendable {
        case running
        case completed
        case failed
        case cancelled
        case unknown

        public var marker: String {
            switch self {
            case .running: "●"
            case .completed: "✓"
            case .failed: "!"
            case .cancelled: "■"
            case .unknown: "?"
            }
        }
    }

    public let id: String
    public let kind: Kind
    public let state: State
    public let title: String
    public let detail: String?
    public let plan: ConversationExecutionPlan?
    public let tool: ConversationToolExecution?
    public let changeSet: ConversationChangeSet?
    public init(id: String, kind: Kind, state: State, title: String, detail: String?,
                plan: ConversationExecutionPlan? = nil, tool: ConversationToolExecution? = nil,
                changeSet: ConversationChangeSet? = nil) {
        self.id = id; self.kind = kind; self.state = state; self.title = title
        self.detail = detail; self.plan = plan; self.tool = tool; self.changeSet = changeSet
    }
}

public enum ConversationExecutionProjection {
    public static let detailCharacterLimit = 180
    public static let detailLineLimit = 2

    public static func steps<Item: ConversationExecutionItem>(for items: [Item]) -> [ConversationExecutionStep] {
        let runningTurn = items.last.map { isRunningTurnStatus($0.timelineTurnStatus) } ?? false
        return items.enumerated().map { index, item in
            let sourceTitle = item.executionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            return ConversationExecutionStep(
                id: item.id,
                kind: kind(item.type),
                state: state(item, isLatest: index == items.indices.last, runningTurn: runningTurn),
                title: title(for: item),
                detail: item.executionPlan?.schemaVersion == 1 || item.toolExecution?.schemaVersion == 1
                    ? nil : detailPreview(item.text, excludingTitle: sourceTitle),
                plan: item.executionPlan?.schemaVersion == 1 ? item.executionPlan : nil,
                tool: item.toolExecution?.schemaVersion == 1 ? item.toolExecution : nil,
                changeSet: item.changeSet?.schemaVersion == 1 ? item.changeSet : nil
            )
        }
    }

    public static func title<Item: ConversationExecutionItem>(for item: Item) -> String {
        if item.type == "executionPlan", let plan = item.executionPlan, plan.schemaVersion == 1 {
            if plan.lifecycle == "unknown" { return "Plan update unavailable" }
            return plan.progressLabel
        }
        if item.type == "contextCompaction" {
            return "Context compacted"
        }
        if item.type == "sleep" {
            return "Waited"
        }
        if item.type == "imageView" {
            return "Viewed image"
        }
        let title = item.executionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? typeTitle(item.type) : title
    }

    public static func plainText(for steps: [ConversationExecutionStep]) -> String {
        steps.map { step in
            ["\(step.state.marker) [\(step.kind.label)] \(step.title)", step.detail,
             step.tool.map { tool in
                 [tool.input.map { "Input: \($0)" }, tool.result.map { "Result: \($0)" }]
                     .compactMap { $0 }.joined(separator: "\n")
             },
             step.changeSet.map { changeSet in
                 changeSet.changes.map { "\($0.marker) \($0.path)" }.joined(separator: "\n")
             },
             step.plan.map { plan in
                 ([plan.explanation].compactMap { $0 }
                     + plan.steps.map { "\($0.marker) \($0.text)" }).joined(separator: "\n")
             }]
                .compactMap { $0 }
                .joined(separator: "\n")
        }
        .joined(separator: "\n\n")
    }

    private static func kind(_ type: String) -> ConversationExecutionStep.Kind {
        switch type {
        case "reasoning", "plan", "executionPlan", "agentMessage", "contextCompaction": .context
        case "warning": .result
        default: .action
        }
    }

    private static func state<Item: ConversationExecutionItem>(
        _ item: Item,
        isLatest: Bool,
        runningTurn: Bool
    ) -> ConversationExecutionStep.State {
        let status = normalized(item.status ?? "")
        switch status {
        case "completed", "complete", "success", "succeeded": return .completed
        case "failed", "error": return .failed
        case "cancelled", "canceled", "interrupted": return .cancelled
        case "unknown", "uncertain": return .unknown
        case "running", "inprogress", "in_progress", "started":
            // An unfinished item left by a settled Turn must not keep the
            // execution card animating indefinitely. Completion of the Turn
            // alone does not prove this individual tool succeeded.
            switch normalized(item.timelineTurnStatus) {
            case "completed", "complete": return .unknown
            case "failed", "error": return .failed
            case "cancelled", "canceled", "interrupted": return .cancelled
            default: return .running
            }
        default: break
        }
        if item.type == "warning" { return .failed }
        return isLatest && runningTurn ? .running : .completed
    }

    private static func detailPreview(_ text: String, excludingTitle title: String) -> String? {
        let boundedText = text.prefix(detailCharacterLimit * 2)
        let candidates = boundedText.split(
            separator: "\n",
            maxSplits: detailLineLimit + 1,
            omittingEmptySubsequences: true
        )
        var lines: [String] = []
        lines.reserveCapacity(detailLineLimit + 1)
        for candidate in candidates {
            let line = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            if !line.isEmpty { lines.append(line) }
        }
        if let first = lines.first,
           !title.isEmpty,
           first == title || first.hasPrefix(title + ":") {
            lines.removeFirst()
        }
        guard !lines.isEmpty else { return nil }
        var preview = lines.prefix(detailLineLimit).joined(separator: " · ")
        if preview.count > detailCharacterLimit {
            preview = String(preview.prefix(detailCharacterLimit - 1)) + "…"
        } else if lines.count > detailLineLimit || boundedText.endIndex != text.endIndex {
            preview += "…"
        }
        return preview
    }

    private static func typeTitle(_ type: String) -> String {
        switch type {
        case "commandExecution": "Ran command"
        case "fileChange": "Changed files"
        case "webSearch": "Searched the web"
        case "mcpToolCall", "dynamicToolCall": "Used tool"
        case "collabAgentToolCall", "collabToolCall": "Collaborated with agent"
        case "functionCallOutput": "Received tool result"
        case "enteredReviewMode": "Entered review mode"
        case "exitedReviewMode": "Exited review mode"
        case "reasoning": "Reasoned"
        case "plan", "executionPlan": "Updated plan"
        case "warning": "Warning"
        case "agentMessage": "Progress update"
        case "contextCompaction": "Context compacted"
        default: "Execution step"
        }
    }

    private static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func isRunningTurnStatus(_ value: String) -> Bool {
        switch normalized(value) {
        case "completed", "complete", "failed", "error", "cancelled", "canceled", "interrupted": false
        default: true
        }
    }
}
