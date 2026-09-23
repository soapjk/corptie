import Foundation
import SwiftUI

/// Card width rules of an ordinary message, identical on macOS (AppKit timeline)
/// and iPad (SwiftUI timeline). Hosts measure text with their own text engine and
/// hand the natural widths in; the clamp, padding and image floor live here.
public enum MessageBubbleWidthPolicy {
    public static let maximumWidth: CGFloat = 480
    /// A plain message only needs room for its body and card padding.
    public static let minimumWidth: CGFloat = 40
    public static let horizontalPadding: CGFloat = 20
    public static let collapsedProcessWidth: CGFloat = 180
    /// Cards carrying attachments never get narrower than two thumbnails.
    public static let attachmentMinimumWidth: CGFloat = 220
    /// Rich blocks (images, tables, fenced code, HTML) take the full content lane;
    /// glyph bounds do not represent their natural width.
    public static let fullWidthBody: CGFloat = maximumWidth - horizontalPadding

    private static let image = try! NSRegularExpression(pattern: #"!\[[^\]]*\]\([^\)]*\)"#)
    private static let taskList = try! NSRegularExpression(pattern: #"(?m)^\s*[-+*]\s+\[[ xX]\]\s+"#)
    private static let tableDelimiter = try! NSRegularExpression(
        pattern: #"(?m)^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$"#)
    private static let fencedCode = try! NSRegularExpression(pattern: #"(?m)^\s*(?:```|~~~)"#)
    private static let htmlBlock = try! NSRegularExpression(
        pattern: #"(?m)^\s*</?(?:details|summary|table|div|picture|video|audio|iframe)\b"#, options: [.caseInsensitive])

    public static func requiresFullWidthLayout(_ markdown: String) -> Bool {
        let range = NSRange(markdown.startIndex..., in: markdown)
        return image.firstMatch(in: markdown, range: range) != nil
            || taskList.firstMatch(in: markdown, range: range) != nil
            || tableDelimiter.firstMatch(in: markdown, range: range) != nil
            || fencedCode.firstMatch(in: markdown, range: range) != nil
            || htmlBlock.firstMatch(in: markdown, range: range) != nil
    }

    /// `bodyWidth` is the measured natural width of the message body (or
    /// `fullWidthBody` for rich Markdown); `headerWidth` / `processWidth` are the
    /// other in-card rows competing for width.
    public static func preferredWidth(bodyWidth: CGFloat, headerWidth: CGFloat = 0,
                                      processWidth: CGFloat = 0, availableWidth: CGFloat = maximumWidth) -> CGFloat {
        let available = max(minimumWidth, min(maximumWidth, availableWidth))
        return min(available, max(minimumWidth, max(bodyWidth, headerWidth, processWidth) + horizontalPadding))
    }

    /// Width usable by a card inside a timeline lane of `laneWidth` (4pt breathing room).
    public static func fullAvailableWidth(laneWidth: CGFloat) -> CGFloat {
        max(minimumWidth, laneWidth - 4)
    }

    /// Final card width of an ordinary text message.
    public static func cardWidth(bodyWidth: CGFloat, hasAttachments: Bool, laneWidth: CGFloat) -> CGFloat {
        let fullAvailable = fullAvailableWidth(laneWidth: laneWidth)
        let preferred = preferredWidth(bodyWidth: bodyWidth, availableWidth: fullAvailable)
        return hasAttachments ? min(fullAvailable, max(attachmentMinimumWidth, preferred)) : preferred
    }

    /// Process cards expand to the whole bounded lane; collapsed cards retain a
    /// compact summary width, matching the desktop timeline.
    public static func processCardWidth(summaryWidth: CGFloat, expanded: Bool, laneWidth: CGFloat) -> CGFloat {
        let fullAvailable = fullAvailableWidth(laneWidth: laneWidth)
        guard !expanded else { return fullAvailable }
        return min(fullAvailable, max(collapsedProcessWidth, summaryWidth + 58))
    }
}

/// Attachment strip inside a message card: up to four 88pt thumbnails, 7pt apart,
/// 9pt corners (the AppKit `imageStack` geometry).
public enum MessageImageStripMetrics {
    public static let maximumCount = 4
    public static let thumbnailEdge: CGFloat = 88
    public static let spacing: CGFloat = 7
    public static let cornerRadius: CGFloat = 9
    /// Distance from the strip to the text below it.
    public static let bottomSpacing: CGFloat = 7
}

/// Thumbnail slot of the strip. The host supplies the decoded image (or nil while
/// loading / when missing) so no decoding or networking happens in the view.
public struct MessageImageThumbnail: View {
    public enum State { case loading, loaded(Image), missing }
    private let state: State
    private let index: Int

    public init(state: State, index: Int) {
        self.state = state
        self.index = index
    }

    public var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: MessageImageStripMetrics.cornerRadius, style: .continuous)
                .fill(Color.black.opacity(0.05))
            switch state {
            case .loading:
                Image(systemName: "photo").foregroundStyle(.secondary)
            case .loaded(let image):
                image.resizable().aspectRatio(contentMode: .fill)
            case .missing:
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.secondary)
            }
        }
        .frame(width: MessageImageStripMetrics.thumbnailEdge, height: MessageImageStripMetrics.thumbnailEdge)
        .clipShape(RoundedRectangle(cornerRadius: MessageImageStripMetrics.cornerRadius, style: .continuous))
        .accessibilityLabel("Attached image \(index + 1)")
    }
}
