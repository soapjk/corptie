import Foundation

public protocol ConversationExecutionItem: ConversationTimelineItem {
    var executionTitle: String { get }
    var status: String? { get }
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

        public var marker: String {
            switch self {
            case .running: "●"
            case .completed: "✓"
            case .failed: "!"
            case .cancelled: "■"
            }
        }
    }

    public let id: String
    public let kind: Kind
    public let state: State
    public let title: String
    public let detail: String?
    public init(id: String, kind: Kind, state: State, title: String, detail: String?) {
        self.id = id; self.kind = kind; self.state = state; self.title = title; self.detail = detail
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
                detail: detailPreview(item.text, excludingTitle: sourceTitle)
            )
        }
    }

    public static func title<Item: ConversationExecutionItem>(for item: Item) -> String {
        if item.type == "contextCompaction" {
            return "Context compacted"
        }
        let title = item.executionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? typeTitle(item.type) : title
    }

    public static func plainText(for steps: [ConversationExecutionStep]) -> String {
        steps.map { step in
            ["\(step.state.marker) [\(step.kind.label)] \(step.title)", step.detail]
                .compactMap { $0 }
                .joined(separator: "\n")
        }
        .joined(separator: "\n\n")
    }

    private static func kind(_ type: String) -> ConversationExecutionStep.Kind {
        switch type {
        case "reasoning", "plan", "agentMessage", "contextCompaction": .context
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
        case "failed", "error": return .failed
        case "cancelled", "canceled", "interrupted": return .cancelled
        case "running", "inprogress", "in_progress", "started": return .running
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
        case "reasoning": "Reasoned"
        case "plan": "Updated plan"
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

