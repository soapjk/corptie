import Foundation

/// A reply points to the original timeline message, never to the most recent
/// user input. It does not participate in timeline identity or ordering.
public struct ConversationMessageReply: Codable, Equatable, Sendable {
    public let requestId: String?
    public let replyToMessageId: String
    public let sourceSessionId: String?

    public init?(requestId: String?, replyToMessageId: String?, sourceSessionId: String?) {
        guard let target = Self.nonEmpty(replyToMessageId) else { return nil }
        self.requestId = Self.nonEmpty(requestId)
        self.replyToMessageId = target
        self.sourceSessionId = Self.nonEmpty(sourceSessionId)
    }

    public init?(rawMetadataJSON: String?) {
        guard let rawMetadataJSON, let data = rawMetadataJSON.data(using: .utf8),
              let fields = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        self.init(requestId: fields["requestId"] as? String,
                  replyToMessageId: fields["replyToMessageId"] as? String,
                  sourceSessionId: fields["sourceSessionId"] as? String)
    }

    /// Bounded plain text; callers build a message-ID index once per projection.
    /// Missing history retains the exact target, without guessing a question.
    public func label(question: String?) -> String {
        let preview = question.map { String($0.prefix(180)).split(whereSeparator: { $0.isWhitespace }).joined(separator: " ") }
        return "回复：" + ((preview?.isEmpty == false ? preview : nil) ?? replyToMessageId)
    }
    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }
}
