import Foundation

/// Small, immutable presentation prepared when a report changes. No observers,
/// hidden duplicate text layout, network work or document-history cache.
public struct CoordinationSummaryContent {
    public let text: String
    public let attributed: AttributedString
    public let canExpand: Bool
    public static let previewLines = 5

    public init(kind: String, text: String) {
        var body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if ["summary", "decision"].contains(kind), let first = body.split(separator: "\n", omittingEmptySubsequences: false).first,
           ["**后台汇总**", "后台汇总", "**Background summary**", "Background summary"].contains(String(first).trimmingCharacters(in: .whitespaces)) {
            body = String(body.dropFirst(first.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        self.text = body
        attributed = (try? AttributedString(markdown: body, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(body)
        // Short bodies are never clipped. Long bodies have a bounded preview
        // and an explicit disclosure, without a second offscreen text tree.
        canExpand = body.count > 160 || body.filter { $0 == "\n" }.count > 4
    }
    public static func expansionID(for messageID: String) -> String { "coordination-notice:" + messageID }
}
