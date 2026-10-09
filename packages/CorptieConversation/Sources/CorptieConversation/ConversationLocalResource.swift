import Foundation

/// Image destinations shared by desktop/mobile. Explicit local image download
/// links also count; fenced examples never become automatic media requests.
public struct ConversationMessageImageReference: Identifiable, Hashable, Sendable {
    public let source: String
    public let url: URL
    public let range: NSRange
    public var id: String { url.absoluteString }
    private static let pattern = try! NSRegularExpression(pattern: #"!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)"#)

    public static func parse(_ text: String) -> [Self] {
        guard text.contains("[") else { return [] }
        var offset = 0
        var fence: Character?
        var result: [Self] = []
        for line in text.components(separatedBy: "\n") {
            defer { offset += line.utf16.count + 1 }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                let marker = trimmed.first!
                if fence == marker { fence = nil } else if fence == nil { fence = marker }
                continue
            }
            guard fence == nil else { continue }
            let string = line as NSString
            for match in pattern.matches(in: line, range: NSRange(location: 0, length: string.length)) {
                let range = match.range(at: match.range(at: 1).location == NSNotFound ? 2 : 1)
                let destination = string.substring(with: range)
                guard let url = URL(string: destination),
                      url.isFileURL || ["https", "http"].contains(url.scheme?.lowercased() ?? "") || url.scheme == nil,
                      string.substring(with: match.range).hasPrefix("!")
                        || ["png", "jpg", "jpeg", "gif", "webp", "heic"].contains(url.pathExtension.lowercased()) else { continue }
                result.append(.init(source: destination, url: url,
                    range: NSRange(location: offset + match.range.location, length: match.range.length)))
                if result.count == 64 { return result }
            }
        }
        return result
    }

    public static func removing(_ references: [Self], from text: String) -> String {
        guard !references.isEmpty else { return text }
        let result = NSMutableString(string: text)
        for reference in references.sorted(by: { $0.range.location > $1.range.location }) {
            guard NSMaxRange(reference.range) <= result.length else { continue }
            result.deleteCharacters(in: reference.range)
        }
        return (result as String).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

@MainActor public final class ConversationMessageImageReferenceCache {
    public static let shared = ConversationMessageImageReferenceCache()
    private var values: [String: (String, [ConversationMessageImageReference])] = [:]
    private var order: [String] = []
    public func references(messageID: String, text: String) -> [ConversationMessageImageReference] {
        if let value = values[messageID], value.0 == text { return value.1 }
        let result = ConversationMessageImageReference.parse(text)
        guard text.utf8.count <= 512 * 1024 else { return result }
        if values[messageID] == nil { order.append(messageID) }
        values[messageID] = (text, result)
        while order.count > 16 { values.removeValue(forKey: order.removeFirst()) }
        return result
    }
}

/// An explicit message link, not authority to read a host path. The server verifies
/// exact message ownership, containment, file type and size on every request.
public struct ConversationLocalResource: Identifiable, Hashable, Sendable {
    public let path: String
    public var id: String { path }
    public var fileName: String { URL(fileURLWithPath: path).lastPathComponent }
    public var isImage: Bool {
        ["png", "jpg", "jpeg", "gif", "webp", "heic"].contains(URL(fileURLWithPath: path).pathExtension.lowercased())
    }

    public init?(url: URL) {
        guard url.isFileURL || (url.scheme == nil && url.path.hasPrefix("/")),
              url.host == nil || url.host == "" || url.host == "localhost" else { return nil }
        self.path = url.path
    }

    private static let pattern = try! NSRegularExpression(pattern: #"!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))\s*\)"#)

    public static func parse(_ text: String) -> [Self] {
        let source = text as NSString
        var seen = Set<String>()
        return pattern.matches(in: text, range: NSRange(location: 0, length: source.length)).prefix(64).compactMap { match in
            let range = match.range(at: match.range(at: 1).location == NSNotFound ? 2 : 1)
            guard let url = URL(string: source.substring(with: range)), let resource = Self(url: url),
                  seen.insert(resource.path).inserted else { return nil }
            return resource
        }
    }
}

@MainActor
public final class ConversationLocalResourceCache {
    public static let shared = ConversationLocalResourceCache()
    private var entries: [String: (String, [ConversationLocalResource])] = [:]
    private var order: [String] = []

    public func resources(messageID: String, text: String) -> [ConversationLocalResource] {
        if let entry = entries[messageID], entry.0 == text { return entry.1 }
        let result = ConversationLocalResource.parse(text)
        if text.utf8.count > 64 * 1024 { return result }
        if entries[messageID] == nil { order.append(messageID) }
        entries[messageID] = (text, result)
        while order.count > 64 { entries.removeValue(forKey: order.removeFirst()) }
        return result
    }
}
