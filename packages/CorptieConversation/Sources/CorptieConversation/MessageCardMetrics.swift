import Foundation

/// Geometry shared by the measured AppKit and intrinsic SwiftUI message cards.
/// Row breathing room belongs outside the painted card, never inside its padding.
public enum MessageCardMetrics {
    public static let contentInset: CGFloat = 10
    public static let rowInset: CGFloat = 1
    public static let contentSpacing: CGFloat = 8

    public static func cardHeight(contentHeight: CGFloat) -> CGFloat {
        max(0, contentHeight) + contentInset * 2
    }

    public static func rowHeight(cardHeight: CGFloat, separatorHeight: CGFloat = 0, typography: ConversationTypography = .classic) -> CGFloat {
        separatorHeight + cardHeight + typography.rowInset * 2
    }
}

/// Only the actual message boundaries lose exterior Markdown whitespace.
/// Intermediate fragments around charts/tables retain their paragraph spacing.
public struct MessageTextBoundary: OptionSet, Sendable, Hashable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let start = Self(rawValue: 1)
    public static let end = Self(rawValue: 2)
    public static let both: Self = [.start, .end]

    public static func fragment(index: Int, count: Int) -> Self {
        var result: Self = []
        if index == 0 { result.insert(.start) }
        if index == count - 1 { result.insert(.end) }
        return result
    }
}
