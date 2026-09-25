import Foundation

/// One presentation rule for desktop and mobile. The raw message remains the
/// authoritative stored payload; `presentationText` is the backend's explicit
/// client-facing projection when it is nonempty.
public enum ConversationMessageDisplayText {
    public static func resolve(text: String, presentationText: String?, title: String?, type: String) -> String {
        let presented = presentationText?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let presented, !presented.isEmpty { return presented }
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !raw.isEmpty { return raw }
        if let title, !title.isEmpty { return title }
        return type
    }

    /// A chart is an inline rendering of the original assistant reply. Copying
    /// that reply must retain the fenced source, even if a presentation-only
    /// projection differs. Other messages keep their existing displayed-copy
    /// behavior (notably user messages with a distinct safe projection).
    public static func copyText(type: String, authoritativeText: String,
                                presentationText: String? = nil, displayedText: String) -> String {
        // A nonempty server projection is the client-visible authority. Do not
        // expose raw bytes through Copy when that projection intentionally
        // redacts or replaces part of the original provider message.
        if presentationText?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            return displayedText
        }
        if type == "agentMessage" && authoritativeText.contains("```corptie-chart") {
            return authoritativeText
        }
        return displayedText
    }
}
