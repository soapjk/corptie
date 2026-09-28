import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct AgentMessageParts {
    let activity: String
    let body: String

    var activitySummary: String {
        let lines = activity
            .split(separator: "\n")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let toolLines = lines.filter { line in
            line.localizedCaseInsensitiveContains("searching")
                || line.localizedCaseInsensitiveContains("searched")
                || line.localizedCaseInsensitiveContains("running")
                || line.localizedCaseInsensitiveContains("using")
                || line.localizedCaseInsensitiveContains("reading")
                || line.localizedCaseInsensitiveContains("tool")
        }
        if toolLines.isEmpty {
            return "过程记录 · 展开"
        }
        return "过程记录 · \(toolLines.count) 步 · 展开"
    }

    static func parse(_ rawText: String) -> AgentMessageParts {
        let cleaned = rawText
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
            .filter { !isNoiseLine($0) }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard let dividerRange = dividerRange(in: cleaned) else {
            return AgentMessageParts(activity: "", body: cleaned)
        }

        let activity = String(cleaned[..<dividerRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        let body = String(cleaned[dividerRange.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else {
            return AgentMessageParts(activity: "", body: cleaned)
        }
        return AgentMessageParts(activity: normalizeActivity(activity), body: body)
    }

    private static func dividerRange(in text: String) -> Range<String.Index>? {
        var cursor = text.startIndex
        while cursor < text.endIndex {
            let lineEnd = text[cursor...].firstIndex(of: "\n") ?? text.endIndex
            let line = String(text[cursor..<lineEnd]).trimmingCharacters(in: .whitespacesAndNewlines)
            if isDividerLine(line) {
                return cursor..<lineEnd
            }
            cursor = lineEnd == text.endIndex ? text.endIndex : text.index(after: lineEnd)
        }
        return nil
    }

    private static func isDividerLine(_ line: String) -> Bool {
        guard line.count >= 12 else {
            return false
        }
        return line.allSatisfy { character in
            character == "-" || character == "─" || character == "—" || character == "━"
        }
    }

    private static func isNoiseLine(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.hasPrefix("⚠ Skill descriptions were shortened")
            || trimmed.localizedCaseInsensitiveContains("skills context budget")
    }

    private static func normalizeActivity(_ text: String) -> String {
        text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line in
                String(line)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .replacingOccurrences(of: #"^•\s*"#, with: "", options: .regularExpression)
            }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
    }
}
