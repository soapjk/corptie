import Foundation
import CorptieClientCore

/// Bounded inline text for structured tool and file-change items. The complete
/// backend-sanitized payload remains accessible on demand without inflating a
/// message row or discarding the authoritative execution step.
public struct ExecutionStepDetailPresentation: Sendable {
    public static let inlineCharacterLimit = 480

    public let displayedStep: ConversationExecutionStep
    public let hasOverflow: Bool

    public init(step: ConversationExecutionStep) {
        let toolLength = (step.tool?.input?.count ?? 0) + (step.tool?.result?.count ?? 0)
        let changeLength = step.changeSet?.changes.reduce(0) {
            $0 + $1.path.count + ($1.diffPreview?.count ?? 0)
        } ?? 0
        guard toolLength + changeLength > Self.inlineCharacterLimit else {
            displayedStep = step
            hasOverflow = false
            return
        }

        let toolPreview = [
            step.tool?.input.map { "输入：\(Self.preview($0))" },
            step.tool?.result.map { "结果：\(Self.preview($0))" }
        ].compactMap { $0 }
        let changesPreview = step.changeSet.map { changeSet in
            let paths = changeSet.changes.prefix(3).map {
                "\($0.marker) \(Self.preview($0.path))"
            }
            return (["\(changeSet.changes.count) 个文件变更"] + paths
                + (changeSet.changes.count > 3 ? ["…"] : [])).joined(separator: "\n")
        }
        let summary = ([step.detail].compactMap { $0 } + toolPreview
            + [changesPreview].compactMap { $0 })
            .filter { !$0.isEmpty }.joined(separator: "\n")
        displayedStep = ConversationExecutionStep(id: step.id, kind: step.kind,
            state: step.state, title: step.title, detail: summary,
            plan: step.plan, tool: nil, changeSet: nil)
        hasOverflow = true
    }

    private static func preview(_ value: String) -> String {
        let flat = value.replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return flat.count > 100 ? String(flat.prefix(100)) + "…" : flat
    }

    public static func fullText(_ step: ConversationExecutionStep) -> String {
        var sections = ["\(step.state.marker) \(step.title)"]
        if let detail = step.detail, !detail.isEmpty { sections.append(detail) }
        if let tool = step.tool {
            if let input = tool.input, !input.isEmpty { sections.append("输入\n\(input)") }
            if let result = tool.result, !result.isEmpty { sections.append("结果\n\(result)") }
        }
        if let changeSet = step.changeSet {
            sections.append(changeSet.changes.map { change in
                ["\(change.marker) \(change.path)", change.diffPreview]
                    .compactMap { $0 }.joined(separator: "\n")
            }.joined(separator: "\n\n"))
            if changeSet.truncated { sections.append("其余文件变更已截断") }
        }
        return sections.joined(separator: "\n\n")
    }
}
