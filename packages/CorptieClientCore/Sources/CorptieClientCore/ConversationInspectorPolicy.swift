import Foundation

/// Shared desktop/iPad rules; UI layout and platform file pickers stay outside this module.
public enum ConversationInspectorPolicy {
    public static func preferredArtifactVersion(pinned: Int?, approved: Int?, current: Int) -> Int {
        pinned ?? approved ?? current
    }
    public static func spanDurationMilliseconds(start: String, end: String) -> Double {
        guard let start = Decimal(string: start), let end = Decimal(string: end) else { return 0 }
        return NSDecimalNumber(decimal: end - start).doubleValue / 1_000_000
    }
}
