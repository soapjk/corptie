import Foundation

/// Immutable reading metrics. No state observation, persistence or cache keys.
public struct ConversationTypography: Equatable, Sendable {
    public let isReading: Bool
    public let bodySize: CGFloat
    public let userBodySize: CGFloat
    public static let classic = Self(isReading: false, bodySize: 11, userBodySize: 11)
    public static let codexReading = Self(isReading: true, bodySize: 16, userBodySize: 15)
    public var codeSize: CGFloat { isReading ? 13 : 12 }
    public var lineSpacing: CGFloat { isReading ? 4 : 0 }
    public var paragraphSpacing: CGFloat { isReading ? 10 : 0 }
    public var rowInset: CGFloat { isReading ? 6 : MessageCardMetrics.rowInset }
    public var table: Self { isReading ? Self(isReading: true, bodySize: 14, userBodySize: 14) : self }
    public func body(for style: MessageMarkdown.Style) -> Self {
        Self(isReading: isReading, bodySize: bodySize(for: style), userBodySize: userBodySize)
    }
    public func headingSize(level: Int) -> CGFloat {
        isReading ? [22, 19, 17, 16, 16, 16][min(5, max(0, level - 1))] : max(14, 21 - CGFloat(level * 2))
    }
    public func bodySize(for style: MessageMarkdown.Style) -> CGFloat {
        style == .process ? 10.5 : (style == .user ? userBodySize : bodySize)
    }
}

public extension ConversationSkin {
    func typography(for role: ConversationSurfaceRole) -> ConversationTypography {
        guard self == .codexFlat else { return .classic }
        switch role {
        case .user, .assistant: return .codexReading
        default: return .classic
        }
    }
}
