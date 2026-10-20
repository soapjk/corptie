import Foundation

/// Shared product title policy for macOS, iPhone and iPad. Do not trim or
/// normalize explicit input: the user should see and correct invalid characters.
public enum EntityTitlePolicy {
    private static let expression = try! NSRegularExpression(
        pattern: #"\A[A-Za-z\p{Script=Han}_-][A-Za-z0-9\p{Script=Han}_-]*\z"#)
    private static let invalidCharacters = try! NSRegularExpression(pattern: #"[^A-Za-z0-9\p{Script=Han}_-]+"#)

    public static func isValid(_ value: String) -> Bool {
        !value.isEmpty && expression.firstMatch(in: value,
            range: NSRange(value.startIndex..., in: value)) != nil
    }

    public static let guidance = "名称仅支持中文、大小写英文字母、数字、横杠（-）和下划线（_），不能以数字开头，也不能包含空格或其他符号。"

    /// Generated suggestions only; never use this to silently rewrite a rename.
    public static func generatedDefault(_ value: String) -> String {
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty || invalidCharacters.firstMatch(in: raw,
            range: NSRange(raw.startIndex..., in: raw))?.range.length == raw.utf16.count { return "Session" }
        let cleaned = invalidCharacters.stringByReplacingMatches(in: raw,
            range: NSRange(raw.startIndex..., in: raw), withTemplate: "_")
        guard !cleaned.isEmpty else { return "Session" }
        return cleaned.first?.isNumber == true ? "_" + cleaned : cleaned
    }
}
