import Foundation
import SwiftUI
import CorptieClientCore

/// Shared message width rules. Hosts measure text with their own text engine and
/// supply natural widths and, when needed, a role-specific width ceiling.
/// Default limits, padding and the image floor remain shared across platforms.
public enum MessageBubbleWidthPolicy {
    /// SwiftUI hosts can supply the actual intrinsic card width, including
    /// scaled fonts, icons, spacing and padding, instead of estimating glyphs.
    public static func processCardLayoutWidth(naturalWidth: CGFloat, expanded: Bool, laneWidth: CGFloat) -> CGFloat {
        let available = max(0, laneWidth - 4)
        return expanded ? min(available, maximumWidth) : min(available, max(minimumWidth, naturalWidth))
    }
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
                                      processWidth: CGFloat = 0, availableWidth: CGFloat = maximumWidth,
                                      widthCeiling: CGFloat = maximumWidth) -> CGFloat {
        let available = max(minimumWidth, min(widthCeiling, availableWidth))
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

    /// Expanded process cards share the ordinary message width ceiling instead
    /// of filling the timeline lane. Collapsed cards hug their visible rows.
    /// Hosts measure their platform fonts once and share this clamp/padding rule.
    public static func processCardWidth(
        summaryWidth: CGFloat,
        secondaryWidth: CGFloat = 0,
        progressLabelWidth: CGFloat = 0,
        expanded: Bool,
        laneWidth: CGFloat
    ) -> CGFloat {
        let fullAvailable = fullAvailableWidth(laneWidth: laneWidth)
        guard !expanded else { return min(fullAvailable, maximumWidth) }
        let progressWidth = progressLabelWidth > 0 ? progressLabelWidth + 8 : 0
        let headerWidth = summaryWidth + progressWidth + 58
        let secondaryRowWidth = secondaryWidth > 0 ? secondaryWidth + 40 : 0
        return min(fullAvailable, max(minimumWidth, headerWidth, secondaryRowWidth))
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

/// Deterministic ratio-aware gallery shared by UIKit/SwiftUI and AppKit. Hosts
/// commit missing metadata through their reading-position transaction; decoding
/// or evicting the bitmap alone never changes known geometry.
public enum MessageImageGalleryLayout {
    public static let preferredBodyWidth: CGFloat = 340
    public static let spacing: CGFloat = 4
    public struct Layout: Equatable {
        public let frames: [CGRect]
        public var size: CGSize { CGSize(width: frames.map(\.maxX).max() ?? 0, height: frames.map(\.maxY).max() ?? 0) }
    }
    /// One deterministic result drives drawing, bubble width and row height.
    /// Unknown resources use a compact slot until a single metadata commit.
    public static func layout(geometries: [MessageImageGeometry?], width: CGFloat) -> Layout {
        let limit = max(1, min(preferredBodyWidth, width.isFinite ? width : preferredBodyWidth))
        let sizes = geometries.prefix(4).map { value -> CGSize in
            guard let value else { return CGSize(width: min(88, limit), height: min(88, limit)) }
            let w = CGFloat(value.pixelWidth), h = CGFloat(value.pixelHeight)
            let scale = min(1, limit / w, 260 / h)
            return CGSize(width: w * scale, height: h * scale)
        }
        var frames: [CGRect] = [], y: CGFloat = 0, index = 0
        while index < sizes.count {
            let a = sizes[index]
            if index + 1 < sizes.count {
                let b = sizes[index + 1]
                let ra = a.width / a.height, rb = b.width / b.height
                let h = min(a.height, b.height, max(1, limit - spacing) / (ra + rb))
                if min(h, h * ra, h * rb) >= MessageImageStripMetrics.thumbnailEdge {
                    frames.append(CGRect(x: 0, y: y, width: ra * h, height: h))
                    frames.append(CGRect(x: ra * h + spacing, y: y, width: rb * h, height: h))
                    y += h + spacing; index += 2; continue
                }
            }
            frames.append(CGRect(origin: CGPoint(x: 0, y: y), size: a))
            y += a.height + spacing; index += 1
        }
        let height = frames.map(\.maxY).max() ?? 0
        if sizes.count > 1 && height > 300 {
            let scale = 300 / height
            frames = frames.map { CGRect(x: $0.minX * scale, y: $0.minY * scale, width: $0.width * scale, height: $0.height * scale) }
        }
        return Layout(frames: frames)
    }

    public static func cardWidth(bodyWidth: CGFloat, headerWidth: CGFloat = 0,
                                 geometries: [MessageImageGeometry?], laneWidth: CGFloat) -> CGFloat {
        let available = MessageBubbleWidthPolicy.fullAvailableWidth(laneWidth: laneWidth)
        let imageWidth = layout(geometries: geometries, width: available - MessageBubbleWidthPolicy.horizontalPadding).size.width
        return MessageBubbleWidthPolicy.preferredWidth(bodyWidth: max(bodyWidth, imageWidth),
            headerWidth: headerWidth, availableWidth: available)
    }
    /// Compatibility for count-only callers. Message hosts use `layout` above.
    public static func frames(count: Int, width: CGFloat) -> [CGRect] {
        let width = max(1, min(preferredBodyWidth, width.isFinite ? width : preferredBodyWidth))
        let count = min(4, max(0, count))
        guard count > 0 else { return [] }
        if count == 1 { return [CGRect(x: 0, y: 0, width: width, height: min(260, width * 0.75))] }
        let half = max(1, (width - spacing) / 2)
        if count == 2 {
            return [CGRect(x: 0, y: 0, width: half, height: half),
                    CGRect(x: half + spacing, y: 0, width: half, height: half)]
        }
        let height = min(300, width)
        let halfHeight = max(1, (height - spacing) / 2)
        if count == 3 {
            let main = max(1, (width - spacing) * 2 / 3)
            let small = max(1, width - main - spacing)
            return [CGRect(x: 0, y: 0, width: main, height: height),
                    CGRect(x: main + spacing, y: 0, width: small, height: halfHeight),
                    CGRect(x: main + spacing, y: halfHeight + spacing, width: small, height: halfHeight)]
        }
        return (0..<4).map { index in CGRect(x: CGFloat(index % 2) * (half + spacing),
            y: CGFloat(index / 2) * (halfHeight + spacing), width: half, height: halfHeight) }
    }
    public static func height(count: Int, width: CGFloat) -> CGFloat {
        frames(count: count, width: width).map(\.maxY).max() ?? 0
    }

    public static func bodyText(_ text: String, hasImages: Bool) -> String {
        guard hasImages else { return text }
        let placeholders: Set<String> = ["[localImage]", "[local image]", "[image]"]
        return text.components(separatedBy: "\n").filter {
            !placeholders.contains($0.trimmingCharacters(in: .whitespaces))
        }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Thumbnail slot of the strip. The host supplies the decoded image (or nil while
/// loading / when missing) so no decoding or networking happens in the view.
public struct MessageImageThumbnail: View {
    public enum State { case loading, loaded(Image), missing }
    private let state: State
    private let index: Int
    private let size: CGSize
    private let fits: Bool
    private let extraCount: Int

    public init(state: State, index: Int, size: CGSize = .init(width: 88, height: 88), fits: Bool = false, extraCount: Int = 0) {
        self.state = state
        self.index = index
        self.size = size
        self.fits = fits
        self.extraCount = extraCount
    }

    public var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: MessageImageStripMetrics.cornerRadius, style: .continuous)
                .fill(Color.black.opacity(0.05))
            switch state {
            case .loading:
                Image(systemName: "photo").foregroundStyle(.secondary)
            case .loaded(let image):
                image.resizable().aspectRatio(contentMode: fits ? .fit : .fill)
            case .missing:
                Label("点击重试", systemImage: "arrow.clockwise").font(.caption).foregroundStyle(.secondary)
            }
            if extraCount > 0 {
                Color.black.opacity(0.4)
                Text("+\(extraCount)").font(.title2.bold()).foregroundStyle(.white)
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: MessageImageStripMetrics.cornerRadius, style: .continuous))
        .accessibilityLabel("Attached image \(index + 1)")
    }
}
