import AppKit
import SwiftUI

@MainActor
enum NativeMarkdownAttributedText {
    private static let unorderedListItemRegex = try! NSRegularExpression(pattern: #"^(\s*)[-+*]\s+(.+)$"#)
    private static let orderedListItemRegex = try! NSRegularExpression(pattern: #"^(\s*)(\d+)[.)]\s+(.+)$"#)

    static func make(
        text: String,
        style: AppKitChatTimelineRow.NativeStyle
    ) -> NSAttributedString {
        let baseFont: NSFont = switch style {
        case .user, .agent: .systemFont(ofSize: 11, weight: .medium)
        case .process: .systemFont(ofSize: 10.5, weight: .semibold)
        }
        let color = NativeTimelineCardPalette.secondaryText
        guard style != .process else {
            return NSAttributedString(string: text, attributes: [.font: baseFont, .foregroundColor: color])
        }

        let attributed = NSMutableAttributedString()
        var inCodeFence = false
        let lines = text.components(separatedBy: "\n")
        for (index, sourceLine) in lines.enumerated() {
            let line = sourceLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                inCodeFence.toggle()
            } else if inCodeFence {
                attributed.append(blockLine(
                    sourceLine,
                    font: .monospacedSystemFont(ofSize: 12, weight: .regular),
                    color: color,
                    backgroundColor: .quaternaryLabelColor,
                    headIndent: 8,
                    tailIndent: -8
                ))
            } else if let heading = heading(in: sourceLine) {
                attributed.append(blockLine(
                    heading.text,
                    baseFont: .systemFont(
                        ofSize: max(14, 21 - CGFloat(heading.level * 2)),
                        weight: .bold
                    ),
                    color: color,
                    paragraphSpacingBefore: heading.level == 1 ? 8 : 5,
                    paragraphSpacing: 4
                ))
            } else if let listItem = unorderedListItem(in: sourceLine) {
                attributed.append(blockLine(
                    "\(String(repeating: "  ", count: listItem.depth))•  \(listItem.text)",
                    baseFont: baseFont,
                    color: color,
                    headIndent: CGFloat(listItem.depth * 14),
                    firstLineHeadIndent: CGFloat(listItem.depth * 14)
                ))
            } else if let listItem = orderedListItem(in: sourceLine) {
                attributed.append(blockLine(
                    "\(String(repeating: "  ", count: listItem.depth))\(listItem.ordinal).  \(listItem.text)",
                    baseFont: baseFont,
                    color: color,
                    headIndent: CGFloat(listItem.depth * 14),
                    firstLineHeadIndent: CGFloat(listItem.depth * 14)
                ))
            } else if let quote = blockQuote(in: sourceLine) {
                attributed.append(blockLine(
                    "│  \(quote)",
                    baseFont: baseFont,
                    color: .secondaryLabelColor,
                    headIndent: 8,
                    firstLineHeadIndent: 0
                ))
            } else if isThematicBreak(sourceLine) {
                attributed.append(blockLine("────────", baseFont: baseFont, color: .separatorColor))
            } else {
                attributed.append(blockLine(sourceLine, baseFont: baseFont, color: color))
            }
            if index < lines.count - 1, !(line.hasPrefix("```") || line.hasPrefix("~~~")) {
                attributed.append(NSAttributedString(string: "\n", attributes: [.font: baseFont]))
            }
        }
        return attributed
    }

    private static func blockLine(
        _ text: String,
        baseFont: NSFont? = nil,
        font: NSFont? = nil,
        color: NSColor,
        backgroundColor: NSColor? = nil,
        headIndent: CGFloat = 0,
        firstLineHeadIndent: CGFloat? = nil,
        tailIndent: CGFloat = 0,
        paragraphSpacingBefore: CGFloat = 0,
        paragraphSpacing: CGFloat = 0
    ) -> NSAttributedString {
        let effectiveFont = font ?? baseFont ?? .systemFont(ofSize: 13)
        let attributed: NSMutableAttributedString
        if font == nil,
           let parsed = try? AttributedString(
               markdown: text,
               options: .init(
                   interpretedSyntax: .inlineOnlyPreservingWhitespace,
                   failurePolicy: .returnPartiallyParsedIfPossible
               )
           ) {
            attributed = NSMutableAttributedString(parsed)
        } else {
            attributed = NSMutableAttributedString(string: text)
        }
        let fullRange = NSRange(location: 0, length: attributed.length)
        attributed.addAttributes([.font: effectiveFont, .foregroundColor: color], range: fullRange)
        if let backgroundColor {
            attributed.addAttribute(.backgroundColor, value: backgroundColor, range: fullRange)
        }
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.headIndent = headIndent
        paragraphStyle.firstLineHeadIndent = firstLineHeadIndent ?? headIndent
        paragraphStyle.tailIndent = tailIndent
        paragraphStyle.paragraphSpacingBefore = paragraphSpacingBefore
        paragraphStyle.paragraphSpacing = paragraphSpacing
        // Chat messages regularly contain URLs, hashes, file paths, and model
        // identifiers with no whitespace. Word wrapping lets those runs escape
        // the fixed card width; character wrapping preserves the card boundary.
        paragraphStyle.lineBreakMode = .byCharWrapping
        attributed.addAttribute(.paragraphStyle, value: paragraphStyle, range: fullRange)
        let inlineIntentKey = NSAttributedString.Key("NSInlinePresentationIntent")
        attributed.enumerateAttribute(inlineIntentKey, in: fullRange) { value, range, _ in
            guard let rawIntent = value as? NSNumber else { return }
            let intent = rawIntent.intValue
            let isCode = intent & 4 != 0
            let isStrong = intent & 2 != 0
            let isEmphasized = intent & 1 != 0
            let isStrikethrough = intent & 64 != 0
            let font: NSFont
            if isCode {
                font = .monospacedSystemFont(ofSize: effectiveFont.pointSize, weight: isStrong ? .bold : .regular)
            } else {
                let weighted = isStrong
                    ? NSFont.systemFont(ofSize: effectiveFont.pointSize, weight: .bold)
                    : effectiveFont
                font = isEmphasized
                    ? NSFontManager.shared.convert(weighted, toHaveTrait: .italicFontMask)
                    : weighted
            }
            attributed.addAttribute(.font, value: font, range: range)
            if isStrikethrough {
                attributed.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range)
            }
        }
        return attributed
    }

    private static func heading(in line: String) -> (level: Int, text: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let markerCount = trimmed.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(markerCount),
              trimmed.dropFirst(markerCount).first == " " else { return nil }
        return (markerCount, String(trimmed.dropFirst(markerCount + 1)))
    }

    private static func unorderedListItem(in line: String) -> (depth: Int, text: String)? {
        matchListItem(in: line, regex: unorderedListItemRegex).map { ($0.depth, $0.text) }
    }

    private static func orderedListItem(in line: String) -> (depth: Int, ordinal: String, text: String)? {
        guard let match = orderedListItemRegex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
              let indentRange = Range(match.range(at: 1), in: line),
              let ordinalRange = Range(match.range(at: 2), in: line),
              let textRange = Range(match.range(at: 3), in: line) else { return nil }
        return (String(line[indentRange]).count / 2, String(line[ordinalRange]), String(line[textRange]))
    }

    private static func matchListItem(in line: String, regex: NSRegularExpression) -> (depth: Int, text: String)? {
        guard let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
              let indentRange = Range(match.range(at: 1), in: line),
              let textRange = Range(match.range(at: 2), in: line) else { return nil }
        return (String(line[indentRange]).count / 2, String(line[textRange]))
    }

    private static func blockQuote(in line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix(">") else { return nil }
        return String(trimmed.dropFirst().drop(while: { $0 == " " }))
    }

    private static func isThematicBreak(_ line: String) -> Bool {
        let compact = line.filter { !$0.isWhitespace }
        return compact.count >= 3 && (Set(compact) == ["-"] || Set(compact) == ["*"] || Set(compact) == ["_"])
    }
}

enum NativeMarkdownCompatibility {
    private static let image = try! NSRegularExpression(pattern: #"!\[[^\]]*\]\([^\)]*\)"#)
    private static let taskList = try! NSRegularExpression(
        pattern: #"(?m)^\s*[-+*]\s+\[[ xX]\]\s+"#
    )
    private static let tableDelimiter = try! NSRegularExpression(
        pattern: #"(?m)^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$"#
    )
    private static let fencedCode = try! NSRegularExpression(
        pattern: #"(?m)^\s*(?:```|~~~)"#
    )
    private static let htmlBlock = try! NSRegularExpression(
        pattern: #"(?m)^\s*</?(?:details|summary|table|div|picture|video|audio|iframe)\b"#,
        options: [.caseInsensitive]
    )

    static func requiresFullWidthLayout(_ markdown: String) -> Bool {
        let range = NSRange(markdown.startIndex..., in: markdown)
        return image.firstMatch(in: markdown, range: range) != nil
            || taskList.firstMatch(in: markdown, range: range) != nil
            || tableDelimiter.firstMatch(in: markdown, range: range) != nil
            || fencedCode.firstMatch(in: markdown, range: range) != nil
            || htmlBlock.firstMatch(in: markdown, range: range) != nil
    }
}

enum ChatTimelineRowRouting {
    enum Route: String, Sendable {
        case native
    }

    static func route(for entry: ChatDisplayEntry) -> Route {
        switch entry.kind {
        case .message:
            return .native
        case .process:
            return .native
        }
    }

    static func displayText(for item: CodexThreadItem) -> String {
        let presentation = item.presentationText?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if presentation?.isEmpty == false { return presentation ?? fallback }
        if !fallback.isEmpty { return fallback }
        if !item.title.isEmpty { return item.title }
        return item.type
    }
}

@MainActor
final class NativeMarkdownTextCache {
    private struct Key: Hashable {
        let text: String
        let style: AppKitChatTimelineRow.NativeStyle
    }

    static let shared = NativeMarkdownTextCache()
    private var values: [Key: NSAttributedString] = [:]
    private var accessByKey: [Key: UInt64] = [:]
    private var accessSequence: UInt64 = 0
    private let limit = 1_000
    private let byteLimit = 16 * 1_024 * 1_024
    private var estimatedBytes = 0

    func value(text: String, style: AppKitChatTimelineRow.NativeStyle) -> NSAttributedString {
        let key = Key(text: text, style: style)
        if let cached = values[key] {
            touch(key)
            return cached
        }
        let attributed = NativeMarkdownAttributedText.make(text: text, style: style)
        values[key] = attributed
        touch(key)
        estimatedBytes += estimatedByteCount(for: key, value: attributed)
        while values.count > limit || estimatedBytes > byteLimit,
              let oldest = accessByKey.min(by: { $0.value < $1.value })?.key {
            if let removed = values.removeValue(forKey: oldest) {
                estimatedBytes = max(0, estimatedBytes - estimatedByteCount(for: oldest, value: removed))
            }
            accessByKey[oldest] = nil
        }
        return attributed
    }

    private func touch(_ key: Key) {
        accessSequence &+= 1
        accessByKey[key] = accessSequence
    }

    private func estimatedByteCount(for key: Key, value: NSAttributedString) -> Int {
        // Include the retained key string and headroom for attributed runs/attributes.
        (key.text.utf16.count * 2) + (value.length * 6) + 128
    }
}

/// The single geometry source for native message text. Both cached row heights
/// and the on-screen body use TextKit with the same container width, padding,
/// and attributed content. This prevents a row from being measured with one
/// wrapping engine and rendered with another.
@MainActor
enum NativeTextKitLayout {
    static func height(of attributedText: NSAttributedString, width: CGFloat) -> CGFloat {
        guard attributedText.length > 0 else { return 0 }
        let textStorage = NSTextStorage(attributedString: attributedText)
        let layoutManager = NSLayoutManager()
        let textContainer = NSTextContainer(
            containerSize: NSSize(width: max(1, width), height: .greatestFiniteMagnitude)
        )
        textContainer.lineFragmentPadding = 0
        textContainer.lineBreakMode = .byCharWrapping
        textContainer.widthTracksTextView = false
        textContainer.heightTracksTextView = false
        layoutManager.addTextContainer(textContainer)
        textStorage.addLayoutManager(layoutManager)
        layoutManager.ensureLayout(for: textContainer)
        return ceil(layoutManager.usedRect(for: textContainer).height)
    }
}

/// Final native row geometry, shared by all retained Session hosts. The cache
/// key includes every input that can affect wrapping, so a row is never shown
/// with an estimated height and corrected after the first paint.
@MainActor
final class NativeTimelineLayoutCache {
    struct Layout {
        let attributedText: NSAttributedString
        let cardWidth: CGFloat
        let textHeight: CGFloat
        let rawStatusHeight: CGFloat
        let rowHeight: CGFloat
    }

    private struct Key: Hashable {
        let text: String
        let rawStatusText: String
        let style: AppKitChatTimelineRow.NativeStyle
        let title: String
        let metadata: String
        let isCollaboration: Bool
        let collaborationRoute: NativeCollaborationRoutePresentation?
        let processCount: Int?
        let processDuration: String?
        let processState: AppKitChatTimelineRow.ProcessState
        let isExpanded: Bool
        let showsHeader: Bool
        let actionCount: Int
        let widthBucket: Int
        let imagePaths: [String]
    }

    static let shared = NativeTimelineLayoutCache()
    private var values: [Key: Layout] = [:]
    private var accessByKey: [Key: UInt64] = [:]
    private var accessSequence: UInt64 = 0
    private var estimatedBytes = 0
    private let byteLimit = 64 * 1_024 * 1_024

    func layout(for row: AppKitChatTimelineRow, columnWidth: CGFloat) -> Layout {
        let normalizedWidth = max(120, columnWidth)
        let key = Key(
            text: row.nativeText,
            rawStatusText: row.rawStatusText,
            style: row.nativeStyle,
            title: row.title,
            metadata: row.metadata,
            isCollaboration: row.isCollaboration,
            collaborationRoute: row.collaborationRoute,
            processCount: row.processCount,
            processDuration: row.processDuration,
            processState: row.processState,
            isExpanded: row.isExpanded,
            showsHeader: row.showsHeader,
            actionCount: row.actions.count,
            widthBucket: Int((normalizedWidth * 2).rounded()),
            imagePaths: row.images.map { $0.managedPath }
        )
        if let cached = values[key] {
            touch(key)
            return cached
        }

        let attributed = NativeMarkdownTextCache.shared.value(text: row.nativeText, style: row.nativeStyle)
        let cardWidth = ChatBubbleWidthPolicy.cardWidth(for: row, availableWidth: normalizedWidth)
        let textHeight = row.nativeStyle == .process && !row.isExpanded
            ? 0
            : NativeTextKitLayout.height(
                of: attributed,
                width: max(20, cardWidth - ChatBubbleWidthPolicy.horizontalPadding)
            )
        let rawStatusHeight: CGFloat
        if row.nativeStyle == .process,
           row.isExpanded,
           !row.rawStatusText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let rawStatus = NSAttributedString(
                string: row.rawStatusText,
                attributes: [.font: NSFont.monospacedSystemFont(ofSize: 9.5, weight: .regular)]
            )
            let measuredHeight = NativeTextKitLayout.height(
                of: rawStatus,
                width: max(20, cardWidth - ChatBubbleWidthPolicy.horizontalPadding - 8)
            ) + 8
            rawStatusHeight = min(160, max(48, measuredHeight))
        } else {
            rawStatusHeight = 0
        }
        let rowHeight: CGFloat
        if row.nativeStyle == .process && !row.isExpanded {
            rowHeight = 32
        } else {
            // This exactly matches the native cell's 10pt leading/trailing
            // constraints and the NativeTimelineTextView's TextKit container.
            if row.nativeStyle == .process {
                rowHeight = max(54, textHeight + 48 + (rawStatusHeight > 0 ? rawStatusHeight + 8 : 0))
            } else {
                let footerHeight: CGFloat = row.processCount == nil ? 0 : 24
                let actionHeight: CGFloat = row.actions.isEmpty ? 0 : 34
                let messageActionBarHeight: CGFloat = row.showsMessageActionBar ? 27 : 0
                // Replaces the ordinary 6pt title-to-body gap with
                // 8pt + 92pt summary + 10pt, for a net 104pt addition.
                let collaborationRouteHeight: CGFloat = row.collaborationRoute == nil ? 0 : 104
                let verticalChrome: CGFloat = (row.showsHeader ? 39 : 20) + collaborationRouteHeight
                rowHeight = max(
                    row.showsHeader ? 54 : 30,
                    textHeight + verticalChrome + footerHeight + actionHeight + messageActionBarHeight
                ) + (row.images.isEmpty ? 0 : 96)
            }
        }
        let layout = Layout(
            attributedText: attributed,
            cardWidth: cardWidth,
            textHeight: textHeight,
            rawStatusHeight: rawStatusHeight,
            rowHeight: rowHeight
        )
        values[key] = layout
        touch(key)
        estimatedBytes += ((key.text.utf16.count + key.rawStatusText.utf16.count) * 8) + attributed.length * 8 + 192
        evictIfNeeded()
        return layout
    }

    private func touch(_ key: Key) {
        accessSequence &+= 1
        accessByKey[key] = accessSequence
    }

    private func evictIfNeeded() {
        while estimatedBytes > byteLimit,
              let oldest = accessByKey.min(by: { $0.value < $1.value })?.key {
            accessByKey[oldest] = nil
            guard let removed = values.removeValue(forKey: oldest) else { continue }
            estimatedBytes = max(
                0,
                estimatedBytes
                    - ((oldest.text.utf16.count + oldest.rawStatusText.utf16.count) * 8)
                    - removed.attributedText.length * 8
                    - 192
            )
        }
    }
}

struct AppKitChatTimelineRow: Identifiable {
    enum ProcessState: Hashable {
        case running
        case completed
        case failed
        case cancelled

        var symbolName: String {
            switch self {
            case .running: "ellipsis.circle"
            case .completed: "checkmark.circle.fill"
            case .failed: "exclamationmark.circle.fill"
            case .cancelled: "stop.circle.fill"
            }
        }

        var color: NSColor {
            switch self {
            case .running: .controlAccentColor
            case .completed: .systemGreen
            case .failed: .systemRed
            case .cancelled: .secondaryLabelColor
            }
        }
    }

    struct Action: Identifiable {
        enum Kind {
            case codexApproval(CodexApprovalOption)
            case ptyChoice(CodexApprovalOption, choiceID: String)
            case sendMessage(String)
            case collaborationConfirmation(id: String, approve: Bool)
            case reviewChanges(turnID: String)
            case undoChanges(turnID: String)
        }

        let id: String
        let label: String
        let isDestructive: Bool
        let kind: Kind
    }

    let id: String
    let contentRevision: Int
    let nativeText: String
    let rawStatusText: String
    let copyText: String
    let nativeStyle: NativeStyle
    let title: String
    let metadata: String
    let isCollaboration: Bool
    let collaborationRoute: NativeCollaborationRoutePresentation?
    let expandableTurnId: String?
    let isExpanded: Bool
    let processCount: Int?
    let processDuration: String?
    let processState: ProcessState
    let showsHeader: Bool
    let hoverTimestamp: String
    let actions: [Action]
    let images: [ChatTimelineImage]

    var showsMessageActionBar: Bool {
        !showsHeader
            && !copyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (nativeStyle == .user || nativeStyle == .agent)
    }

    init(
        id: String,
        contentRevision: Int,
        nativeText: String,
        rawStatusText: String = "",
        copyText: String,
        nativeStyle: NativeStyle,
        title: String,
        metadata: String,
        isCollaboration: Bool = false,
        collaborationRoute: NativeCollaborationRoutePresentation? = nil,
        expandableTurnId: String?,
        isExpanded: Bool,
        processCount: Int? = nil,
        processDuration: String? = nil,
        processState: ProcessState = .completed,
        showsHeader: Bool = true,
        hoverTimestamp: String = "",
        actions: [Action] = [],
        images: [ChatTimelineImage] = []
    ) {
        self.id = id
        self.contentRevision = contentRevision
        self.nativeText = nativeText
        self.rawStatusText = rawStatusText
        self.copyText = copyText
        self.nativeStyle = nativeStyle
        self.title = title
        self.metadata = metadata
        self.isCollaboration = isCollaboration
        self.collaborationRoute = collaborationRoute
        self.expandableTurnId = expandableTurnId
        self.isExpanded = isExpanded
        self.processCount = processCount
        self.processDuration = processDuration
        self.processState = processState
        self.showsHeader = showsHeader
        self.hoverTimestamp = hoverTimestamp
        self.actions = actions
        self.images = images
    }

    enum NativeStyle: Hashable {
        case user
        case agent
        case process
    }

    var processSummary: String {
        let count = processCount ?? 0
        let steps = "\(count) \(count == 1 ? "step" : "steps")"
        let normalizedDuration = processDuration?
            .replacingOccurrences(of: "·", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        switch processState {
        case .running:
            if let normalizedDuration, !normalizedDuration.isEmpty {
                return "Working for \(normalizedDuration) · \(steps)"
            }
            return "Working… · \(steps)"
        case .completed:
            if let normalizedDuration, !normalizedDuration.isEmpty {
                return "Worked for \(normalizedDuration) · \(steps)"
            }
            return "Completed · \(steps)"
        case .failed:
            if let normalizedDuration, !normalizedDuration.isEmpty {
                return "Execution failed after \(normalizedDuration) · \(steps)"
            }
            return "Execution failed · \(steps)"
        case .cancelled:
            if let normalizedDuration, !normalizedDuration.isEmpty {
                return "Execution stopped after \(normalizedDuration) · \(steps)"
            }
            return "Execution stopped · \(steps)"
        }
    }
}

struct ChatTimelineImage: Hashable {
    let managedPath: String
    let displayURL: URL?
    let originalPath: String?
}

struct AppKitChatRowReuseIdentity: Equatable {
    let id: String
    let contentRevision: Int
}

enum AppKitChatRowReusePolicy {
    static func commonPrefixCount(
        previous: [AppKitChatRowReuseIdentity],
        next: [AppKitChatRowReuseIdentity]
    ) -> Int {
        zip(previous, next).prefix(while: ==).count
    }
}

/// Deterministic width contract for native AppKit timeline rows.
@MainActor
enum ChatBubbleWidthPolicy {
    static let maximumWidth: CGFloat = 480
    // The previous 88pt floor existed to fit the removed title/metadata row.
    // A plain message now only needs enough room for its body and card padding.
    static let minimumWidth: CGFloat = 40
    static let horizontalPadding: CGFloat = 20
    static let collapsedProcessWidth: CGFloat = 180

    static func preferredWidth(
        text: String,
        style: AppKitChatTimelineRow.NativeStyle,
        title: String,
        metadata: String,
        processWidth: CGFloat = 0,
        availableWidth: CGFloat = maximumWidth
    ) -> CGFloat {
        let available = max(minimumWidth, min(maximumWidth, availableWidth))
        let bodyWidth: CGFloat
        if NativeMarkdownCompatibility.requiresFullWidthLayout(text) {
            // Rich blocks (images, tables, fenced code, HTML) need the full
            // content lane; their natural width is not represented by text
            // glyph bounds alone.
            bodyWidth = maximumWidth - horizontalPadding
        } else {
            let attributed = NativeMarkdownTextCache.shared.value(text: text, style: style)
            bodyWidth = ceil(attributed.boundingRect(
                with: NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading]
            ).width)
        }
        let titleWidth = ceil((title as NSString).size(withAttributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .bold)
        ]).width)
        let metadataWidth = ceil((metadata as NSString).size(withAttributes: [
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold)
        ]).width)
        let headerWidth = titleWidth + metadataWidth + 12
        return min(
            available,
            max(minimumWidth, max(bodyWidth, headerWidth, processWidth) + horizontalPadding)
        )
    }

    static func cardWidth(for row: AppKitChatTimelineRow, availableWidth: CGFloat) -> CGFloat {
        let fullAvailableWidth = max(minimumWidth, availableWidth - 4)
        if row.nativeStyle == .process {
            guard !row.isExpanded else { return fullAvailableWidth }
            let summaryWidth = ceil((row.processSummary as NSString).size(withAttributes: [
                .font: NSFont.systemFont(ofSize: 10.5, weight: .medium)
            ]).width)
            return min(fullAvailableWidth, max(collapsedProcessWidth, summaryWidth + 58))
        }
        if row.collaborationRoute != nil {
            return min(fullAvailableWidth, maximumWidth)
        }
        let preferred = preferredWidth(
            text: row.nativeText,
            style: row.nativeStyle,
            title: row.showsHeader ? row.title : "",
            metadata: row.showsHeader ? row.metadata : "",
            processWidth: row.processCount == nil ? 0 : collapsedProcessWidth,
            availableWidth: fullAvailableWidth
        )
        return row.images.isEmpty ? preferred : min(fullAvailableWidth, max(220, preferred))
    }
}

struct NativeCollaborationRoutePresentation: Hashable {
    enum DestinationKind: Hashable {
        case existingSession
        case newCorptieTask
    }

    let destinationKind: DestinationKind
    let routeLabel: String
    let sourceLabel: String
    let sourceSession: String
    let sourceWork: String
    let targetLabel: String
    let targetName: String
    let targetWork: String
}

struct AppKitChatTimelinePosition: Codable, Equatable, Sendable {
    let rowID: String
    let offset: Double
    let absoluteScrollY: Double
    let followsLatest: Bool
}

enum LiveResizeRowReflowPolicy {
    static func indexes(
        rowCount: Int,
        visibleRows: NSRange,
        isLiveResize: Bool
    ) -> IndexSet {
        guard rowCount > 0 else { return [] }
        guard isLiveResize else { return IndexSet(integersIn: 0..<rowCount) }
        guard visibleRows.location != NSNotFound else { return [] }
        let lowerBound = min(rowCount, visibleRows.location)
        let upperBound = min(rowCount, visibleRows.location + visibleRows.length)
        return IndexSet(integersIn: lowerBound..<upperBound)
    }
}

enum LiveResizeWidthPolicy {
    static let bucketSize: CGFloat = 8

    static func measurementWidth(_ width: CGFloat, isLiveResize: Bool) -> CGFloat {
        let normalized = max(120, width)
        guard isLiveResize else { return normalized }
        return max(bucketSize, (normalized / bucketSize).rounded() * bucketSize)
    }

    static func requiresReflow(previous: CGFloat?, next: CGFloat) -> Bool {
        guard let previous else { return true }
        return abs(previous - next) >= 0.5
    }
}

struct AppKitChatTimelineView: NSViewRepresentable {
    let sessionID: String
    let rows: [AppKitChatTimelineRow]
    let scrollToBottomRevision: Int
    var baseDirectory: String? = nil
    @Binding var followsLatest: Bool
    let onToggleExpansion: (String) -> Void
    var onAction: (AppKitChatTimelineRow.Action) -> Void = { _ in }
    var onNearTop: () -> Void = {}
    var hasMoreHistory: Bool = false
    var onUnderfilledHistory: () -> Void = {}
    var initialPosition: AppKitChatTimelinePosition? = nil
    var onPositionChange: (AppKitChatTimelinePosition) -> Void = { _ in }
    var scrollToTurnID: String? = nil
    var scrollToTurnRevision: Int = 0
    var historyRequestEpoch: Int = 0

    nonisolated static func rowIndex(forTurnID turnID: String, in rows: [AppKitChatTimelineRow]) -> Int? {
        rows.firstIndex(where: {
            $0.id == turnID || $0.expandableTurnId == turnID || $0.id.contains(turnID)
        })
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            sessionID: sessionID,
            baseDirectory: baseDirectory,
            followsLatest: $followsLatest,
            onToggleExpansion: onToggleExpansion,
            onAction: onAction,
            onNearTop: onNearTop,
            hasMoreHistory: hasMoreHistory,
            onUnderfilledHistory: onUnderfilledHistory,
            onPositionChange: onPositionChange
        )
    }

    func makeNSView(context: Context) -> NSScrollView {
        let tableView = Self.makeTableView()
        let scrollView = Self.makeScrollView(tableView: tableView)

        context.coordinator.attach(tableView: tableView, scrollView: scrollView)
        if let initialPosition, !initialPosition.followsLatest {
            context.coordinator.prepareInitialPosition(initialPosition)
        } else {
            context.coordinator.prepareInitialScrollToBottom()
        }
        context.coordinator.apply(rows: rows, animated: false)
        context.coordinator.lastScrollToBottomRevision = scrollToBottomRevision
        context.coordinator.lastScrollToTurnRevision = scrollToTurnRevision
        context.coordinator.lastHistoryRequestEpoch = historyRequestEpoch
        return scrollView
    }

    static func dismantleNSView(_ scrollView: NSScrollView, coordinator: Coordinator) {
        // A Session switch removes this host immediately. Flush the viewport
        // synchronously so the 120ms scroll debounce cannot lose the user's
        // last position while the coordinator is being released.
        coordinator.publishPositionImmediately()
    }

    static func makeTableView() -> NSTableView {
        let tableView = IntrinsicHeightTableView()
        // Modern macOS otherwise chooses the inset table style. That inset is
        // outside the column: a viewport-wide chat column is shifted right and
        // its trailing edge gets clipped. Cards own their spacing, so the table
        // itself must stay edge-to-edge.
        tableView.style = .plain
        tableView.headerView = nil
        tableView.backgroundColor = .clear
        tableView.gridStyleMask = []
        tableView.intercellSpacing = NSSize(width: 0, height: 10)
        tableView.rowHeight = 30
        // Every row has an exact cached height from the delegate. Automatic
        // row heights make NSTableView assign its 120pt estimate to offscreen
        // rows; a direct scrollbar jump can then land in an unmaterialized
        // blank region before those estimates are corrected.
        tableView.usesAutomaticRowHeights = false
        tableView.selectionHighlightStyle = .none
        tableView.allowsEmptySelection = true
        tableView.focusRingType = .none
        tableView.columnAutoresizingStyle = .noColumnAutoresizing
        let column = NSTableColumn(identifier: Coordinator.columnIdentifier)
        column.resizingMask = []
        tableView.addTableColumn(column)
        return tableView
    }

    static func makeScrollView(tableView: NSTableView) -> NSScrollView {
        let scrollView = FirstLayoutRestoringScrollView()
        scrollView.contentView = NSClipView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.verticalScrollElasticity = .none
        scrollView.horizontalScrollElasticity = .none
        scrollView.documentView = tableView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.switchSessionIfNeeded(
            to: sessionID,
            initialPosition: initialPosition
        )
        context.coordinator.updateBaseDirectory(baseDirectory)
        context.coordinator.onToggleExpansion = onToggleExpansion
        context.coordinator.onAction = onAction
        context.coordinator.onNearTop = onNearTop
        context.coordinator.onUnderfilledHistory = onUnderfilledHistory
        context.coordinator.updateHistoryAvailability(hasMoreHistory)
        context.coordinator.onPositionChange = onPositionChange
        context.coordinator.apply(rows: rows, animated: context.transaction.animation != nil)
        if let initialPosition {
            context.coordinator.restoreIfNeeded(position: initialPosition)
        }
        if context.coordinator.lastScrollToBottomRevision != scrollToBottomRevision {
            context.coordinator.lastScrollToBottomRevision = scrollToBottomRevision
            context.coordinator.scrollToBottom()
        }
        if context.coordinator.lastScrollToTurnRevision != scrollToTurnRevision {
            context.coordinator.lastScrollToTurnRevision = scrollToTurnRevision
            if let scrollToTurnID { context.coordinator.scrollToTurn(scrollToTurnID) }
        }
        if context.coordinator.lastHistoryRequestEpoch != historyRequestEpoch {
            context.coordinator.lastHistoryRequestEpoch = historyRequestEpoch
            context.coordinator.rearmHistoryRequest()
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        static let columnIdentifier = NSUserInterfaceItemIdentifier("chat.timeline.column")
        private static let nativeCellIdentifier = NSUserInterfaceItemIdentifier("chat.timeline.native.cell")

        private let followsLatestBinding: Binding<Bool>
        var onToggleExpansion: (String) -> Void
        var onAction: (AppKitChatTimelineRow.Action) -> Void
        var onNearTop: () -> Void
        var onUnderfilledHistory: () -> Void
        var onPositionChange: (AppKitChatTimelinePosition) -> Void
        private var representedSessionID: String
        private var baseDirectory: String?
        private weak var tableView: NSTableView?
        private weak var scrollView: NSScrollView?
        private var rows: [AppKitChatTimelineRow] = []
        private var revisionsByID: [String: Int] = [:]
        private var heightCache: [HeightCacheKey: CGFloat] = [:]
        private var cellsByKey: [CellCacheKey: AppKitChatNativeTextCell] = [:]
        private var cellRecency: [CellCacheKey] = []
        private var lastMeasuredWidth: CGFloat = 0
        private var scrollCommandGeneration = 0
        private var nearTopSuppressionGeneration = 0
        private var suppressesNearTopTrigger = false
        private var suppressesLayoutDrivenFollowReconciliation = false
        var lastScrollToBottomRevision = Int.min
        var lastScrollToTurnRevision = Int.min
        var lastHistoryRequestEpoch = Int.min
        var followsLatest = true
        private var nearTopTriggered = false
        private var hasMoreHistory = false
        private var underfilledHistoryRequestCount = 0
        private var lastUnderfilledHistoryRequestSignature: String?
        private var underfilledHistoryEvaluationGeneration = 0
        private var positionPublishCorptieTask: DispatchWorkItem?
        private var lastPublishedPosition: AppKitChatTimelinePosition?
        private var pendingRestorePosition: AppKitChatTimelinePosition?
        private var lastRequestedRestorePosition: AppKitChatTimelinePosition?
        private var pendingInitialScrollToBottom = false
        private var deferredEmptyProjectionViewport: DeferredEmptyProjectionViewport?
        private var isRestoringInitialViewport = false
        private var isAwaitingSessionRows = false
        private var userOwnsViewport = false
        private var isProcessingUserScrollEvent = false
        private var needsExactWidthReflow = false
        private var lastReflowMeasurementWidth: CGFloat?

        /// The timeline width is a parent-owned layout input. Reserving a
        /// legacy scroller gutter unconditionally prevents the feedback loop
        /// where content height toggles the scroller, changes text width, and
        /// makes a two-line message become three lines after it is visible.
        private static let verticalScrollerGutter = NSScroller.scrollerWidth(
            for: .regular,
            scrollerStyle: .legacy
        )

        private struct HeightCacheKey: Hashable {
            let sessionID: String
            let id: String
            let revision: Int
            let widthBucket: Int
            let isLiveResizeApproximation: Bool
        }

        private struct CellCacheKey: Hashable {
            let sessionID: String
            let rowID: String
            let revision: Int
        }

        /// An async display projection can briefly publish an empty row set
        /// for the same Session while loading or replacing its cached window.
        /// NSTableView clamps that zero-height document to y=0, so retain the
        /// semantic reader position until rows return instead of interpreting
        /// AppKit's clamp as a request to show the oldest message.
        private struct DeferredEmptyProjectionViewport {
            let anchor: (id: String, offset: CGFloat)?
            let previousIDs: [String]
            let followsLatest: Bool
        }

        init(
            sessionID: String = "test-session",
            baseDirectory: String? = nil,
            followsLatest: Binding<Bool>,
            onToggleExpansion: @escaping (String) -> Void,
            onAction: @escaping (AppKitChatTimelineRow.Action) -> Void = { _ in },
            onNearTop: @escaping () -> Void = {},
            hasMoreHistory: Bool = false,
            onUnderfilledHistory: @escaping () -> Void = {},
            onPositionChange: @escaping (AppKitChatTimelinePosition) -> Void = { _ in }
        ) {
            self.representedSessionID = sessionID
            self.baseDirectory = Self.normalizedBaseDirectory(baseDirectory)
            self.followsLatestBinding = followsLatest
            self.onToggleExpansion = onToggleExpansion
            self.onAction = onAction
            self.onNearTop = onNearTop
            self.hasMoreHistory = hasMoreHistory
            self.onUnderfilledHistory = onUnderfilledHistory
            self.onPositionChange = onPositionChange
        }

        /// Rebinds the existing NSTableView to another Session. The old
        /// semantic viewport is published through the old callback before the
        /// callback and row model change; native cells and the reuse queue stay
        /// alive, while Session-specific height/revision state is discarded.
        func switchSessionIfNeeded(
            to sessionID: String,
            initialPosition: AppKitChatTimelinePosition?
        ) {
            guard representedSessionID != sessionID else { return }
            publishPositionImmediately()
            positionPublishCorptieTask?.cancel()
            positionPublishCorptieTask = nil
            scrollCommandGeneration &+= 1
            nearTopSuppressionGeneration &+= 1
            suppressesNearTopTrigger = false
            suppressesLayoutDrivenFollowReconciliation = false
            representedSessionID = sessionID
            rows.removeAll(keepingCapacity: true)
            revisionsByID.removeAll(keepingCapacity: true)
            lastPublishedPosition = nil
            lastRequestedRestorePosition = nil
            pendingRestorePosition = nil
            pendingInitialScrollToBottom = false
            deferredEmptyProjectionViewport = nil
            userOwnsViewport = false
            nearTopTriggered = false
            underfilledHistoryRequestCount = 0
            lastUnderfilledHistoryRequestSignature = nil
            underfilledHistoryEvaluationGeneration &+= 1
            isAwaitingSessionRows = true
            tableView?.reloadData()
            if let initialPosition, !initialPosition.followsLatest {
                prepareInitialPosition(initialPosition)
            } else {
                prepareInitialScrollToBottom()
            }
        }

        func restoreIfNeeded(position: AppKitChatTimelinePosition) {
            guard !userOwnsViewport else { return }
            // `followsLatest` is a semantic bottom position. Its row ID is
            // only the last published observation and must never become an
            // anchor after a Session rebind; the initial-bottom path already
            // owns that restoration. Only explicit history-reading positions
            // are eligible for row-anchor restoration.
            guard !position.followsLatest else { return }
            guard position != lastRequestedRestorePosition else { return }
            restore(position: position)
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }

        func attach(tableView: NSTableView, scrollView: NSScrollView) {
            self.tableView = tableView
            self.scrollView = scrollView
            if let firstLayoutScrollView = scrollView as? FirstLayoutRestoringScrollView {
                firstLayoutScrollView.onLayout = { [weak self] in
                    self?.restoreInitialViewportSynchronouslyIfNeeded()
                }
                firstLayoutScrollView.onUserScrollWillBegin = { [weak self] in
                    self?.userScrollEventWillBegin()
                }
                firstLayoutScrollView.onUserScrollDidEnd = { [weak self] in
                    self?.userScrollEventDidEnd()
                }
            }
            tableView.dataSource = self
            tableView.delegate = self
            scrollView.postsFrameChangedNotifications = true
            tableView.postsFrameChangedNotifications = true
            scrollView.contentView.postsBoundsChangedNotifications = true
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(viewportBoundsDidChange(_:)),
                name: NSView.boundsDidChangeNotification,
                object: scrollView.contentView
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(containerFrameDidChange(_:)),
                name: NSView.frameDidChangeNotification,
                object: scrollView
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(windowDidEndLiveResize(_:)),
                name: NSWindow.didEndLiveResizeNotification,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(capturePositionForTermination(_:)),
                name: .captureSessionTimelinePositions,
                object: nil
            )
            synchronizeTableWidth()
        }

        func updateBaseDirectory(_ nextBaseDirectory: String?) {
            let normalized = Self.normalizedBaseDirectory(nextBaseDirectory)
            guard normalized != baseDirectory else { return }
            baseDirectory = normalized
            for cell in cellsByKey.values {
                cell.updateLinkContext(baseDirectory: normalized)
            }
        }

        private static func normalizedBaseDirectory(_ value: String?) -> String? {
            guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty else { return nil }
            return value
        }

        func numberOfRows(in tableView: NSTableView) -> Int {
            rows.count
        }

        func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
            guard rows.indices.contains(row) else { return tableView.rowHeight }
            let item = rows[row]
            let columnWidth = max(120, tableView.tableColumns.first?.width ?? tableView.bounds.width)
            let isLiveResize = tableView.window?.inLiveResize == true
            let measurementWidth = LiveResizeWidthPolicy.measurementWidth(
                columnWidth,
                isLiveResize: isLiveResize
            )
            let key = HeightCacheKey(
                sessionID: representedSessionID,
                id: item.id,
                revision: item.contentRevision,
                widthBucket: Int((measurementWidth * 2).rounded()),
                isLiveResizeApproximation: isLiveResize
            )
            if let cached = heightCache[key] { return cached }

            let height = NativeTimelineLayoutCache.shared.layout(
                for: item,
                columnWidth: measurementWidth
            ).rowHeight
            if heightCache.count >= 20_000 {
                heightCache.removeAll(keepingCapacity: true)
            }
            heightCache[key] = height
            return height
        }


        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            guard rows.indices.contains(row) else { return nil }
            let rowModel = rows[row]
            let cacheKey = CellCacheKey(
                sessionID: representedSessionID,
                rowID: rowModel.id,
                revision: rowModel.contentRevision
            )
            let availableWidth = tableView.tableColumns.first?.width ?? tableView.bounds.width
            if let cachedCell = cellsByKey[cacheKey] {
                touchCell(cacheKey)
                cachedCell.updateCallbacks(
                    onToggleExpansion: onToggleExpansion,
                    onAction: onAction
                )
                cachedCell.updateLinkContext(baseDirectory: baseDirectory)
                _ = cachedCell.updateLayoutIfContentUnchanged(
                    rowModel,
                    availableWidth: availableWidth
                )
                return cachedCell
            }
            let cell = (tableView.makeView(withIdentifier: Self.nativeCellIdentifier, owner: nil) as? AppKitChatNativeTextCell)
                ?? {
                    ChatPerformanceRecorder.shared.increment(.appKitCellsCreated)
                    return AppKitChatNativeTextCell(identifier: Self.nativeCellIdentifier)
                }()
            cellsByKey = cellsByKey.filter { $0.value !== cell }
            cellRecency.removeAll { cellsByKey[$0] == nil }
            ChatPerformanceRecorder.shared.increment(.appKitRowsConfigured)
            cell.setContent(
                rowModel,
                availableWidth: availableWidth,
                baseDirectory: baseDirectory,
                onToggleExpansion: onToggleExpansion,
                onAction: onAction
            )
            cellsByKey[cacheKey] = cell
            touchCell(cacheKey)
            while cellRecency.count > 96, let oldest = cellRecency.first {
                cellRecency.removeFirst()
                cellsByKey[oldest] = nil
            }
            return cell
        }

        private func touchCell(_ key: CellCacheKey) {
            cellRecency.removeAll { $0 == key }
            cellRecency.append(key)
        }

        func apply(rows nextRows: [AppKitChatTimelineRow], animated: Bool = false) {
            let nextRows = Self.uniquedRows(nextRows)
            suppressNearTopDuringLayout()
            guard let tableView else {
                rows = nextRows
                revisionsByID = Dictionary(uniqueKeysWithValues: nextRows.map { ($0.id, $0.contentRevision) })
                return
            }
            let oldIDs = rows.map(\.id)
            let newIDs = nextRows.map(\.id)
            let oldRevisions = revisionsByID
            let oldTailRevision = rows.last.map { "\($0.id):\($0.contentRevision)" }
            let newTailRevision = nextRows.last.map { "\($0.id):\($0.contentRevision)" }
            // The AppKit viewport is the source of truth while this host is
            // mounted. SwiftUI publishes the same value asynchronously, so a
            // high-frequency tail update (notably an active Goal) can arrive
            // before a user's scroll-away has propagated through the binding.
            // Sampling geometry before changing row heights prevents that
            // stale `true` from pinning the reader back to the newest card.
            let followedLatestBeforeUpdate = followsLatest && isViewportNearBottom()
            synchronizeTableWidth()
            let width = tableView.tableColumns.first?.width ?? tableView.bounds.width
            let hasPendingInitialViewport = pendingRestorePosition != nil || pendingInitialScrollToBottom
            if nextRows.isEmpty,
               !rows.isEmpty,
               !hasPendingInitialViewport {
                deferredEmptyProjectionViewport = DeferredEmptyProjectionViewport(
                    anchor: visibleAnchor(in: tableView),
                    previousIDs: oldIDs,
                    followsLatest: followedLatestBeforeUpdate
                )
            }
            let returningFromEmptyProjection = rows.isEmpty && !nextRows.isEmpty
                ? deferredEmptyProjectionViewport
                : nil
            let prependAnchor = !followedLatestBeforeUpdate && !hasPendingInitialViewport
                ? visibleAnchor(in: tableView)
                : nil
            if abs(width - lastMeasuredWidth) >= 1 {
                lastMeasuredWidth = width
                heightCache.removeAll(keepingCapacity: true)
                if tableView.numberOfRows > 0 {
                    tableView.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<tableView.numberOfRows))
                }
            }
            rows = nextRows
            revisionsByID = Dictionary(uniqueKeysWithValues: nextRows.map { ($0.id, $0.contentRevision) })

            if isAwaitingSessionRows {
                isAwaitingSessionRows = false
                tableView.reloadData()
                synchronizeDocumentHeight(in: tableView)
                restoreInitialViewportSynchronouslyIfNeeded()
                schedulePendingInitialViewportRestoreIfNeeded()
                return
            }

            guard oldIDs == newIDs else {
                applyStructuralDifference(
                    from: oldIDs,
                    to: newIDs,
                    oldRevisions: oldRevisions,
                    in: tableView
                )
                synchronizeDocumentHeight(in: tableView)
                if followedLatestBeforeUpdate, !pendingInitialScrollToBottom {
                    scrollToBottom()
                } else if let returningFromEmptyProjection {
                    deferredEmptyProjectionViewport = nil
                    if returningFromEmptyProjection.followsLatest {
                        scrollToBottom()
                    } else if let anchor = returningFromEmptyProjection.anchor,
                              restoreClosestAvailableAnchor(
                                  anchor,
                                  previousIDs: returningFromEmptyProjection.previousIDs,
                                  in: tableView
                              ) {
                        // The semantic row returned; its relative offset is
                        // restored asynchronously after AppKit finishes the
                        // structural insertion.
                    } else {
                        // A wholly replaced or deleted row window has no safe
                        // cross-revision absolute-Y fallback. Match ordinary
                        // missing-anchor restoration and degrade to latest.
                        scrollToBottom()
                    }
                } else if let prependAnchor {
                    restoreClosestAvailableAnchor(
                        prependAnchor,
                        previousIDs: oldIDs,
                        in: tableView
                    )
                }
                // Reused Session hosts may already have completed an empty
                // layout pass before their rows arrive. Restore immediately
                // when geometry is valid; the scroll-view layout callback and
                // async scheduler remain fallbacks for zero-sized new hosts.
                restoreInitialViewportSynchronouslyIfNeeded()
                schedulePendingInitialViewportRestoreIfNeeded()
                return
            }

            let changed = IndexSet(nextRows.indices.filter { index in
                oldRevisions[nextRows[index].id] != nextRows[index].contentRevision
            })
            guard !changed.isEmpty else { return }
            heightCache = heightCache.filter { key, _ in
                key.sessionID != representedSessionID
                    || !changed.contains { index in nextRows[index].id == key.id }
            }
            for row in changed {
                let currentCell = tableView.view(atColumn: 0, row: row, makeIfNecessary: false)
                if let nativeCell = currentCell as? AppKitChatNativeTextCell {
                    nativeCell.setContent(
                        nextRows[row],
                        availableWidth: tableView.tableColumns.first?.width ?? tableView.bounds.width,
                        onToggleExpansion: onToggleExpansion,
                        onAction: onAction
                    )
                }
            }
            tableView.noteHeightOfRows(withIndexesChanged: changed)
            synchronizeDocumentHeight(in: tableView)
            if followedLatestBeforeUpdate,
               !pendingInitialScrollToBottom,
               oldTailRevision != newTailRevision {
                scrollToBottom()
            } else if let prependAnchor {
                restore(anchor: prependAnchor, in: tableView)
            }
            restoreInitialViewportSynchronouslyIfNeeded()
            schedulePendingInitialViewportRestoreIfNeeded()
        }

        private func applyStructuralDifference(
            from oldIDs: [String],
            to newIDs: [String],
            oldRevisions: [String: Int],
            in tableView: NSTableView
        ) {
            let difference = newIDs.difference(from: oldIDs)
            var removals = IndexSet()
            var insertions = IndexSet()
            for change in difference {
                switch change {
                case .remove(let offset, _, _): removals.insert(offset)
                case .insert(let offset, _, _): insertions.insert(offset)
                }
            }

            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0
                context.allowsImplicitAnimation = false
                tableView.beginUpdates()
                if !removals.isEmpty {
                    tableView.removeRows(at: removals, withAnimation: [])
                }
                if !insertions.isEmpty {
                    tableView.insertRows(at: insertions, withAnimation: [])
                }
                tableView.endUpdates()
            }

            let changedSurvivors = IndexSet(newIDs.indices.filter { index in
                !insertions.contains(index)
                    && oldRevisions[newIDs[index]] != rows[index].contentRevision
            })
            if !changedSurvivors.isEmpty {
                tableView.reloadData(
                    forRowIndexes: changedSurvivors,
                    columnIndexes: IndexSet(integer: 0)
                )
                tableView.noteHeightOfRows(withIndexesChanged: changedSurvivors)
            }
        }

        private func synchronizeDocumentHeight(in tableView: NSTableView) {
            tableView.layoutSubtreeIfNeeded()
            let contentHeight = rows.isEmpty
                ? 0
                : tableView.rect(ofRow: rows.count - 1).maxY
            if abs(tableView.frame.height - contentHeight) >= 0.5 {
                tableView.setFrameSize(NSSize(width: tableView.frame.width, height: contentHeight))
            }
            scheduleUnderfilledHistoryEvaluation()
        }

        func updateHistoryAvailability(_ hasMoreHistory: Bool) {
            let becameAvailable = hasMoreHistory && !self.hasMoreHistory
            self.hasMoreHistory = hasMoreHistory
            if becameAvailable {
                scheduleUnderfilledHistoryEvaluation()
            }
        }

        /// A raw-event page can collapse to only one or two semantic chat
        /// rows. In that case the document has no scroll range, so an active
        /// wheel/scrollbar gesture can never reach `onNearTop`. Bootstrap a
        /// bounded number of additional pages from actual geometry while
        /// keeping ordinary programmatic bounds changes ineligible for the
        /// user-driven history path.
        private func scheduleUnderfilledHistoryEvaluation() {
            underfilledHistoryEvaluationGeneration &+= 1
            let generation = underfilledHistoryEvaluationGeneration
            DispatchQueue.main.async { [weak self] in
                guard let self,
                      self.underfilledHistoryEvaluationGeneration == generation,
                      self.hasMoreHistory,
                      self.underfilledHistoryRequestCount < 4,
                      let tableView = self.tableView,
                      let clipView = self.scrollView?.contentView,
                      !self.rows.isEmpty,
                      clipView.bounds.height > 1 else { return }
                let contentHeight = tableView.rect(ofRow: self.rows.count - 1).maxY
                guard contentHeight <= clipView.bounds.height + 0.5 else { return }
                let signature = "\(self.representedSessionID)|\(self.rows.map(\.id).joined(separator: ","))"
                guard signature != self.lastUnderfilledHistoryRequestSignature else { return }
                self.lastUnderfilledHistoryRequestSignature = signature
                self.underfilledHistoryRequestCount += 1
                self.onUnderfilledHistory()
            }
        }

        func scrollToBottom() {
            guard !isProcessingUserScrollEvent,
                  let tableView else { return }
            // Explicit jump-to-latest and automatic follow both opt in here.
            // If the user leaves the bottom before the queued layout pass,
            // viewportDidScroll flips this back to false and the command is
            // discarded instead of pulling the reader down again.
            followsLatest = true
            deferredEmptyProjectionViewport = nil
            pendingRestorePosition = nil
            if !followsLatestBinding.wrappedValue {
                followsLatestBinding.wrappedValue = true
            }
            guard !rows.isEmpty else {
                // An explicit jump can race the same transient empty
                // projection handled above. Keep that intent authoritative
                // until the replacement rows acquire usable geometry.
                pendingInitialScrollToBottom = true
                schedulePendingInitialViewportRestoreIfNeeded()
                return
            }
            pendingInitialScrollToBottom = false
            suppressNearTopDuringLayout()
            scrollCommandGeneration &+= 1
            let generation = scrollCommandGeneration
            DispatchQueue.main.async { [weak self, weak tableView] in
                guard let self,
                      self.scrollCommandGeneration == generation,
                      let tableView,
                      !self.rows.isEmpty else { return }
                tableView.layoutSubtreeIfNeeded()
                self.synchronizeDocumentHeight(in: tableView)
                guard let clipView = self.scrollView?.contentView else { return }
                let lastRowRect = tableView.rect(ofRow: self.rows.count - 1)
                let bottomOrigin = max(0, lastRowRect.maxY - clipView.bounds.height)
                clipView.scroll(to: NSPoint(x: 0, y: bottomOrigin))
                self.scrollView?.reflectScrolledClipView(clipView)
            }
        }

        private func isViewportNearBottom() -> Bool {
            guard let scrollView, let tableView, !rows.isEmpty else {
                return followsLatest
            }
            let visibleMaxY = scrollView.contentView.bounds.maxY
            let contentMaxY = tableView.rect(ofRow: rows.count - 1).maxY
            return contentMaxY - visibleMaxY <= 8
        }

        func viewportDidScroll(userInitiated: Bool? = nil) {
            guard let scrollView, !rows.isEmpty else { return }
            let eventType = NSApp.currentEvent?.type
            let eventIsUserInitiated = eventType == .scrollWheel
                || eventType == .leftMouseDown
                || eventType == .leftMouseDragged
            let acceptsHistoryRequest = userInitiated
                ?? (isProcessingUserScrollEvent || eventIsUserInitiated)
            if acceptsHistoryRequest {
                userDidBeginScrolling()
            }
            // Row remeasurement temporarily moves the bottom farther away
            // before the queued follow correction runs. That AppKit bounds
            // notification is geometry feedback, not reader intent: letting
            // it clear `followsLatest` can cancel the correction and strand a
            // streaming reply in history. A real wheel/scroller gesture still
            // bypasses this guard and owns the viewport immediately.
            if !acceptsHistoryRequest && suppressesLayoutDrivenFollowReconciliation {
                return
            }
            updateFollowStateFromViewport()

            // 滚动到顶时触发一次历史补拉（微信/Discord 式「上滑自动加载」）。
            // 离开顶部后复位，允许再次触发。
            let visibleMinY = scrollView.contentView.bounds.minY
            let nearTop = visibleMinY <= 8
            // Only an active wheel/trackpad gesture may request history. Row
            // reflow, document-height synchronization, and anchor restoration
            // also emit bounds changes; treating those as user intent was able
            // to prepend history after a tiny wheel delta and visibly jump the
            // reader toward the oldest message.
            if nearTop && acceptsHistoryRequest
                && !nearTopTriggered && !suppressesNearTopTrigger {
                nearTopTriggered = true
                onNearTop()
            } else if !nearTop {
                nearTopTriggered = false
            }
            schedulePositionPublish()
        }

        @objc private func viewportBoundsDidChange(_ notification: Notification) {
            viewportDidScroll()
        }

        /// User input is the highest viewport authority. Cancel every queued
        /// follow/restore/compensation command before AppKit applies the wheel
        /// delta, so no later layout block can reverse the gesture.
        func userDidBeginScrolling() {
            // A rebound Session can receive a wheel event before its first
            // non-zero layout. Its viewport is still at AppKit's default y=0,
            // not at a user-selected position. Preserve the pending semantic
            // restore; cancelling it here made the first wheel after returning
            // to a latest-following Session strand the viewport at the top.
            guard !isAwaitingSessionRows,
                  pendingRestorePosition == nil,
                  !pendingInitialScrollToBottom else { return }
            scrollCommandGeneration &+= 1
            pendingRestorePosition = nil
            pendingInitialScrollToBottom = false
            userOwnsViewport = true
            followsLatest = false
            if followsLatestBinding.wrappedValue { followsLatestBinding.wrappedValue = false }
        }

        func userScrollEventWillBegin() {
            // Complete a ready first-frame restore before granting the gesture
            // viewport ownership. If geometry is not ready, userDidBeginScrolling
            // leaves the restore pending for the next layout pass.
            restoreInitialViewportSynchronouslyIfNeeded()
            isProcessingUserScrollEvent = true
            userDidBeginScrolling()
        }

        func userScrollEventDidEnd() {
            // A wheel/trackpad gesture at the bottom can be fully clamped by
            // the scroll boundary. AppKit then emits no bounds-change event,
            // so `userDidBeginScrolling()` would otherwise leave follow mode
            // false even though the viewport never left the latest region.
            // Reconcile once from final geometry after every user gesture.
            viewportDidScroll(userInitiated: true)
            isProcessingUserScrollEvent = false
            updateFollowStateFromViewport()
        }

        func rearmHistoryRequest() {
            nearTopTriggered = false
        }

        private func updateFollowStateFromViewport() {
            guard !rows.isEmpty else { return }
            let nearBottom = isViewportNearBottom()
            followsLatest = nearBottom
            if followsLatestBinding.wrappedValue != nearBottom {
                followsLatestBinding.wrappedValue = nearBottom
            }
        }

        @objc private func containerFrameDidChange(_ notification: Notification) {
            synchronizeTableWidth()
            scheduleUnderfilledHistoryEvaluation()
        }

        @objc private func capturePositionForTermination(_ notification: Notification) {
            publishPositionImmediately()
        }

        @objc private func windowDidEndLiveResize(_ notification: Notification) {
            guard let window = notification.object as? NSWindow,
                  window === scrollView?.window,
                  needsExactWidthReflow else { return }
            performExactWidthReflow()
        }

        private func synchronizeTableWidth() {
            guard let tableView, let scrollView, let column = tableView.tableColumns.first else { return }
            let width = max(120, scrollView.bounds.width - Self.verticalScrollerGutter)
            guard abs(column.width - width) >= 0.5 else { return }
            let anchor = visibleAnchor(in: tableView)
            column.width = width
            // This path now runs only for an actual container resize. Scroller
            // visibility no longer changes the layout width.
            lastMeasuredWidth = width
            if !rows.isEmpty {
                let visible = tableView.rows(in: tableView.visibleRect)
                let isLiveResize = scrollView.window?.inLiveResize == true
                let measurementWidth = LiveResizeWidthPolicy.measurementWidth(
                    width,
                    isLiveResize: isLiveResize
                )
                let requiresReflow = LiveResizeWidthPolicy.requiresReflow(
                    previous: lastReflowMeasurementWidth,
                    next: measurementWidth
                )
                let rowsToReflow = LiveResizeRowReflowPolicy.indexes(
                    rowCount: rows.count,
                    visibleRows: visible,
                    isLiveResize: isLiveResize
                )
                if requiresReflow, visible.location != NSNotFound {
                    let upperBound = min(rows.count, visible.location + visible.length)
                    for row in visible.location..<upperBound {
                        if let nativeCell = tableView.view(
                            atColumn: 0,
                            row: row,
                            makeIfNecessary: false
                        ) as? AppKitChatNativeTextCell {
                            if !nativeCell.updateLayoutIfContentUnchanged(
                                rows[row],
                                availableWidth: measurementWidth
                            ) {
                                nativeCell.setContent(
                                    rows[row],
                                    availableWidth: measurementWidth,
                                    onToggleExpansion: onToggleExpansion,
                                    onAction: onAction
                                )
                            }
                        }
                    }
                }
                if isLiveResize {
                    // Keep the native viewport and visible text exact enough to
                    // interact with, but do not synchronously ask NSTableView
                    // to remeasure every offscreen message for every drag tick.
                    needsExactWidthReflow = true
                    if requiresReflow, !rowsToReflow.isEmpty {
                        tableView.noteHeightOfRows(withIndexesChanged: rowsToReflow)
                    }
                } else if requiresReflow {
                    tableView.noteHeightOfRows(withIndexesChanged: rowsToReflow)
                    synchronizeDocumentHeight(in: tableView)
                }
                if requiresReflow {
                    lastReflowMeasurementWidth = measurementWidth
                    if let anchor { _ = restore(anchor: anchor, in: tableView) }
                }
            }
        }

        private func performExactWidthReflow() {
            guard let tableView else { return }
            needsExactWidthReflow = false
            heightCache = heightCache.filter { !$0.key.isLiveResizeApproximation }
            guard !rows.isEmpty else { return }
            let anchor = visibleAnchor(in: tableView)
            let exactWidth = tableView.tableColumns.first?.width ?? tableView.bounds.width
            let visible = tableView.rows(in: tableView.visibleRect)
            if visible.location != NSNotFound {
                let upperBound = min(rows.count, visible.location + visible.length)
                for row in visible.location..<upperBound {
                    if let nativeCell = tableView.view(
                        atColumn: 0,
                        row: row,
                        makeIfNecessary: false
                    ) as? AppKitChatNativeTextCell {
                        if !nativeCell.updateLayoutIfContentUnchanged(
                            rows[row],
                            availableWidth: exactWidth
                        ) {
                            nativeCell.setContent(
                                rows[row],
                                availableWidth: exactWidth,
                                onToggleExpansion: onToggleExpansion,
                                onAction: onAction
                            )
                        }
                    }
                }
            }
            lastReflowMeasurementWidth = exactWidth
            tableView.noteHeightOfRows(
                withIndexesChanged: IndexSet(integersIn: 0..<rows.count)
            )
            synchronizeDocumentHeight(in: tableView)
            if let anchor { _ = restore(anchor: anchor, in: tableView) }
        }

        private func visibleAnchor(in tableView: NSTableView) -> (id: String, offset: CGFloat)? {
            let visibleRows = tableView.rows(in: tableView.visibleRect)
            guard visibleRows.location != NSNotFound,
                  rows.indices.contains(visibleRows.location) else { return nil }
            let row = visibleRows.location
            let offset = tableView.visibleRect.minY - tableView.rect(ofRow: row).minY
            return (rows[row].id, offset)
        }

        @discardableResult
        private func restore(anchor: (id: String, offset: CGFloat), in tableView: NSTableView) -> Bool {
            guard !isProcessingUserScrollEvent,
                  let row = rows.firstIndex(where: { $0.id == anchor.id }),
                  let clipView = scrollView?.contentView else { return false }
            suppressNearTopDuringLayout()
            scrollCommandGeneration &+= 1
            let generation = scrollCommandGeneration
            DispatchQueue.main.async { [weak self, weak tableView, weak clipView] in
                guard let self,
                      self.scrollCommandGeneration == generation,
                      let tableView,
                      let clipView else { return }
                let y = max(0, tableView.rect(ofRow: row).minY + anchor.offset)
                clipView.scroll(to: NSPoint(x: 0, y: y))
                self.scrollView?.reflectScrolledClipView(clipView)
            }
            return true
        }

        func restore(position: AppKitChatTimelinePosition) {
            guard !isProcessingUserScrollEvent else { return }
            prepareInitialPosition(position)
            schedulePendingInitialViewportRestoreIfNeeded()
        }

        func scrollToTurn(_ turnID: String) {
            guard !isProcessingUserScrollEvent,
                  let tableView,
                  let clipView = scrollView?.contentView,
                  let row = AppKitChatTimelineView.rowIndex(forTurnID: turnID, in: rows) else { return }
            scrollCommandGeneration &+= 1
            pendingRestorePosition = nil
            pendingInitialScrollToBottom = false
            suppressNearTopDuringLayout()
            followsLatest = false
            if followsLatestBinding.wrappedValue { followsLatestBinding.wrappedValue = false }
            tableView.layoutSubtreeIfNeeded()
            synchronizeDocumentHeight(in: tableView)
            clipView.scroll(to: NSPoint(x: 0, y: max(0, tableView.rect(ofRow: row).minY - 10)))
            scrollView?.reflectScrolledClipView(clipView)
            schedulePositionPublish()
        }

        @discardableResult
        private func restoreClosestAvailableAnchor(
            _ anchor: (id: String, offset: CGFloat),
            previousIDs: [String],
            in tableView: NSTableView
        ) -> Bool {
            if restore(anchor: anchor, in: tableView) { return true }
            guard let removedIndex = previousIDs.firstIndex(of: anchor.id) else { return false }
            let successor = previousIDs.dropFirst(removedIndex + 1).first(where: { candidate in
                rows.contains(where: { $0.id == candidate })
            })
            if let successor {
                return restore(anchor: (successor, anchor.offset), in: tableView)
            }
            let predecessor = previousIDs[..<removedIndex].reversed().first(where: { candidate in
                rows.contains(where: { $0.id == candidate })
            })
            guard let predecessor else { return false }
            return restore(anchor: (predecessor, anchor.offset), in: tableView)
        }

        func prepareInitialPosition(_ position: AppKitChatTimelinePosition) {
            lastRequestedRestorePosition = position
            pendingRestorePosition = position
            pendingInitialScrollToBottom = false
            followsLatest = position.followsLatest
            if followsLatestBinding.wrappedValue != position.followsLatest {
                followsLatestBinding.wrappedValue = position.followsLatest
            }
        }

        func prepareInitialScrollToBottom() {
            lastRequestedRestorePosition = nil
            pendingRestorePosition = nil
            pendingInitialScrollToBottom = true
            followsLatest = true
            if !followsLatestBinding.wrappedValue {
                followsLatestBinding.wrappedValue = true
            }
        }

        private func schedulePendingInitialViewportRestoreIfNeeded() {
            guard !isProcessingUserScrollEvent,
                  pendingRestorePosition != nil || pendingInitialScrollToBottom else { return }
            scrollCommandGeneration &+= 1
            let generation = scrollCommandGeneration
            DispatchQueue.main.async { [weak self] in
                guard let self,
                      self.scrollCommandGeneration == generation else { return }
                self.restoreInitialViewportSynchronouslyIfNeeded()
            }
        }

        private func restoreInitialViewportSynchronouslyIfNeeded() {
            guard !isRestoringInitialViewport,
                  pendingRestorePosition != nil || pendingInitialScrollToBottom,
                  let tableView,
                  let clipView = scrollView?.contentView,
                  clipView.bounds.width > 0,
                  clipView.bounds.height > 0,
                  !rows.isEmpty else { return }
            isRestoringInitialViewport = true
            defer { isRestoringInitialViewport = false }
            suppressNearTopDuringLayout()
            tableView.layoutSubtreeIfNeeded()
            synchronizeDocumentHeight(in: tableView)
            let maximumY = max(0, tableView.frame.height - clipView.bounds.height)
            if let position = pendingRestorePosition {
                if let row = rows.firstIndex(where: { $0.id == position.rowID }) {
                    let anchorY = tableView.rect(ofRow: row).minY + CGFloat(position.offset)
                    clipView.scroll(to: NSPoint(x: 0, y: min(max(0, anchorY), maximumY)))
                } else {
                    // Absolute Y belongs to a different row/height window and
                    // is never a valid cross-revision fallback. A deleted or
                    // missing semantic anchor degrades once to latest.
                    clipView.scroll(to: NSPoint(x: 0, y: maximumY))
                    followsLatest = true
                    if !followsLatestBinding.wrappedValue {
                        followsLatestBinding.wrappedValue = true
                    }
                }
            } else if pendingInitialScrollToBottom {
                clipView.scroll(to: NSPoint(x: 0, y: maximumY))
            }
            scrollView?.reflectScrolledClipView(clipView)
            pendingRestorePosition = nil
            pendingInitialScrollToBottom = false
        }

        private func schedulePositionPublish() {
            positionPublishCorptieTask?.cancel()
            let task = DispatchWorkItem { [weak self] in
                guard let self, let tableView = self.tableView,
                      let anchor = self.visibleAnchor(in: tableView) else { return }
                let position = AppKitChatTimelinePosition(
                    rowID: anchor.id,
                    offset: Double(anchor.offset),
                    absoluteScrollY: Double(self.scrollView?.contentView.bounds.minY ?? 0),
                    followsLatest: self.followsLatest
                )
                guard position != self.lastPublishedPosition else { return }
                self.lastPublishedPosition = position
                self.onPositionChange(position)
            }
            positionPublishCorptieTask = task
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: task)
        }

        func publishPositionImmediately() {
            positionPublishCorptieTask?.cancel()
            positionPublishCorptieTask = nil
            guard let tableView, let anchor = visibleAnchor(in: tableView) else { return }
            let position = AppKitChatTimelinePosition(
                rowID: anchor.id,
                offset: Double(anchor.offset),
                absoluteScrollY: Double(scrollView?.contentView.bounds.minY ?? 0),
                followsLatest: followsLatest
            )
            guard position != lastPublishedPosition else { return }
            lastPublishedPosition = position
            onPositionChange(position)
        }

        private func suppressNearTopDuringLayout() {
            nearTopSuppressionGeneration &+= 1
            let generation = nearTopSuppressionGeneration
            suppressesNearTopTrigger = true
            suppressesLayoutDrivenFollowReconciliation = true
            DispatchQueue.main.async { [weak self] in
                guard let self, self.nearTopSuppressionGeneration == generation else { return }
                self.suppressesNearTopTrigger = false
                self.suppressesLayoutDrivenFollowReconciliation = false
            }
        }

        static func uniquedRows(_ rows: [AppKitChatTimelineRow]) -> [AppKitChatTimelineRow] {
            var indexesByID: [String: Int] = [:]
            indexesByID.reserveCapacity(rows.count)
            var result: [AppKitChatTimelineRow] = []
            result.reserveCapacity(rows.count)
            for row in rows {
                if let index = indexesByID[row.id] {
                    result[index] = row
                } else {
                    indexesByID[row.id] = result.count
                    result.append(row)
                }
            }
            return result
        }
    }
}

@MainActor
final class NativeTimelineTextView: NSTextView, NSTextViewDelegate {
    var linkBaseDirectory: String?
    var linkHandler: @MainActor (URL, String?) -> Bool = { url, baseDirectory in
        MessageLinkOpener.handle(url, baseDirectory: baseDirectory)
    }

    init() {
        let textStorage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        let textContainer = NSTextContainer(containerSize: NSSize(
            width: 0,
            height: CGFloat.greatestFiniteMagnitude
        ))
        textContainer.lineFragmentPadding = 0
        textContainer.lineBreakMode = .byCharWrapping
        textContainer.widthTracksTextView = true
        textContainer.heightTracksTextView = false
        layoutManager.addTextContainer(textContainer)
        textStorage.addLayoutManager(layoutManager)
        super.init(frame: .zero, textContainer: textContainer)
        drawsBackground = false
        isEditable = false
        isSelectable = true
        isRichText = true
        delegate = self
        importsGraphics = false
        textContainerInset = .zero
        isHorizontallyResizable = false
        isVerticallyResizable = false
        maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        identifier = NSUserInterfaceItemIdentifier("chat.timeline.body")
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        let url: URL?
        if let value = link as? URL {
            url = value
        } else if let value = link as? String {
            url = URL(string: value)
        } else {
            url = nil
        }
        guard let url else { return false }
        return linkHandler(url, linkBaseDirectory)
    }

    override func layout() {
        super.layout()
        guard let textContainer else { return }
        let expectedSize = NSSize(
            width: max(1, bounds.width),
            height: CGFloat.greatestFiniteMagnitude
        )
        if abs(textContainer.containerSize.width - expectedSize.width) >= 0.5
            || textContainer.containerSize.height != expectedSize.height {
            textContainer.containerSize = expectedSize
            layoutManager?.ensureLayout(for: textContainer)
        }
    }

    var laidOutCharacterRange: NSRange {
        guard let layoutManager, let textContainer else { return NSRange(location: 0, length: 0) }
        layoutManager.ensureLayout(for: textContainer)
        let glyphRange = layoutManager.glyphRange(for: textContainer)
        return layoutManager.characterRange(forGlyphRange: glyphRange, actualGlyphRange: nil)
    }
}

@MainActor
final class NativeCollaborationRouteSummaryView: NSView {
    static let height: CGFloat = 92
    private var presentation: NativeCollaborationRoutePresentation?

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    func configure(_ presentation: NativeCollaborationRoutePresentation) {
        guard self.presentation != presentation else { return }
        self.presentation = presentation
        setAccessibilityElement(true)
        setAccessibilityLabel(
            "\(presentation.routeLabel)。\(presentation.sourceLabel)：\(presentation.sourceSession)，\(presentation.sourceWork)。\(presentation.targetLabel)：\(presentation.targetName)，\(presentation.targetWork)"
        )
        needsDisplay = true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let presentation, bounds.width > 80 else { return }

        let accent: NSColor = presentation.destinationKind == .existingSession
            ? .systemBlue
            : .systemOrange
        let badgeFont = NSFont.systemFont(ofSize: 9, weight: .bold)
        let badgeText = presentation.routeLabel as NSString
        let badgeWidth = min(bounds.width, ceil(badgeText.size(withAttributes: [.font: badgeFont]).width) + 22)
        let badgeRect = NSRect(x: 0, y: 0, width: badgeWidth, height: 20)
        accent.withAlphaComponent(0.12).setFill()
        NSBezierPath(roundedRect: badgeRect, xRadius: 10, yRadius: 10).fill()
        badgeText.draw(
            in: badgeRect.insetBy(dx: 11, dy: 4),
            withAttributes: [.font: badgeFont, .foregroundColor: accent]
        )

        let panelY: CGFloat = 28
        let panelHeight: CGFloat = 64
        let arrowLane: CGFloat = 30
        let panelWidth = max(20, (bounds.width - arrowLane) / 2)
        let sourceRect = NSRect(x: 0, y: panelY, width: panelWidth, height: panelHeight)
        let targetRect = NSRect(x: panelWidth + arrowLane, y: panelY, width: panelWidth, height: panelHeight)
        drawPanel(
            sourceRect,
            caption: presentation.sourceLabel,
            primary: presentation.sourceSession,
            secondary: presentation.sourceWork,
            accent: .systemBlue
        )
        drawPanel(
            targetRect,
            caption: presentation.targetLabel,
            primary: presentation.targetName,
            secondary: presentation.targetWork,
            accent: accent
        )

        if let arrow = NSImage(systemSymbolName: "arrow.right", accessibilityDescription: nil) {
            let arrowRect = NSRect(
                x: panelWidth + 7,
                y: panelY + (panelHeight - 16) / 2,
                width: 16,
                height: 16
            )
            arrow.draw(in: arrowRect)
        }
    }

    private func drawPanel(
        _ rect: NSRect,
        caption: String,
        primary: String,
        secondary: String,
        accent: NSColor
    ) {
        NSColor.labelColor.withAlphaComponent(0.045).setFill()
        NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9).fill()

        let content = rect.insetBy(dx: 9, dy: 7)
        drawTruncated(
            caption,
            in: NSRect(x: content.minX, y: content.minY, width: content.width, height: 12),
            font: .systemFont(ofSize: 8.5, weight: .bold),
            color: accent
        )
        drawTruncated(
            primary,
            in: NSRect(x: content.minX, y: content.minY + 17, width: content.width, height: 16),
            font: .systemFont(ofSize: 11, weight: .semibold),
            color: .labelColor
        )
        drawTruncated(
            secondary,
            in: NSRect(x: content.minX, y: content.minY + 36, width: content.width, height: 14),
            font: .systemFont(ofSize: 9.5, weight: .medium),
            color: .secondaryLabelColor
        )
    }

    private func drawTruncated(_ text: String, in rect: NSRect, font: NSFont, color: NSColor) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        (text as NSString).draw(
            in: rect,
            withAttributes: [
                .font: font,
                .foregroundColor: color,
                .paragraphStyle: paragraph
            ]
        )
    }
}

@MainActor
final class AppKitChatNativeTextCell: NSTableCellView {
    private let cardView = NSView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let metadataLabel = NSTextField(labelWithString: "")
    private let hoverTimestampLabel = NSTextField(labelWithString: "")
    private let label = NativeTimelineTextView()
    private let imageStack = NSStackView()
    private let rawStatusScrollView = NSScrollView()
    private let rawStatusTextView = NSTextView()
    private let disclosureButton = NSButton()
    private let copyButton = NSButton()
    private let messageActionBar = NSStackView()
    private let actionStack = NSStackView()
    private let processSeparator = NSView()
    private let processButton = NSButton()
    private var processSeparatorHeight: NSLayoutConstraint!
    private var processButtonHeight: NSLayoutConstraint!
    private var processButtonTopConstraint: NSLayoutConstraint!
    private var processButtonBottomConstraint: NSLayoutConstraint!
    private var actionStackHeight: NSLayoutConstraint!
    private var cardWidthConstraint: NSLayoutConstraint!
    private var cardLeadingConstraint: NSLayoutConstraint!
    private var cardTrailingConstraint: NSLayoutConstraint!
    private var cardBottomStandardConstraint: NSLayoutConstraint!
    private var cardBottomWithMessageActionsConstraint: NSLayoutConstraint!
    private var messageActionBarLeadingConstraint: NSLayoutConstraint!
    private var messageActionBarTrailingConstraint: NSLayoutConstraint!
    private var labelTopToTitleConstraint: NSLayoutConstraint!
    private var labelTopToCardConstraint: NSLayoutConstraint!
    private var imageTopToTitleConstraint: NSLayoutConstraint!
    private var imageTopToCardConstraint: NSLayoutConstraint!
    private var labelTopToImagesConstraint: NSLayoutConstraint!
    private var imageStackHeightConstraint: NSLayoutConstraint!
    private var labelBottomToProcessConstraint: NSLayoutConstraint!
    private var labelBottomToActionsConstraint: NSLayoutConstraint!
    private var labelTopToProcessButtonConstraint: NSLayoutConstraint!
    private var labelBottomToCardConstraint: NSLayoutConstraint!
    private var labelHeightConstraint: NSLayoutConstraint!
    private var rawStatusTopConstraint: NSLayoutConstraint!
    private var rawStatusBottomConstraint: NSLayoutConstraint!
    private var rawStatusHeightConstraint: NSLayoutConstraint!
    private var collaborationSummaryView: NativeCollaborationRouteSummaryView?
    private var collaborationSummaryTopToTitleConstraint: NSLayoutConstraint?
    private var collaborationSummaryTopToCardConstraint: NSLayoutConstraint?
    private var labelTopToCollaborationSummaryConstraint: NSLayoutConstraint?
    private var expandableTurnId: String?
    private var onToggleExpansion: ((String) -> Void)?
    private var timelineActions: [AppKitChatTimelineRow.Action] = []
    private var onAction: ((AppKitChatTimelineRow.Action) -> Void)?
    private var copiedText = ""
    private var representedRowID: String?
    private var representedContentRevision: Int?
    private var representedImages: [ChatTimelineImage] = []
    private(set) var contentConfigurationCount = 0
    private(set) var widthLayoutUpdateCount = 0

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        cardView.translatesAutoresizingMaskIntoConstraints = false
        cardView.wantsLayer = true
        cardView.layer?.cornerCurve = .continuous
        cardView.layer?.cornerRadius = 14
        cardView.layer?.borderWidth = 1
        cardView.layer?.masksToBounds = false
        cardView.layer?.shadowColor = NSColor.black.cgColor
        cardView.layer?.shadowOpacity = 0.04
        cardView.layer?.shadowRadius = 8
        cardView.layer?.shadowOffset = CGSize(width: 0, height: -3)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        metadataLabel.translatesAutoresizingMaskIntoConstraints = false
        hoverTimestampLabel.translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false
        imageStack.translatesAutoresizingMaskIntoConstraints = false
        imageStack.orientation = .horizontal
        imageStack.alignment = .centerY
        imageStack.spacing = 7
        rawStatusScrollView.translatesAutoresizingMaskIntoConstraints = false
        disclosureButton.translatesAutoresizingMaskIntoConstraints = false
        copyButton.translatesAutoresizingMaskIntoConstraints = false
        messageActionBar.translatesAutoresizingMaskIntoConstraints = false
        messageActionBar.orientation = .horizontal
        messageActionBar.alignment = .centerY
        messageActionBar.spacing = 6
        actionStack.translatesAutoresizingMaskIntoConstraints = false
        actionStack.orientation = .horizontal
        actionStack.alignment = .centerY
        actionStack.spacing = 8
        processSeparator.translatesAutoresizingMaskIntoConstraints = false
        processSeparator.wantsLayer = true
        processButton.translatesAutoresizingMaskIntoConstraints = false
        label.isSelectable = true
        rawStatusScrollView.identifier = NSUserInterfaceItemIdentifier("chat.timeline.raw-status")
        rawStatusScrollView.drawsBackground = true
        rawStatusScrollView.backgroundColor = NSColor.black.withAlphaComponent(0.035)
        rawStatusScrollView.borderType = .noBorder
        rawStatusScrollView.hasVerticalScroller = true
        rawStatusScrollView.autohidesScrollers = true
        rawStatusScrollView.scrollerStyle = .overlay
        rawStatusScrollView.wantsLayer = true
        rawStatusScrollView.layer?.cornerRadius = 6
        rawStatusTextView.isEditable = false
        rawStatusTextView.isSelectable = true
        rawStatusTextView.isRichText = false
        rawStatusTextView.drawsBackground = false
        rawStatusTextView.font = .monospacedSystemFont(ofSize: 9.5, weight: .regular)
        rawStatusTextView.textColor = NativeTimelineCardPalette.mutedText
        rawStatusTextView.textContainerInset = NSSize(width: 4, height: 4)
        rawStatusTextView.isHorizontallyResizable = false
        rawStatusTextView.isVerticallyResizable = true
        rawStatusTextView.autoresizingMask = [.width]
        rawStatusTextView.textContainer?.widthTracksTextView = true
        rawStatusTextView.textContainer?.containerSize = NSSize(
            width: 0,
            height: CGFloat.greatestFiniteMagnitude
        )
        rawStatusScrollView.documentView = rawStatusTextView
        disclosureButton.isBordered = false
        disclosureButton.identifier = NSUserInterfaceItemIdentifier("chat.timeline.disclosure")
        disclosureButton.imagePosition = .imageOnly
        disclosureButton.target = self
        disclosureButton.action = #selector(toggleDisclosure)
        disclosureButton.isHidden = true
        copyButton.isBordered = false
        copyButton.identifier = NSUserInterfaceItemIdentifier("chat.timeline.copy")
        copyButton.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: "复制消息")
        copyButton.imagePosition = .imageOnly
        copyButton.target = self
        copyButton.action = #selector(copyText)
        copyButton.toolTip = "复制消息"
        copyButton.setAccessibilityLabel("复制消息")
        messageActionBar.identifier = NSUserInterfaceItemIdentifier("chat.timeline.message-actions")
        messageActionBar.alphaValue = 0
        messageActionBar.addArrangedSubview(hoverTimestampLabel)
        messageActionBar.addArrangedSubview(copyButton)
        processButton.isBordered = false
        processButton.alignment = .left
        processButton.imagePosition = .imageLeading
        processButton.imageHugsTitle = true
        processButton.target = self
        processButton.action = #selector(toggleDisclosure)
        processButton.identifier = NSUserInterfaceItemIdentifier("chat.timeline.process")
        titleLabel.identifier = NSUserInterfaceItemIdentifier("chat.timeline.title")
        metadataLabel.identifier = NSUserInterfaceItemIdentifier("chat.timeline.metadata")
        hoverTimestampLabel.identifier = NSUserInterfaceItemIdentifier("chat.timeline.hover-timestamp")
        hoverTimestampLabel.font = .systemFont(ofSize: 9, weight: .medium)
        hoverTimestampLabel.textColor = NativeTimelineCardPalette.mutedText
        hoverTimestampLabel.maximumNumberOfLines = 1
        hoverTimestampLabel.alphaValue = 1
        addSubview(cardView)
        addSubview(messageActionBar)
        [
            titleLabel,
            metadataLabel,
            imageStack,
            label,
            rawStatusScrollView,
            disclosureButton,
            actionStack,
            processSeparator,
            processButton
        ].forEach(cardView.addSubview)
        processSeparatorHeight = processSeparator.heightAnchor.constraint(equalToConstant: 0)
        processButtonHeight = processButton.heightAnchor.constraint(equalToConstant: 0)
        processButtonTopConstraint = processButton.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 3)
        processButtonBottomConstraint = processButton.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -3)
        actionStackHeight = actionStack.heightAnchor.constraint(equalToConstant: 0)
        cardWidthConstraint = cardView.widthAnchor.constraint(equalToConstant: ChatBubbleWidthPolicy.maximumWidth)
        cardLeadingConstraint = cardView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2)
        cardTrailingConstraint = cardView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2)
        cardBottomStandardConstraint = cardView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -1)
        cardBottomWithMessageActionsConstraint = cardView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -27)
        messageActionBarLeadingConstraint = messageActionBar.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 2)
        messageActionBarTrailingConstraint = messageActionBar.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -2)
        labelTopToTitleConstraint = label.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 6)
        labelTopToCardConstraint = label.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 10)
        imageTopToTitleConstraint = imageStack.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 7)
        imageTopToCardConstraint = imageStack.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 10)
        labelTopToImagesConstraint = label.topAnchor.constraint(equalTo: imageStack.bottomAnchor, constant: 7)
        imageStackHeightConstraint = imageStack.heightAnchor.constraint(equalToConstant: 0)
        labelBottomToProcessConstraint = label.bottomAnchor.constraint(lessThanOrEqualTo: processSeparator.topAnchor, constant: -5)
        labelBottomToActionsConstraint = label.bottomAnchor.constraint(lessThanOrEqualTo: actionStack.topAnchor, constant: -4)
        labelTopToProcessButtonConstraint = label.topAnchor.constraint(equalTo: processButton.bottomAnchor, constant: 8)
        labelBottomToCardConstraint = label.bottomAnchor.constraint(lessThanOrEqualTo: cardView.bottomAnchor, constant: -10)
        labelHeightConstraint = label.heightAnchor.constraint(equalToConstant: 0)
        rawStatusTopConstraint = rawStatusScrollView.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 8)
        rawStatusBottomConstraint = rawStatusScrollView.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -10)
        rawStatusHeightConstraint = rawStatusScrollView.heightAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            cardWidthConstraint,
            cardLeadingConstraint,
            cardView.topAnchor.constraint(equalTo: topAnchor, constant: 1),
            cardBottomStandardConstraint,
            disclosureButton.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            disclosureButton.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 8),
            disclosureButton.widthAnchor.constraint(equalToConstant: 16),
            disclosureButton.heightAnchor.constraint(equalToConstant: 16),
            titleLabel.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            titleLabel.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 9),
            metadataLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            metadataLabel.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
            copyButton.widthAnchor.constraint(equalToConstant: 22),
            copyButton.heightAnchor.constraint(equalToConstant: 22),
            messageActionBar.topAnchor.constraint(equalTo: cardView.bottomAnchor, constant: 2),
            messageActionBar.heightAnchor.constraint(equalToConstant: 22),
            label.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            imageStack.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            imageStack.trailingAnchor.constraint(lessThanOrEqualTo: cardView.trailingAnchor, constant: -10),
            imageStackHeightConstraint,
            labelHeightConstraint,
            rawStatusScrollView.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            rawStatusScrollView.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            rawStatusHeightConstraint,
            labelTopToTitleConstraint,
            labelBottomToProcessConstraint,
            actionStack.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            actionStack.trailingAnchor.constraint(lessThanOrEqualTo: cardView.trailingAnchor, constant: -10),
            actionStack.bottomAnchor.constraint(equalTo: processSeparator.topAnchor, constant: -4),
            actionStackHeight,
            processSeparator.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            processSeparator.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            processSeparator.bottomAnchor.constraint(equalTo: processButton.topAnchor),
            processSeparatorHeight,
            processButton.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            processButton.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            processButtonBottomConstraint,
            processButtonHeight
        ])
        updateTrackingAreas()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func updateCallbacks(
        onToggleExpansion: @escaping (String) -> Void,
        onAction: @escaping (AppKitChatTimelineRow.Action) -> Void
    ) {
        self.onToggleExpansion = onToggleExpansion
        self.onAction = onAction
    }

    func setContent(
        _ row: AppKitChatTimelineRow,
        availableWidth: CGFloat,
        baseDirectory: String? = nil,
        onToggleExpansion: @escaping (String) -> Void,
        onAction: @escaping (AppKitChatTimelineRow.Action) -> Void = { _ in }
    ) {
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth)
        representedRowID = row.id
        representedContentRevision = row.contentRevision
        contentConfigurationCount += 1
        updateLinkContext(baseDirectory: baseDirectory)
        label.textStorage?.setAttributedString(layout.attributedText)
        rawStatusTextView.string = row.rawStatusText
        apply(layout: layout)
        titleLabel.stringValue = row.title
        titleLabel.font = .systemFont(ofSize: 11, weight: .bold)
        metadataLabel.stringValue = row.metadata
        metadataLabel.font = .systemFont(ofSize: 10, weight: .semibold)
        metadataLabel.textColor = NativeTimelineCardPalette.mutedText
        titleLabel.textColor = row.isCollaboration
            ? NativeTimelineCardPalette.collaborationText
            : (row.nativeStyle == .user
                ? NativeTimelineCardPalette.userText
                : NativeTimelineCardPalette.agentText)
        disclosureButton.isHidden = true
        disclosureButton.image = NSImage(
            systemSymbolName: row.isExpanded ? "chevron.down" : "chevron.right",
            accessibilityDescription: row.isExpanded ? "Collapse process" : "Expand process"
        )
        expandableTurnId = row.expandableTurnId
        self.onToggleExpansion = onToggleExpansion
        self.onAction = onAction
        configureActions(row.actions)
        configureImages(row.images, rowID: row.id)
        copiedText = row.copyText
        let showsMessageActions = row.showsMessageActionBar
        NSLayoutConstraint.deactivate([
            cardBottomStandardConstraint,
            cardBottomWithMessageActionsConstraint,
            messageActionBarLeadingConstraint,
            messageActionBarTrailingConstraint
        ])
        if showsMessageActions {
            cardBottomWithMessageActionsConstraint.isActive = true
            if row.nativeStyle == .user {
                messageActionBarTrailingConstraint.isActive = true
            } else {
                messageActionBarLeadingConstraint.isActive = true
            }
        } else {
            cardBottomStandardConstraint.isActive = true
        }
        messageActionBar.isHidden = !showsMessageActions
        messageActionBar.alphaValue = 0
        cardLeadingConstraint.isActive = row.nativeStyle != .user
        cardTrailingConstraint.isActive = row.nativeStyle == .user
        let hasProcess = row.processCount != nil
        let isStandaloneProcess = row.nativeStyle == .process
        let showsHeader = row.showsHeader && !isStandaloneProcess
        titleLabel.isHidden = !showsHeader
        metadataLabel.isHidden = !showsHeader
        NSLayoutConstraint.deactivate([
            labelTopToTitleConstraint,
            labelTopToCardConstraint,
            imageTopToTitleConstraint,
            imageTopToCardConstraint,
            labelTopToImagesConstraint,
            labelTopToProcessButtonConstraint,
            labelBottomToCardConstraint,
            rawStatusTopConstraint,
            rawStatusBottomConstraint,
            processButtonTopConstraint,
            processButtonBottomConstraint
        ])
        collaborationSummaryTopToTitleConstraint?.isActive = false
        collaborationSummaryTopToCardConstraint?.isActive = false
        labelTopToCollaborationSummaryConstraint?.isActive = false
        if let route = row.collaborationRoute {
            let summary = ensureCollaborationSummaryView()
            summary.configure(route)
            summary.isHidden = false
            if showsHeader {
                collaborationSummaryTopToTitleConstraint?.isActive = true
            } else {
                collaborationSummaryTopToCardConstraint?.isActive = true
            }
            labelTopToCollaborationSummaryConstraint?.isActive = true
        } else {
            collaborationSummaryView?.isHidden = true
        }
        if isStandaloneProcess {
            NSLayoutConstraint.deactivate([labelBottomToProcessConstraint, labelBottomToActionsConstraint])
            processButtonTopConstraint.isActive = true
            if row.isExpanded {
                labelTopToProcessButtonConstraint.isActive = true
                if layout.rawStatusHeight > 0 {
                    rawStatusTopConstraint.isActive = true
                    rawStatusBottomConstraint.isActive = true
                } else {
                    labelBottomToCardConstraint.isActive = true
                }
            }
        } else {
            if row.collaborationRoute == nil {
                if row.images.isEmpty {
                    (showsHeader ? labelTopToTitleConstraint : labelTopToCardConstraint).isActive = true
                } else {
                    (showsHeader ? imageTopToTitleConstraint : imageTopToCardConstraint).isActive = true
                    labelTopToImagesConstraint.isActive = true
                }
            }
            processButtonBottomConstraint.isActive = true
        }
        hoverTimestampLabel.stringValue = row.hoverTimestamp
        hoverTimestampLabel.isHidden = row.hoverTimestamp.isEmpty || isStandaloneProcess
        hoverTimestampLabel.alphaValue = 1
        label.isHidden = isStandaloneProcess && !row.isExpanded
        processSeparator.isHidden = !hasProcess || isStandaloneProcess
        processButton.isHidden = !hasProcess
        processSeparatorHeight.constant = hasProcess && !isStandaloneProcess ? 1 : 0
        processButtonHeight.constant = hasProcess ? 22 : 0
        if row.processCount != nil {
            let chevron = row.isExpanded ? "⌄" : "›"
            processButton.image = NSImage(
                systemSymbolName: row.processState.symbolName,
                accessibilityDescription: row.processSummary
            )
            processButton.contentTintColor = row.processState.color
            processButton.toolTip = row.isExpanded ? "Collapse execution details" : "Expand execution details"
            processButton.setAccessibilityLabel(row.processSummary)
            processButton.attributedTitle = NSAttributedString(
                string: "  \(row.processSummary)    \(chevron)",
                attributes: [
                    .font: NSFont.systemFont(ofSize: 10.5, weight: .medium),
                    .foregroundColor: NativeTimelineCardPalette.secondaryText
                ]
            )
        }
        if row.isCollaboration {
            cardView.layer?.backgroundColor = NSColor(
                calibratedRed: 0.945,
                green: 0.955,
                blue: 0.995,
                alpha: 1
            ).cgColor
            cardView.layer?.borderColor = NSColor(
                calibratedRed: 0.42,
                green: 0.47,
                blue: 0.78,
                alpha: 0.24
            ).cgColor
        } else {
            switch row.nativeStyle {
            case .user:
                cardView.layer?.backgroundColor = NativeTimelineCardPalette.userBackground.cgColor
                cardView.layer?.borderColor = NativeTimelineCardPalette.userBorder.cgColor
            case .agent:
                cardView.layer?.backgroundColor = NSColor.white.cgColor
                cardView.layer?.borderColor = NSColor.black.withAlphaComponent(0.08).cgColor
            case .process:
                let tint = row.processState.color
                cardView.layer?.backgroundColor = tint.withAlphaComponent(row.isExpanded ? 0.055 : 0.035).cgColor
                cardView.layer?.borderColor = tint.withAlphaComponent(0.16).cgColor
                cardView.layer?.cornerRadius = row.isExpanded ? 12 : 10
            }
        }
        if row.nativeStyle != .process { cardView.layer?.cornerRadius = 14 }
        processSeparator.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.045).cgColor
        needsLayout = true
    }

    func updateLinkContext(baseDirectory: String?) {
        label.linkBaseDirectory = baseDirectory
    }

    private func ensureCollaborationSummaryView() -> NativeCollaborationRouteSummaryView {
        if let collaborationSummaryView { return collaborationSummaryView }
        let summary = NativeCollaborationRouteSummaryView()
        summary.translatesAutoresizingMaskIntoConstraints = false
        summary.identifier = NSUserInterfaceItemIdentifier("chat.timeline.collaboration-route")
        cardView.addSubview(summary)
        collaborationSummaryTopToTitleConstraint = summary.topAnchor.constraint(
            equalTo: titleLabel.bottomAnchor,
            constant: 8
        )
        collaborationSummaryTopToCardConstraint = summary.topAnchor.constraint(
            equalTo: cardView.topAnchor,
            constant: 10
        )
        labelTopToCollaborationSummaryConstraint = label.topAnchor.constraint(
            equalTo: summary.bottomAnchor,
            constant: 10
        )
        NSLayoutConstraint.activate([
            summary.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            summary.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            summary.heightAnchor.constraint(equalToConstant: NativeCollaborationRouteSummaryView.height)
        ])
        collaborationSummaryView = summary
        return summary
    }

    /// Width-only resize updates keep the existing attributed content, action
    /// buttons, and constraint topology. TextKit still receives the quantized
    /// width-derived height, while expensive content configuration is reserved
    /// for an actual row/revision change.
    @discardableResult
    func updateLayoutIfContentUnchanged(
        _ row: AppKitChatTimelineRow,
        availableWidth: CGFloat
    ) -> Bool {
        guard representedRowID == row.id,
              representedContentRevision == row.contentRevision else { return false }
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth)
        apply(layout: layout)
        widthLayoutUpdateCount += 1
        ChatPerformanceRecorder.shared.increment(.appKitRowWidthUpdates)
        return true
    }

    private func apply(layout: NativeTimelineLayoutCache.Layout) {
        labelHeightConstraint.constant = layout.textHeight
        rawStatusHeightConstraint.constant = layout.rawStatusHeight
        rawStatusScrollView.isHidden = layout.rawStatusHeight == 0
        cardWidthConstraint.constant = layout.cardWidth
        needsLayout = true
    }

    private func configureActions(_ actions: [AppKitChatTimelineRow.Action]) {
        timelineActions = actions
        actionStack.arrangedSubviews.forEach {
            actionStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        NSLayoutConstraint.deactivate([labelBottomToProcessConstraint, labelBottomToActionsConstraint])
        if actions.isEmpty {
            actionStackHeight.constant = 0
            actionStack.isHidden = true
            labelBottomToProcessConstraint.isActive = true
            return
        }
        actionStack.isHidden = false
        actionStackHeight.constant = 28
        labelBottomToActionsConstraint.isActive = true
        for (index, action) in actions.enumerated() {
            let button = NSButton(title: action.label, target: self, action: #selector(performTimelineAction(_:)))
            button.tag = index
            button.identifier = NSUserInterfaceItemIdentifier("chat.timeline.action.\(action.id)")
            button.bezelStyle = .rounded
            button.controlSize = .small
            button.contentTintColor = action.isDestructive ? .systemRed : .controlAccentColor
            button.toolTip = action.label
            actionStack.addArrangedSubview(button)
        }
    }

    private func configureImages(_ images: [ChatTimelineImage], rowID: String) {
        representedImages = Array(images.prefix(4))
        imageStack.arrangedSubviews.forEach {
            imageStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        let visible = Array(images.prefix(4))
        imageStack.isHidden = visible.isEmpty
        imageStackHeightConstraint.constant = visible.isEmpty ? 0 : 88
        for (index, attachment) in visible.enumerated() {
            let button = NSButton()
            button.isBordered = false
            button.imagePosition = .imageOnly
            button.imageScaling = .scaleProportionallyUpOrDown
            button.wantsLayer = true
            button.layer?.cornerRadius = 9
            button.layer?.masksToBounds = true
            button.tag = index
            button.target = self
            button.action = #selector(openImage(_:))
            button.toolTip = attachment.originalPath == nil
                ? "Open image"
                : "Reveal original image in Finder"
            button.setAccessibilityLabel("Attached image \(index + 1)")
            button.image = NSImage(systemSymbolName: "photo", accessibilityDescription: nil)
            button.widthAnchor.constraint(equalToConstant: 88).isActive = true
            button.heightAnchor.constraint(equalToConstant: 88).isActive = true
            imageStack.addArrangedSubview(button)
            guard let url = attachment.displayURL else { continue }
            ChatTimelineImageLoader.shared.load(url) { [weak self, weak button] image in
                guard self?.representedRowID == rowID else { return }
                button?.image = image ?? NSImage(
                    systemSymbolName: "exclamationmark.triangle",
                    accessibilityDescription: "Image is missing"
                )
            }
        }
    }

    @objc private func openImage(_ sender: NSButton) {
        // The represented row is reconfigured atomically, so the visible button
        // index always maps to the current row's attachment.
        guard sender.tag < representedImages.count else { return }
        let image = representedImages[sender.tag]
        if let originalPath = image.originalPath,
           FileManager.default.fileExists(atPath: originalPath) {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: originalPath)])
        } else if image.originalPath != nil, let url = image.displayURL {
            let alert = NSAlert()
            alert.messageText = "Original image is missing"
            alert.informativeText = "Corptie kept a managed copy for this conversation."
            alert.addButton(withTitle: "View managed copy")
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(url)
            }
        } else if let url = image.displayURL {
            NSWorkspace.shared.open(url)
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
            owner: self
        ))
    }

    override func mouseEntered(with event: NSEvent) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            messageActionBar.animator().alphaValue = messageActionBar.isHidden ? 0 : 1
        }
    }

    override func mouseExited(with event: NSEvent) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            messageActionBar.animator().alphaValue = 0
        }
    }

    @objc private func toggleDisclosure() {
        guard let expandableTurnId else { return }
        onToggleExpansion?(expandableTurnId)
    }

    @objc private func copyText() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(copiedText, forType: .string)
    }

    @objc private func performTimelineAction(_ sender: NSButton) {
        guard timelineActions.indices.contains(sender.tag) else { return }
        onAction?(timelineActions[sender.tag])
    }
}

@MainActor
private final class ChatTimelineImageLoader {
    static let shared = ChatTimelineImageLoader()
    private let cache = NSCache<NSURL, NSImage>()

    private init() {
        cache.totalCostLimit = 64 * 1_024 * 1_024
        cache.countLimit = 160
    }

    func load(_ url: URL, completion: @escaping (NSImage?) -> Void) {
        if let image = cache.object(forKey: url as NSURL) {
            completion(image)
            return
        }
        if url.isFileURL {
            Task { [weak self] in
                let data = await Task.detached(priority: .userInitiated) {
                    try? Data(contentsOf: url, options: .mappedIfSafe)
                }.value
                let image = data.flatMap(NSImage.init(data:))
                self?.store(image, for: url)
                completion(image)
            }
            return
        }
        Task { [weak self] in
            let data = try? await URLSession.shared.data(from: url).0
            let image = data.flatMap(NSImage.init(data:))
            self?.store(image, for: url)
            completion(image)
        }
    }

    private func store(_ image: NSImage?, for url: URL) {
        guard let image else { return }
        let pixels = Int(image.size.width * image.size.height)
        cache.setObject(image, forKey: url as NSURL, cost: min(pixels * 4, 20 * 1_024 * 1_024))
    }
}

private enum NativeTimelineCardPalette {
    static let secondaryText = NSColor(calibratedRed: 0.24, green: 0.27, blue: 0.29, alpha: 1)
    static let mutedText = NSColor(calibratedRed: 0.38, green: 0.41, blue: 0.43, alpha: 1)
    static let userText = NSColor(calibratedRed: 0.22, green: 0.35, blue: 0.62, alpha: 1)
    static let agentText = NSColor(calibratedRed: 0.18, green: 0.48, blue: 0.27, alpha: 1)
    static let collaborationText = NSColor(calibratedRed: 0.30, green: 0.34, blue: 0.68, alpha: 1)
    static let userBackground = NSColor(calibratedRed: 0.945, green: 0.965, blue: 0.988, alpha: 1)
    static let userBorder = NSColor(calibratedRed: 0.45, green: 0.58, blue: 0.76, alpha: 0.22)
}

private final class FirstLayoutRestoringScrollView: NSScrollView {
    var onLayout: (() -> Void)?
    var onUserScrollWillBegin: (() -> Void)?
    var onUserScrollDidEnd: (() -> Void)?

    override func scrollWheel(with event: NSEvent) {
        onUserScrollWillBegin?()
        defer { onUserScrollDidEnd?() }
        super.scrollWheel(with: event)
    }

    override func layout() {
        super.layout()
        onLayout?()
    }
}

private final class IntrinsicHeightTableView: NSTableView {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        enclosingScrollView?.contentView.postsBoundsChangedNotifications = true
    }
}
