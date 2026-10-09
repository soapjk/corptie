import Foundation

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
