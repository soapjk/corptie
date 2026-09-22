import UIKit
import CorptieConversation

/// One Markdown parse per (style, text) shared by width measurement and the
/// rendering `UITextView`, mirroring the desktop `NativeMarkdownTextCache`.
/// `NSCache` bounds memory; entries are immutable so eviction is free.
@MainActor
enum PadMessageLayout {
    final class Entry {
        let attributed: NSAttributedString
        /// Natural single-line-wrapped width of the body (no card padding).
        let naturalWidth: CGFloat
        init(attributed: NSAttributedString, naturalWidth: CGFloat) {
            self.attributed = attributed
            self.naturalWidth = naturalWidth
        }
    }

    private static let cache: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>()
        cache.countLimit = 400
        return cache
    }()

    static func entry(text: String, style: MessageMarkdown.Style) -> Entry {
        let key = "\(style)\u{0}\(text)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        let attributed = MessageMarkdown.make(text: text, style: style)
        let bounds = attributed.boundingRect(
            with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        let entry = Entry(attributed: attributed, naturalWidth: ceil(bounds.width))
        cache.setObject(entry, forKey: key)
        return entry
    }

    /// Body width the shared policy clamps: full lane for rich Markdown, glyph bounds otherwise.
    static func bodyWidth(text: String, style: MessageMarkdown.Style) -> CGFloat {
        MessageBubbleWidthPolicy.requiresFullWidthLayout(text)
            ? MessageBubbleWidthPolicy.fullWidthBody
            : entry(text: text, style: style).naturalWidth
    }
}
