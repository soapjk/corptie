import UIKit
import CorptieConversation

/// One Markdown parse per (style, text) shared by width measurement and the
/// rendering `UITextView`, mirroring the desktop `NativeMarkdownTextCache`.
/// Parsed text and system measurements survive individual hosted view lifetimes.
/// No cached entry retains a UITextView or sets an outer card height.
@MainActor
enum PadMessageLayout {
    #if DEBUG
    private(set) static var sizeQueries: UInt64 = 0
    private(set) static var systemMeasurements: UInt64 = 0
    private static let reusesMeasurements = ProcessInfo.processInfo.environment["CORPTIE_PROFILE_TEXT_SIZE_CACHE"] != "0"
    #else
    private static let reusesMeasurements = true
    #endif
    @MainActor final class Entry {
        let attributed: NSAttributedString
        /// Natural single-line-wrapped width of the body (no card padding).
        let naturalWidth: CGFloat
        private var sizes: [MeasurementKey: CGSize] = [:]
        private(set) var measurementCount = 0
        init(attributed: NSAttributedString, naturalWidth: CGFloat) {
            self.attributed = attributed
            self.naturalWidth = naturalWidth
        }

        func size(width: CGFloat, view: UITextView) -> CGSize {
            #if DEBUG
            PadMessageLayout.sizeQueries &+= 1
            #endif
            let key = MeasurementKey(width: width, view: view)
            if PadMessageLayout.reusesMeasurements, let cached = sizes[key] { return cached }
            let measured = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
            #if DEBUG
            PadMessageLayout.systemMeasurements &+= 1
            #endif
            let result = CGSize(width: min(width, ceil(measured.width)), height: ceil(measured.height))
            guard PadMessageLayout.reusesMeasurements else { return result }
            // Rotation and split-screen can supply many proposals. Keep a small
            // bounded set, rather than accumulating every fractional width.
            if sizes.count >= 8 { sizes.removeAll(keepingCapacity: true) }
            sizes[key] = result
            measurementCount += 1
            return result
        }
    }

    private struct MeasurementKey: Hashable {
        let width: CGFloat
        let top: CGFloat
        let left: CGFloat
        let bottom: CGFloat
        let right: CGFloat
        let padding: CGFloat
        let maximumLines: Int
        let lineBreakMode: Int
        let contentSizeCategory: String
        let layoutDirection: Int
        let displayScale: CGFloat

        @MainActor init(width: CGFloat, view: UITextView) {
            self.width = width // Preserve fractional widths at wrap boundaries.
            let inset = view.textContainerInset
            top = inset.top; left = inset.left; bottom = inset.bottom; right = inset.right
            padding = view.textContainer.lineFragmentPadding
            maximumLines = view.textContainer.maximumNumberOfLines
            lineBreakMode = view.textContainer.lineBreakMode.rawValue
            contentSizeCategory = view.traitCollection.preferredContentSizeCategory.rawValue
            layoutDirection = view.effectiveUserInterfaceLayoutDirection.rawValue
            displayScale = view.traitCollection.displayScale
        }
    }

    private static let cache: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>()
        cache.countLimit = 400
        cache.totalCostLimit = 16 * 1024 * 1024
        return cache
    }()
    private static let memoryWarningObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
    ) { _ in
        Task { @MainActor in removeAllCachedEntries() }
    }

    static func entry(text: String, style: MessageMarkdown.Style) -> Entry {
        _ = memoryWarningObserver
        let key = "\(style)\u{0}\(text)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        let attributed = MessageMarkdown.make(text: text, style: style)
        let bounds = attributed.boundingRect(
            with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        let entry = Entry(attributed: attributed, naturalWidth: ceil(bounds.width))
        // Conservative attributed-text estimate; NSCache may evict earlier under
        // pressure. This is a cost budget, not a promise of exact resident bytes.
        cache.setObject(entry, forKey: key, cost: max(1, text.utf16.count) * 64 + 1024)
        return entry
    }

    static func removeAllCachedEntries() { cache.removeAllObjects() }

    /// Body width the shared policy clamps: full lane for rich Markdown, glyph bounds otherwise.
    static func bodyWidth(text: String, style: MessageMarkdown.Style) -> CGFloat {
        MessageBubbleWidthPolicy.requiresFullWidthLayout(text)
            ? MessageBubbleWidthPolicy.fullWidthBody
            : entry(text: text, style: style).naturalWidth
    }
}
