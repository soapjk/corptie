import Foundation

public struct ComposerMentionQuery: Equatable, Sendable {
    public let replacementRange: NSRange
    public let text: String

    public init(replacementRange: NSRange, text: String) {
        self.replacementRange = replacementRange
        self.text = text
    }

    public static func resolve(in text: String, selection: NSRange) -> Self? {
        guard selection.length == 0 else { return nil }
        let value = text as NSString
        guard selection.location <= value.length else { return nil }
        let prefix = value.substring(to: selection.location) as NSString
        var index = prefix.length
        while index > 0 {
            let scalar = UnicodeScalar(prefix.character(at: index - 1))
            if scalar.map(CharacterSet.whitespacesAndNewlines.contains) == true { break }
            index -= 1
        }
        guard index < prefix.length, prefix.character(at: index) == 64 else { return nil }
        if index > 0 {
            let preceding = UnicodeScalar(prefix.character(at: index - 1))
            guard preceding.map(CharacterSet.whitespacesAndNewlines.contains) == true else { return nil }
        }
        let queryRange = NSRange(location: index + 1, length: prefix.length - index - 1)
        return Self(
            replacementRange: NSRange(location: index, length: prefix.length - index),
            text: prefix.substring(with: queryRange)
        )
    }
}
