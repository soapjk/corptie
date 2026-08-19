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
    private var order: [Key] = []
    private let limit = 1_000
    private let byteLimit = 16 * 1_024 * 1_024
    private var estimatedBytes = 0

    func value(text: String, style: AppKitChatTimelineRow.NativeStyle) -> NSAttributedString {
        let key = Key(text: text, style: style)
        if let cached = values[key] { return cached }
        let attributed = NativeMarkdownAttributedText.make(text: text, style: style)
        values[key] = attributed
        order.append(key)
        estimatedBytes += estimatedByteCount(for: key, value: attributed)
        while order.count > limit || estimatedBytes > byteLimit, let oldest = order.first {
            if let removed = values.removeValue(forKey: oldest) {
                estimatedBytes = max(0, estimatedBytes - estimatedByteCount(for: oldest, value: removed))
            }
            order.removeFirst()
        }
        return attributed
    }

    private func estimatedByteCount(for key: Key, value: NSAttributedString) -> Int {
        // Include the retained key string and headroom for attributed runs/attributes.
        (key.text.utf16.count * 2) + (value.length * 6) + 128
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
        let rowHeight: CGFloat
    }

    private struct Key: Hashable {
        let text: String
        let style: AppKitChatTimelineRow.NativeStyle
        let title: String
        let metadata: String
        let processCount: Int?
        let processDuration: String?
        let processState: AppKitChatTimelineRow.ProcessState
        let isExpanded: Bool
        let showsHeader: Bool
        let hasHoverTimestamp: Bool
        let actionCount: Int
        let widthBucket: Int
    }

    static let shared = NativeTimelineLayoutCache()
    private var values: [Key: Layout] = [:]
    private var recency: [Key] = []
    private var estimatedBytes = 0
    private let byteLimit = 64 * 1_024 * 1_024

    func layout(for row: AppKitChatTimelineRow, columnWidth: CGFloat) -> Layout {
        let normalizedWidth = max(120, columnWidth)
        let key = Key(
            text: row.nativeText,
            style: row.nativeStyle,
            title: row.title,
            metadata: row.metadata,
            processCount: row.processCount,
            processDuration: row.processDuration,
            processState: row.processState,
            isExpanded: row.isExpanded,
            showsHeader: row.showsHeader,
            hasHoverTimestamp: !row.hoverTimestamp.isEmpty,
            actionCount: row.actions.count,
            widthBucket: Int((normalizedWidth * 2).rounded())
        )
        if let cached = values[key] {
            touch(key)
            return cached
        }

        let attributed = NativeMarkdownTextCache.shared.value(text: row.nativeText, style: row.nativeStyle)
        let cardWidth = ChatBubbleWidthPolicy.cardWidth(for: row, availableWidth: normalizedWidth)
        let rowHeight: CGFloat
        if row.nativeStyle == .process && !row.isExpanded {
            rowHeight = 32
        } else {
            // This exactly matches the native cell's 10pt leading/trailing
            // constraints. The previous 120pt floor could measure a different
            // line count than the width eventually assigned to NSTextField.
            let textWidth = max(20, cardWidth - ChatBubbleWidthPolicy.horizontalPadding)
            let bounds = attributed.boundingRect(
                with: NSSize(width: textWidth, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading]
            )
            if row.nativeStyle == .process {
                rowHeight = max(54, ceil(bounds.height) + 48)
            } else {
                let footerHeight: CGFloat = row.processCount == nil ? 0 : 24
                let actionHeight: CGFloat = row.actions.isEmpty ? 0 : 34
                let messageActionBarHeight: CGFloat = row.showsMessageActionBar ? 27 : 0
                let verticalChrome: CGFloat = row.showsHeader ? 39 : 20
                rowHeight = max(
                    row.showsHeader ? 54 : 30,
                    ceil(bounds.height) + verticalChrome + footerHeight + actionHeight + messageActionBarHeight
                )
            }
        }
        let layout = Layout(attributedText: attributed, cardWidth: cardWidth, rowHeight: rowHeight)
        values[key] = layout
        recency.append(key)
        estimatedBytes += (key.text.utf16.count * 8) + attributed.length * 8 + 192
        evictIfNeeded()
        return layout
    }

    private func touch(_ key: Key) {
        recency.removeAll { $0 == key }
        recency.append(key)
    }

    private func evictIfNeeded() {
        while estimatedBytes > byteLimit, let oldest = recency.first {
            recency.removeFirst()
            guard let removed = values.removeValue(forKey: oldest) else { continue }
            estimatedBytes = max(
                0,
                estimatedBytes - (oldest.text.utf16.count * 8) - removed.attributedText.length * 8 - 192
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
    let copyText: String
    let nativeStyle: NativeStyle
    let title: String
    let metadata: String
    let expandableTurnId: String?
    let isExpanded: Bool
    let processCount: Int?
    let processDuration: String?
    let processState: ProcessState
    let showsHeader: Bool
    let hoverTimestamp: String
    let actions: [Action]

    var showsMessageActionBar: Bool {
        !showsHeader
            && !copyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (nativeStyle == .user || nativeStyle == .agent)
    }

    init(
        id: String,
        contentRevision: Int,
        nativeText: String,
        copyText: String,
        nativeStyle: NativeStyle,
        title: String,
        metadata: String,
        expandableTurnId: String?,
        isExpanded: Bool,
        processCount: Int? = nil,
        processDuration: String? = nil,
        processState: ProcessState = .completed,
        showsHeader: Bool = true,
        hoverTimestamp: String = "",
        actions: [Action] = []
    ) {
        self.id = id
        self.contentRevision = contentRevision
        self.nativeText = nativeText
        self.copyText = copyText
        self.nativeStyle = nativeStyle
        self.title = title
        self.metadata = metadata
        self.expandableTurnId = expandableTurnId
        self.isExpanded = isExpanded
        self.processCount = processCount
        self.processDuration = processDuration
        self.processState = processState
        self.showsHeader = showsHeader
        self.hoverTimestamp = hoverTimestamp
        self.actions = actions
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
            return "Working… · \(steps)"
        case .completed:
            if let normalizedDuration, !normalizedDuration.isEmpty {
                return "Worked for \(normalizedDuration) · \(steps)"
            }
            return "Completed · \(steps)"
        case .failed:
            return "Execution failed · \(steps)"
        case .cancelled:
            return "Execution stopped · \(steps)"
        }
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
        // Native rows place the hover timestamp beside the card. Reserve that
        // exterior lane in narrow floating panels so the label is not clipped
        // by the table viewport when the message body reaches its max width.
        let exteriorTimestampReserve: CGFloat = row.hoverTimestamp.isEmpty ? 0 : 84
        let available = max(minimumWidth, fullAvailableWidth - exteriorTimestampReserve)
        return preferredWidth(
            text: row.nativeText,
            style: row.nativeStyle,
            title: row.showsHeader ? row.title : "",
            metadata: row.showsHeader ? row.metadata : "",
            processWidth: row.processCount == nil ? 0 : collapsedProcessWidth,
            availableWidth: available
        )
    }
}

struct AppKitChatTimelinePosition: Equatable, Sendable {
    let rowID: String
    let offset: Double
    let followsLatest: Bool
}

struct AppKitChatTimelineView: NSViewRepresentable {
    let rows: [AppKitChatTimelineRow]
    let scrollToBottomRevision: Int
    @Binding var followsLatest: Bool
    let onToggleExpansion: (String) -> Void
    var onAction: (AppKitChatTimelineRow.Action) -> Void = { _ in }
    var onNearTop: () -> Void = {}
    var initialPosition: AppKitChatTimelinePosition? = nil
    var onPositionChange: (AppKitChatTimelinePosition) -> Void = { _ in }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            followsLatest: $followsLatest,
            onToggleExpansion: onToggleExpansion,
            onAction: onAction,
            onNearTop: onNearTop,
            onPositionChange: onPositionChange
        )
    }

    func makeNSView(context: Context) -> NSScrollView {
        let tableView = Self.makeTableView()
        let scrollView = Self.makeScrollView(tableView: tableView)

        context.coordinator.attach(tableView: tableView, scrollView: scrollView)
        context.coordinator.apply(rows: rows, animated: false)
        context.coordinator.lastScrollToBottomRevision = scrollToBottomRevision
        if let initialPosition, !initialPosition.followsLatest {
            context.coordinator.restore(position: initialPosition)
        } else {
            context.coordinator.scrollToBottom()
        }
        return scrollView
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
        let scrollView = NSScrollView()
        scrollView.contentView = TimelineBoundedClipView()
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
        context.coordinator.followsLatest = followsLatest
        context.coordinator.onToggleExpansion = onToggleExpansion
        context.coordinator.onAction = onAction
        context.coordinator.onNearTop = onNearTop
        context.coordinator.onPositionChange = onPositionChange
        context.coordinator.apply(rows: rows, animated: context.transaction.animation != nil)
        if context.coordinator.lastScrollToBottomRevision != scrollToBottomRevision {
            context.coordinator.lastScrollToBottomRevision = scrollToBottomRevision
            context.coordinator.scrollToBottom()
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
        var onPositionChange: (AppKitChatTimelinePosition) -> Void
        private weak var tableView: NSTableView?
        private weak var scrollView: NSScrollView?
        private var rows: [AppKitChatTimelineRow] = []
        private var revisionsByID: [String: Int] = [:]
        private var heightCache: [HeightCacheKey: CGFloat] = [:]
        private var lastMeasuredWidth: CGFloat = 0
        private var scrollCommandGeneration = 0
        private var nearTopSuppressionGeneration = 0
        private var suppressesNearTopTrigger = false
        var lastScrollToBottomRevision = Int.min
        var followsLatest = true
        private var nearTopTriggered = false
        private var positionPublishWorkItem: DispatchWorkItem?
        private var lastPublishedPosition: AppKitChatTimelinePosition?

        /// The timeline width is a parent-owned layout input. Reserving a
        /// legacy scroller gutter unconditionally prevents the feedback loop
        /// where content height toggles the scroller, changes text width, and
        /// makes a two-line message become three lines after it is visible.
        private static let verticalScrollerGutter = NSScroller.scrollerWidth(
            for: .regular,
            scrollerStyle: .legacy
        )

        private struct HeightCacheKey: Hashable {
            let id: String
            let revision: Int
            let widthBucket: Int
        }

        init(
            followsLatest: Binding<Bool>,
            onToggleExpansion: @escaping (String) -> Void,
            onAction: @escaping (AppKitChatTimelineRow.Action) -> Void = { _ in },
            onNearTop: @escaping () -> Void = {},
            onPositionChange: @escaping (AppKitChatTimelinePosition) -> Void = { _ in }
        ) {
            self.followsLatestBinding = followsLatest
            self.onToggleExpansion = onToggleExpansion
            self.onAction = onAction
            self.onNearTop = onNearTop
            self.onPositionChange = onPositionChange
        }

        func attach(tableView: NSTableView, scrollView: NSScrollView) {
            self.tableView = tableView
            self.scrollView = scrollView
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
            synchronizeTableWidth()
        }

        func numberOfRows(in tableView: NSTableView) -> Int {
            rows.count
        }

        func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
            guard rows.indices.contains(row) else { return tableView.rowHeight }
            let item = rows[row]
            let columnWidth = max(120, tableView.tableColumns.first?.width ?? tableView.bounds.width)
            let availableWidth = max(
                20,
                ChatBubbleWidthPolicy.cardWidth(for: item, availableWidth: columnWidth)
                    - ChatBubbleWidthPolicy.horizontalPadding
            )
            let widthBucket = Int(availableWidth.rounded(.down))
            let key = HeightCacheKey(id: item.id, revision: item.contentRevision, widthBucket: widthBucket)
            if let cached = heightCache[key] { return cached }

            let height = NativeTimelineLayoutCache.shared.layout(
                for: item,
                columnWidth: columnWidth
            ).rowHeight
            heightCache[key] = height
            return height
        }


        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            guard rows.indices.contains(row) else { return nil }
            let cell = (tableView.makeView(withIdentifier: Self.nativeCellIdentifier, owner: nil) as? AppKitChatNativeTextCell)
                ?? {
                    ChatPerformanceRecorder.shared.increment(.appKitCellsCreated)
                    return AppKitChatNativeTextCell(identifier: Self.nativeCellIdentifier)
                }()
            ChatPerformanceRecorder.shared.increment(.appKitRowsConfigured)
            cell.setContent(
                rows[row],
                availableWidth: tableView.tableColumns.first?.width ?? tableView.bounds.width,
                onToggleExpansion: onToggleExpansion,
                onAction: onAction
            )
            return cell
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
            synchronizeTableWidth()
            let width = tableView.tableColumns.first?.width ?? tableView.bounds.width
            let prependAnchor = !followsLatest ? visibleAnchor(in: tableView) : nil
            if abs(width - lastMeasuredWidth) >= 1 {
                lastMeasuredWidth = width
                heightCache.removeAll(keepingCapacity: true)
                if tableView.numberOfRows > 0 {
                    tableView.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<tableView.numberOfRows))
                }
            }
            rows = nextRows
            revisionsByID = Dictionary(uniqueKeysWithValues: nextRows.map { ($0.id, $0.contentRevision) })

            guard oldIDs == newIDs else {
                applyStructuralDifference(
                    from: oldIDs,
                    to: newIDs,
                    oldRevisions: oldRevisions,
                    in: tableView
                )
                if followsLatest {
                    scrollToBottom()
                } else if let prependAnchor {
                    restore(anchor: prependAnchor, in: tableView)
                }
                return
            }

            let changed = IndexSet(nextRows.indices.filter { index in
                oldRevisions[nextRows[index].id] != nextRows[index].contentRevision
            })
            guard !changed.isEmpty else { return }
            heightCache = heightCache.filter { key, _ in
                !changed.contains { index in nextRows[index].id == key.id }
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
                    noteHeightChange(for: row, rowID: nextRows[row].id, in: tableView)
                }
            }
            if followsLatest, oldTailRevision != newTailRevision {
                scrollToBottom()
            }
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

        private func noteHeightChange(for row: Int, rowID: String, in tableView: NSTableView) {
            let indexes = IndexSet(integer: row)
            // Keep expansion geometry on the table's single layout clock.
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0
                context.allowsImplicitAnimation = false
                tableView.noteHeightOfRows(withIndexesChanged: indexes)
            }
        }

        func scrollToBottom() {
            guard let tableView, !rows.isEmpty else { return }
            suppressNearTopDuringLayout()
            scrollCommandGeneration &+= 1
            let generation = scrollCommandGeneration
            DispatchQueue.main.async { [weak self, weak tableView] in
                guard let self,
                      self.scrollCommandGeneration == generation,
                      let tableView,
                      !self.rows.isEmpty else { return }
                tableView.layoutSubtreeIfNeeded()
                guard let clipView = self.scrollView?.contentView else { return }
                let lastRowRect = tableView.rect(ofRow: self.rows.count - 1)
                let bottomOrigin = max(0, lastRowRect.maxY - clipView.bounds.height)
                clipView.scroll(to: NSPoint(x: 0, y: bottomOrigin))
                self.scrollView?.reflectScrolledClipView(clipView)
            }
        }

        private func viewportDidScroll() {
            guard let scrollView, let tableView, !rows.isEmpty else { return }
            let visibleMaxY = scrollView.contentView.bounds.maxY
            let contentMaxY = tableView.rect(ofRow: rows.count - 1).maxY
            let nearBottom = contentMaxY - visibleMaxY <= 8
            followsLatest = nearBottom
            if followsLatestBinding.wrappedValue != nearBottom {
                followsLatestBinding.wrappedValue = nearBottom
            }

            // 滚动到顶时触发一次历史补拉（微信/Discord 式「上滑自动加载」）。
            // 离开顶部后复位，允许再次触发。
            let visibleMinY = scrollView.contentView.bounds.minY
            let nearTop = visibleMinY <= 8
            if nearTop && !nearTopTriggered && !suppressesNearTopTrigger {
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

        @objc private func containerFrameDidChange(_ notification: Notification) {
            synchronizeTableWidth()
        }

        private func synchronizeTableWidth() {
            guard let tableView, let scrollView, let column = tableView.tableColumns.first else { return }
            let width = max(120, scrollView.bounds.width - Self.verticalScrollerGutter)
            guard abs(column.width - width) >= 0.5 else { return }
            column.width = width
            // This path now runs only for an actual container resize. Scroller
            // visibility no longer changes the layout width.
            heightCache.removeAll(keepingCapacity: true)
            lastMeasuredWidth = width
            if !rows.isEmpty {
                let allRows = IndexSet(integersIn: 0..<rows.count)
                let visible = tableView.rows(in: tableView.visibleRect)
                if visible.location != NSNotFound {
                    let upperBound = min(rows.count, visible.location + visible.length)
                    for row in visible.location..<upperBound {
                        if let nativeCell = tableView.view(
                            atColumn: 0,
                            row: row,
                            makeIfNecessary: false
                        ) as? AppKitChatNativeTextCell {
                            nativeCell.setContent(
                                rows[row],
                                availableWidth: width,
                                onToggleExpansion: onToggleExpansion,
                                onAction: onAction
                            )
                        }
                    }
                }
                tableView.noteHeightOfRows(withIndexesChanged: allRows)
            }
        }

        private func visibleAnchor(in tableView: NSTableView) -> (id: String, offset: CGFloat)? {
            let visibleRows = tableView.rows(in: tableView.visibleRect)
            guard visibleRows.location != NSNotFound,
                  rows.indices.contains(visibleRows.location) else { return nil }
            let row = visibleRows.location
            let offset = tableView.visibleRect.minY - tableView.rect(ofRow: row).minY
            return (rows[row].id, offset)
        }

        private func restore(anchor: (id: String, offset: CGFloat), in tableView: NSTableView) {
            guard let row = rows.firstIndex(where: { $0.id == anchor.id }),
                  let clipView = scrollView?.contentView else { return }
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
        }

        func restore(position: AppKitChatTimelinePosition) {
            guard let tableView else { return }
            followsLatest = position.followsLatest
            if followsLatestBinding.wrappedValue != position.followsLatest {
                followsLatestBinding.wrappedValue = position.followsLatest
            }
            restore(anchor: (position.rowID, CGFloat(position.offset)), in: tableView)
        }

        private func schedulePositionPublish() {
            positionPublishWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                guard let self, let tableView = self.tableView,
                      let anchor = self.visibleAnchor(in: tableView) else { return }
                let position = AppKitChatTimelinePosition(
                    rowID: anchor.id,
                    offset: Double(anchor.offset),
                    followsLatest: self.followsLatest
                )
                guard position != self.lastPublishedPosition else { return }
                self.lastPublishedPosition = position
                self.onPositionChange(position)
            }
            positionPublishWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: workItem)
        }

        private func suppressNearTopDuringLayout() {
            nearTopSuppressionGeneration &+= 1
            let generation = nearTopSuppressionGeneration
            suppressesNearTopTrigger = true
            DispatchQueue.main.async { [weak self] in
                guard let self, self.nearTopSuppressionGeneration == generation else { return }
                self.suppressesNearTopTrigger = false
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
final class AppKitChatNativeTextCell: NSTableCellView {
    private let cardView = NSView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let metadataLabel = NSTextField(labelWithString: "")
    private let hoverTimestampLabel = NSTextField(labelWithString: "")
    private let label = NSTextField(wrappingLabelWithString: "")
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
    private var labelBottomToProcessConstraint: NSLayoutConstraint!
    private var labelBottomToActionsConstraint: NSLayoutConstraint!
    private var labelTopToProcessButtonConstraint: NSLayoutConstraint!
    private var labelBottomToCardConstraint: NSLayoutConstraint!
    private var timestampBeforeCardConstraint: NSLayoutConstraint!
    private var timestampAfterCardConstraint: NSLayoutConstraint!
    private var expandableTurnId: String?
    private var onToggleExpansion: ((String) -> Void)?
    private var timelineActions: [AppKitChatTimelineRow.Action] = []
    private var onAction: ((AppKitChatTimelineRow.Action) -> Void)?
    private var copiedText = ""

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
        disclosureButton.translatesAutoresizingMaskIntoConstraints = false
        copyButton.translatesAutoresizingMaskIntoConstraints = false
        messageActionBar.translatesAutoresizingMaskIntoConstraints = false
        messageActionBar.orientation = .horizontal
        messageActionBar.alignment = .centerY
        messageActionBar.spacing = 2
        actionStack.translatesAutoresizingMaskIntoConstraints = false
        actionStack.orientation = .horizontal
        actionStack.alignment = .centerY
        actionStack.spacing = 8
        processSeparator.translatesAutoresizingMaskIntoConstraints = false
        processSeparator.wantsLayer = true
        processButton.translatesAutoresizingMaskIntoConstraints = false
        label.isSelectable = true
        label.maximumNumberOfLines = 0
        label.lineBreakMode = .byWordWrapping
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
        label.identifier = NSUserInterfaceItemIdentifier("chat.timeline.body")
        hoverTimestampLabel.identifier = NSUserInterfaceItemIdentifier("chat.timeline.hover-timestamp")
        hoverTimestampLabel.font = .systemFont(ofSize: 9, weight: .medium)
        hoverTimestampLabel.textColor = NativeTimelineCardPalette.mutedText
        hoverTimestampLabel.maximumNumberOfLines = 1
        hoverTimestampLabel.alphaValue = 0
        addSubview(cardView)
        addSubview(hoverTimestampLabel)
        addSubview(messageActionBar)
        [titleLabel, metadataLabel, label, disclosureButton, actionStack, processSeparator, processButton].forEach(cardView.addSubview)
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
        labelBottomToProcessConstraint = label.bottomAnchor.constraint(lessThanOrEqualTo: processSeparator.topAnchor, constant: -5)
        labelBottomToActionsConstraint = label.bottomAnchor.constraint(lessThanOrEqualTo: actionStack.topAnchor, constant: -4)
        labelTopToProcessButtonConstraint = label.topAnchor.constraint(equalTo: processButton.bottomAnchor, constant: 8)
        labelBottomToCardConstraint = label.bottomAnchor.constraint(lessThanOrEqualTo: cardView.bottomAnchor, constant: -10)
        timestampBeforeCardConstraint = hoverTimestampLabel.trailingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: -8)
        timestampAfterCardConstraint = hoverTimestampLabel.leadingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: 8)
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
            processButtonHeight,
            hoverTimestampLabel.centerYAnchor.constraint(equalTo: cardView.centerYAnchor)
        ])
        updateTrackingAreas()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setContent(
        _ row: AppKitChatTimelineRow,
        availableWidth: CGFloat,
        onToggleExpansion: @escaping (String) -> Void,
        onAction: @escaping (AppKitChatTimelineRow.Action) -> Void = { _ in }
    ) {
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth)
        label.attributedStringValue = layout.attributedText
        label.allowsEditingTextAttributes = true
        titleLabel.stringValue = row.title
        titleLabel.font = .systemFont(ofSize: 11, weight: .bold)
        metadataLabel.stringValue = row.metadata
        metadataLabel.font = .systemFont(ofSize: 10, weight: .semibold)
        metadataLabel.textColor = NativeTimelineCardPalette.mutedText
        titleLabel.textColor = row.nativeStyle == .user
            ? NativeTimelineCardPalette.userText
            : NativeTimelineCardPalette.agentText
        disclosureButton.isHidden = true
        disclosureButton.image = NSImage(
            systemSymbolName: row.isExpanded ? "chevron.down" : "chevron.right",
            accessibilityDescription: row.isExpanded ? "Collapse process" : "Expand process"
        )
        expandableTurnId = row.expandableTurnId
        self.onToggleExpansion = onToggleExpansion
        self.onAction = onAction
        configureActions(row.actions)
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
        cardWidthConstraint.constant = layout.cardWidth
        cardLeadingConstraint.isActive = row.nativeStyle != .user
        cardTrailingConstraint.isActive = row.nativeStyle == .user
        NSLayoutConstraint.deactivate([timestampBeforeCardConstraint, timestampAfterCardConstraint])
        if row.nativeStyle == .user {
            timestampBeforeCardConstraint.isActive = true
        } else if row.nativeStyle == .agent {
            timestampAfterCardConstraint.isActive = true
        }
        let hasProcess = row.processCount != nil
        let isStandaloneProcess = row.nativeStyle == .process
        let showsHeader = row.showsHeader && !isStandaloneProcess
        titleLabel.isHidden = !showsHeader
        metadataLabel.isHidden = !showsHeader
        NSLayoutConstraint.deactivate([
            labelTopToTitleConstraint,
            labelTopToCardConstraint,
            labelTopToProcessButtonConstraint,
            labelBottomToCardConstraint,
            processButtonTopConstraint,
            processButtonBottomConstraint
        ])
        if isStandaloneProcess {
            NSLayoutConstraint.deactivate([labelBottomToProcessConstraint, labelBottomToActionsConstraint])
            processButtonTopConstraint.isActive = true
            if row.isExpanded {
                labelTopToProcessButtonConstraint.isActive = true
                labelBottomToCardConstraint.isActive = true
            }
        } else {
            (showsHeader ? labelTopToTitleConstraint : labelTopToCardConstraint).isActive = true
            processButtonBottomConstraint.isActive = true
        }
        hoverTimestampLabel.stringValue = row.hoverTimestamp
        hoverTimestampLabel.isHidden = row.hoverTimestamp.isEmpty || isStandaloneProcess
        hoverTimestampLabel.alphaValue = 0
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
        if row.nativeStyle != .process { cardView.layer?.cornerRadius = 14 }
        processSeparator.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.045).cgColor
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
            hoverTimestampLabel.animator().alphaValue = hoverTimestampLabel.isHidden ? 0 : 1
        }
    }

    override func mouseExited(with event: NSEvent) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            messageActionBar.animator().alphaValue = 0
            hoverTimestampLabel.animator().alphaValue = 0
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

private enum NativeTimelineCardPalette {
    static let secondaryText = NSColor(calibratedRed: 0.24, green: 0.27, blue: 0.29, alpha: 1)
    static let mutedText = NSColor(calibratedRed: 0.38, green: 0.41, blue: 0.43, alpha: 1)
    static let userText = NSColor(calibratedRed: 0.22, green: 0.35, blue: 0.62, alpha: 1)
    static let agentText = NSColor(calibratedRed: 0.18, green: 0.48, blue: 0.27, alpha: 1)
    static let userBackground = NSColor(calibratedRed: 0.945, green: 0.965, blue: 0.988, alpha: 1)
    static let userBorder = NSColor(calibratedRed: 0.45, green: 0.58, blue: 0.76, alpha: 0.22)
}

private final class IntrinsicHeightTableView: NSTableView {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        enclosingScrollView?.contentView.postsBoundsChangedNotifications = true
    }
}

/// NSTableView can temporarily retain a document frame taller than its final
/// row geometry while SwiftUI resizes or rows are remeasured. The stock clip
/// view then exposes that surplus as scrollable blank space. The timeline's
/// semantic bottom is always the lower edge of its last row.
private final class TimelineBoundedClipView: NSClipView {
    override var documentRect: NSRect {
        var rect = super.documentRect
        guard let tableView = documentView as? NSTableView,
              tableView.numberOfRows > 0 else { return rect }
        rect.size.height = max(0, tableView.rect(ofRow: tableView.numberOfRows - 1).maxY - rect.minY)
        return rect
    }

    override func constrainBoundsRect(_ proposedBounds: NSRect) -> NSRect {
        var constrained = super.constrainBoundsRect(proposedBounds)
        let maximumY = max(documentRect.minY, documentRect.maxY - constrained.height)
        constrained.origin.y = min(max(constrained.origin.y, documentRect.minY), maximumY)
        return constrained
    }

    override func setBoundsOrigin(_ newOrigin: NSPoint) {
        let proposedBounds = NSRect(origin: newOrigin, size: bounds.size)
        super.setBoundsOrigin(constrainBoundsRect(proposedBounds).origin)
    }

    override func scroll(to newOrigin: NSPoint) {
        setBoundsOrigin(newOrigin)
    }
}
