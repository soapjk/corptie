import Foundation

/// Runs before Markdown consumes LaTeX escapes. Incomplete streaming input is
/// retained verbatim; bare square brackets require a LaTeX command to opt in.
public enum MessageMath {
    public struct Formula: Equatable, Sendable {
        public let source: String
        public let latex: String
        public let display: Bool
    }
    public enum Block: Equatable, Sendable {
        case text(String)
        case formula(Formula)
    }
    private static let command = try! NSRegularExpression(pattern: #"\\[a-zA-Z]+"#)

    public static func blocks(_ source: String) -> [Block] {
        guard source.contains("[") || source.contains("$$") else { return [.text(source)] }
        let lines = source.components(separatedBy: "\n")
        var result: [Block] = []
        var plain: [String] = []
        var fence: (Character, Int)?
        var index = 0
        while index < lines.count {
            let line = lines[index].trimmingCharacters(in: .whitespacesAndNewlines)
            if let first = line.first, first == "`" || first == "~" {
                let count = line.prefix(while: { $0 == first }).count
                if count >= 3 {
                    if let current = fence {
                        if current.0 == first && count >= current.1 && line.dropFirst(count).allSatisfy(\.isWhitespace) { fence = nil }
                    } else { fence = (first, count) }
                }
            }
            let closer: String? = switch line {
            case "[": "]"
            case #"\["#: #"\]"#
            case "$$": "$$"
            default: nil
            }
            if fence == nil, let closer {
                var end = index + 1
                var length = 0
                while end < lines.count && end - index <= 128 && length <= 8192 {
                    if lines[end].trimmingCharacters(in: .whitespacesAndNewlines) == closer { break }
                    length += lines[end].utf16.count
                    end += 1
                }
                if end < lines.count, end - index <= 128, length <= 8192,
                   lines[end].trimmingCharacters(in: .whitespacesAndNewlines) == closer {
                    let latex = lines[(index + 1)..<end].joined(separator: "\n")
                    let hasCommand = command.firstMatch(in: latex, range: NSRange(latex.startIndex..., in: latex)) != nil
                    if !latex.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (line != "[" || hasCommand) {
                        if !plain.isEmpty { result.append(.text(plain.joined(separator: "\n") + "\n")); plain = [] }
                        result.append(.formula(.init(source: lines[index...end].joined(separator: "\n"), latex: latex, display: true)))
                        index = end + 1
                        if index < lines.count { plain.append("") }
                        continue
                    }
                }
            }
            plain.append(lines[index])
            index += 1
        }
        if !plain.isEmpty { result.append(.text(plain.joined(separator: "\n"))) }
        return result
    }

    /// Inline math plus single-line display delimiters. Backticks and escaped
    /// dollars are protected, and dollar-delimited currency is not interpreted.
    static func inline(_ source: String) -> [(range: Range<String.Index>, formula: Formula)] {
        guard source.contains("$") || source.contains("\\") else { return [] }
        var result: [(Range<String.Index>, Formula)] = []
        var index = source.startIndex
        var ticks = 0
        while index < source.endIndex {
            if source[index] == "`" {
                let end = source[index...].prefix(while: { $0 == "`" }).endIndex
                let count = source.distance(from: index, to: end)
                if ticks == 0 { ticks = count } else if ticks == count { ticks = 0 }
                index = end
                continue
            }
            if ticks > 0 { index = source.index(after: index); continue }
            let tail = source[index...]
            let delimiter: (String, String, Bool)?
            if tail.hasPrefix(#"\["#) { delimiter = (#"\["#, #"\]"#, true) }
            else if tail.hasPrefix(#"\("#) { delimiter = (#"\("#, #"\)"#, false) }
            else if tail.hasPrefix("$$") { delimiter = ("$$", "$$", true) }
            else if tail.hasPrefix("$") { delimiter = ("$", "$", false) }
            else { delimiter = nil }
            if let (open, close, display) = delimiter {
                let start = source.index(index, offsetBy: open.count)
                var cursor = start
                var scanned = 0
                while cursor < source.endIndex && scanned <= 8192 {
                    if source[cursor...].hasPrefix(close) { break }
                    if source[cursor] == "\\" { cursor = source.index(after: cursor) }
                    if cursor < source.endIndex { cursor = source.index(after: cursor) }
                    scanned += 1
                }
                if cursor < source.endIndex, source[cursor...].hasPrefix(close) {
                    let latex = String(source[start..<cursor])
                    let end = source.index(cursor, offsetBy: close.count)
                    let currency = open == "$" && (latex.first?.isWhitespace == true || latex.last?.isWhitespace == true
                        || !latex.contains(where: { $0.isLetter || "\\^_=<>".contains($0) }))
                    if !latex.isEmpty && !currency && latex.utf16.count <= 8192 {
                        result.append((index..<end, .init(source: String(source[index..<end]), latex: latex, display: display)))
                        index = end
                        continue
                    }
                }
            }
            if source[index] == "\\" {
                index = source.index(after: index)
                if index < source.endIndex { index = source.index(after: index) }
            } else { index = source.index(after: index) }
        }
        return result
    }
}
