import AppKit
import SwiftUI

@MainActor
enum NativeMarkdownAttributedText {
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
        listItem(in: line, pattern: #"^(\s*)[-+*]\s+(.+)$"#).map { ($0.depth, $0.text) }
    }

    private static func orderedListItem(in line: String) -> (depth: Int, ordinal: String, text: String)? {
        guard let regex = try? NSRegularExpression(pattern: #"^(\s*)(\d+)[.)]\s+(.+)$"#),
              let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
              let indentRange = Range(match.range(at: 1), in: line),
              let ordinalRange = Range(match.range(at: 2), in: line),
              let textRange = Range(match.range(at: 3), in: line) else { return nil }
        return (String(line[indentRange]).count / 2, String(line[ordinalRange]), String(line[textRange]))
    }

    private static func listItem(in line: String, pattern: String) -> (depth: Int, text: String)? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
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

    static func requiresSwiftUIRenderer(_ markdown: String) -> Bool {
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
        case swiftUI
    }

    static func route(for entry: ChatDisplayEntry) -> Route {
        switch entry.kind {
        case .message(let item):
            return requiresSwiftUIHosting(item) ? .swiftUI : .native
        case .userTurn:
            // A user turn is one composed card in the established UI. Keep the
            // complete ThreadItemView so the localized footer, disclosure
            // interaction, animation, and height measurement remain identical
            // to the pre-AppKit renderer. Plain user messages still use the
            // native path through `.message` above.
            return .swiftUI
        case .process:
            return .swiftUI
        }
    }

    static func requiresSwiftUIHosting(_ item: CodexThreadItem) -> Bool {
        let text = displayText(for: item)
        return item.type == "approval"
            || item.type == "choice"
            || item.presentationRole == "collaboration"
            || item.sourceType == "collaboration"
            || !(item.fileChanges ?? []).isEmpty
            || NativeMarkdownCompatibility.requiresSwiftUIRenderer(text)
            // Native text rows use a deliberately inexpensive height path.
            // Large prose/list replies are much more sensitive to wrapping and
            // attributed-string metrics; host those with their established
            // SwiftUI card so the rendered view owns its exact height.
            || text.count > 600
            || text.filter(\.isNewline).count > 10
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
private final class NativeMarkdownTextCache {
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

struct AppKitChatTimelineRow: Identifiable {
    let id: String
    let contentRevision: Int
    let content: AnyView?
    let nativeText: String
    let copyText: String
    let nativeStyle: NativeStyle
    let title: String
    let metadata: String
    let expandableTurnId: String?
    let isExpanded: Bool
    let processCount: Int?
    let processDuration: String?

    init(
        id: String,
        contentRevision: Int,
        content: AnyView?,
        nativeText: String,
        copyText: String,
        nativeStyle: NativeStyle,
        title: String,
        metadata: String,
        expandableTurnId: String?,
        isExpanded: Bool,
        processCount: Int? = nil,
        processDuration: String? = nil
    ) {
        self.id = id
        self.contentRevision = contentRevision
        self.content = content
        self.nativeText = nativeText
        self.copyText = copyText
        self.nativeStyle = nativeStyle
        self.title = title
        self.metadata = metadata
        self.expandableTurnId = expandableTurnId
        self.isExpanded = isExpanded
        self.processCount = processCount
        self.processDuration = processDuration
    }

    enum NativeStyle: Hashable {
        case user
        case agent
        case process
    }
}

@MainActor
enum NativeTimelineCardLayout {
    static let maximumWidth: CGFloat = 480
    static let minimumWidth: CGFloat = 88
    static let horizontalPadding: CGFloat = 20

    static func cardWidth(for row: AppKitChatTimelineRow, availableWidth: CGFloat) -> CGFloat {
        let available = max(minimumWidth, availableWidth - 4)
        guard row.nativeStyle != .process else { return available }

        let attributed = NativeMarkdownTextCache.shared.value(text: row.nativeText, style: row.nativeStyle)
        let bodyWidth = ceil(attributed.boundingRect(
            with: NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        ).width)
        let titleWidth = ceil((row.title as NSString).size(withAttributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .bold)
        ]).width)
        let metadataWidth = ceil((row.metadata as NSString).size(withAttributes: [
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold)
        ]).width)
        let headerWidth = titleWidth + metadataWidth + 12
        let processWidth: CGFloat = row.processCount == nil ? 0 : 180
        return min(available, maximumWidth, max(minimumWidth, max(bodyWidth, headerWidth, processWidth) + horizontalPadding))
    }
}

struct AppKitChatTimelineView: NSViewRepresentable {
    let rows: [AppKitChatTimelineRow]
    let scrollToBottomRevision: Int
    let usesNativeText: Bool
    @Binding var followsLatest: Bool
    let onToggleExpansion: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            usesNativeText: usesNativeText,
            followsLatest: $followsLatest,
            onToggleExpansion: onToggleExpansion
        )
    }

    func makeNSView(context: Context) -> NSScrollView {
        let tableView = Self.makeTableView()
        let scrollView = Self.makeScrollView(tableView: tableView)

        context.coordinator.attach(tableView: tableView, scrollView: scrollView)
        context.coordinator.apply(rows: rows, animated: false)
        if followsLatest {
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
        tableView.intercellSpacing = NSSize(width: 0, height: 8)
        tableView.rowHeight = 112
        tableView.usesAutomaticRowHeights = true
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
        let scrollView = ChatTimelineScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.documentView = tableView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.followsLatest = followsLatest
        context.coordinator.onToggleExpansion = onToggleExpansion
        context.coordinator.apply(rows: rows, animated: context.transaction.animation != nil)
        if context.coordinator.lastScrollToBottomRevision != scrollToBottomRevision {
            context.coordinator.lastScrollToBottomRevision = scrollToBottomRevision
            context.coordinator.scrollToBottom()
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        static let columnIdentifier = NSUserInterfaceItemIdentifier("chat.timeline.column")
        private static let cellIdentifier = NSUserInterfaceItemIdentifier("chat.timeline.hosting.cell")
        private static let nativeCellIdentifier = NSUserInterfaceItemIdentifier("chat.timeline.native.cell")

        private let usesNativeText: Bool
        private let followsLatestBinding: Binding<Bool>
        var onToggleExpansion: (String) -> Void
        private weak var tableView: NSTableView?
        private weak var scrollView: NSScrollView?
        private var rows: [AppKitChatTimelineRow] = []
        private var revisionsByID: [String: Int] = [:]
        private var heightCache: [HeightCacheKey: CGFloat] = [:]
        private var lastMeasuredWidth: CGFloat = 0
        var lastScrollToBottomRevision = Int.min
        var followsLatest = true

        private struct HeightCacheKey: Hashable {
            let id: String
            let revision: Int
            let widthBucket: Int
        }

        init(
            usesNativeText: Bool,
            followsLatest: Binding<Bool>,
            onToggleExpansion: @escaping (String) -> Void
        ) {
            self.usesNativeText = usesNativeText
            self.followsLatestBinding = followsLatest
            self.onToggleExpansion = onToggleExpansion
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
            if item.content != nil {
                // Hosted rows derive their actual height from the visible
                // NSHostingView's Auto Layout constraints. `rowHeight` remains
                // only the estimate used before an off-screen cell is realized.
                return -1
            }
            let columnWidth = max(120, tableView.tableColumns.first?.width ?? tableView.bounds.width)
            let availableWidth = usesNativeText && item.content == nil
                ? max(120, NativeTimelineCardLayout.cardWidth(for: item, availableWidth: columnWidth) - NativeTimelineCardLayout.horizontalPadding)
                : columnWidth
            let widthBucket = Int(availableWidth.rounded(.down))
            let key = HeightCacheKey(id: item.id, revision: item.contentRevision, widthBucket: widthBucket)
            if let cached = heightCache[key] { return cached }

            let height: CGFloat
            if usesNativeText, item.content == nil {
                if item.nativeStyle == .process {
                    height = 28
                    heightCache[key] = height
                    return height
                }
                let attributed = NativeMarkdownTextCache.shared.value(text: item.nativeText, style: item.nativeStyle)
                let bounds = attributed.boundingRect(
                    with: NSSize(width: availableWidth, height: .greatestFiniteMagnitude),
                    options: [.usesLineFragmentOrigin, .usesFontLeading]
                )
                let footerHeight: CGFloat = item.processCount == nil ? 0 : 24
                height = max(54, ceil(bounds.height) + 39 + footerHeight)
            } else {
                height = 140
            }
            heightCache[key] = height
            return height
        }


        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            guard rows.indices.contains(row) else { return nil }
            if usesNativeText, rows[row].content == nil {
                let cell = (tableView.makeView(withIdentifier: Self.nativeCellIdentifier, owner: nil) as? AppKitChatNativeTextCell)
                    ?? {
                        ChatPerformanceRecorder.shared.increment(.appKitCellsCreated)
                        return AppKitChatNativeTextCell(identifier: Self.nativeCellIdentifier)
                    }()
                ChatPerformanceRecorder.shared.increment(.appKitRowsConfigured)
                cell.setContent(rows[row], availableWidth: tableView.tableColumns.first?.width ?? tableView.bounds.width, onToggleExpansion: onToggleExpansion)
                return cell
            }
            let cell = (tableView.makeView(withIdentifier: Self.cellIdentifier, owner: nil) as? AppKitChatHostingCell)
                ?? {
                    ChatPerformanceRecorder.shared.increment(.appKitCellsCreated)
                    return AppKitChatHostingCell(identifier: Self.cellIdentifier)
                }()
            ChatPerformanceRecorder.shared.increment(.appKitRowsConfigured)
            configureHostingCell(cell, in: tableView, row: row)
            return cell
        }

        func apply(rows nextRows: [AppKitChatTimelineRow], animated: Bool = false) {
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
                ChatPerformanceTrace.measure("appkit.table.reload.structure") {
                    tableView.reloadData()
                }
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
            var rowsRequiringReplacement = IndexSet()
            for row in changed {
                let currentCell = tableView.view(atColumn: 0, row: row, makeIfNecessary: false)
                if let hostingCell = currentCell as? AppKitChatHostingCell,
                   nextRows[row].content != nil {
                    configureHostingCell(hostingCell, in: tableView, row: row)
                    noteHeightChange(for: row, rowID: nextRows[row].id, in: tableView)
                } else if let nativeCell = currentCell as? AppKitChatNativeTextCell,
                          usesNativeText,
                          nextRows[row].content == nil {
                    nativeCell.setContent(nextRows[row], availableWidth: tableView.tableColumns.first?.width ?? tableView.bounds.width, onToggleExpansion: onToggleExpansion)
                    noteHeightChange(for: row, rowID: nextRows[row].id, in: tableView)
                } else {
                    rowsRequiringReplacement.insert(row)
                }
            }
            if !rowsRequiringReplacement.isEmpty {
                ChatPerformanceTrace.measure("appkit.table.reload.rows") {
                    tableView.reloadData(
                        forRowIndexes: rowsRequiringReplacement,
                        columnIndexes: IndexSet(integer: 0)
                    )
                }
            }
            if followsLatest, oldTailRevision != newTailRevision {
                scrollToBottom()
            }
        }

        private func configureHostingCell(
            _ cell: AppKitChatHostingCell,
            in tableView: NSTableView,
            row: Int
        ) {
            guard rows.indices.contains(row), let content = rows[row].content else { return }
            let availableWidth = max(120, tableView.tableColumns.first?.width ?? tableView.bounds.width)
            cell.setContent(
                content,
                width: availableWidth,
                expandableTurnId: rows[row].expandableTurnId,
                isExpanded: rows[row].isExpanded,
                onToggleExpansion: onToggleExpansion
            )
        }

        private func noteHeightChange(for row: Int, rowID: String, in tableView: NSTableView) {
            let indexes = IndexSet(integer: row)
            // SwiftUI already animates the inserted/removed process content.
            // A second AppKit animation for the enclosing table row runs on a
            // different layout clock and briefly exposes a stale clipped frame.
            // Update the row geometry in the same transaction instead.
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0
                context.allowsImplicitAnimation = false
                tableView.noteHeightOfRows(withIndexesChanged: indexes)
            }
        }

        func scrollToBottom() {
            guard let tableView, !rows.isEmpty else { return }
            DispatchQueue.main.async {
                tableView.scrollRowToVisible(self.rows.count - 1)
            }
        }

        private func viewportDidScroll() {
            guard let scrollView, let tableView, !rows.isEmpty else { return }
            let visibleMaxY = scrollView.contentView.bounds.maxY
            let contentMaxY = tableView.bounds.maxY
            let nearBottom = contentMaxY - visibleMaxY <= 8
            followsLatest = nearBottom
            if followsLatestBinding.wrappedValue != nearBottom {
                followsLatestBinding.wrappedValue = nearBottom
            }
        }

        @objc private func viewportBoundsDidChange(_ notification: Notification) {
            viewportDidScroll()
        }

        @objc private func containerFrameDidChange(_ notification: Notification) {
            synchronizeTableWidth()
        }

        private func synchronizeTableWidth() {
            guard let tableView, let scrollView, let column = tableView.tableColumns.first else { return }
            let width = max(120, scrollView.contentSize.width)
            guard abs(column.width - width) >= 0.5 else { return }
            column.width = width
            // A vertical scroller changes contentSize.width (typically by
            // 17 pt). Both native cached heights and hosted intrinsic heights
            // are width-dependent, so rebuild visible cells under the new
            // column constraint.
            heightCache.removeAll(keepingCapacity: true)
            lastMeasuredWidth = width
            if !rows.isEmpty {
                tableView.reloadData()
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
            DispatchQueue.main.async {
                let y = max(0, tableView.rect(ofRow: row).minY + anchor.offset)
                clipView.scroll(to: NSPoint(x: 0, y: y))
                self.scrollView?.reflectScrolledClipView(clipView)
            }
        }
    }
}

/// Keeps vertical wheel/trackpad gestures owned by the message timeline even
/// when the pointer happens to be above a horizontally scrolling Markdown code
/// block. SwiftUI's nested horizontal `ScrollView` otherwise consumes the
/// vertical event without moving either scroll view, which makes the timeline
/// appear to freeze at arbitrary messages.
@MainActor
final class ChatTimelineScrollView: NSScrollView {
    private var wheelMonitor: Any?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateWheelMonitor()
    }

    static func shouldOwnVerticalWheel(deltaX: CGFloat, deltaY: CGFloat) -> Bool {
        abs(deltaY) > 0.01 && abs(deltaY) >= abs(deltaX)
    }

    private func updateWheelMonitor() {
        if let wheelMonitor {
            NSEvent.removeMonitor(wheelMonitor)
            self.wheelMonitor = nil
        }
        guard window != nil else { return }

        wheelMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self,
                  let window = self.window,
                  event.window === window,
                  Self.shouldOwnVerticalWheel(
                    deltaX: event.scrollingDeltaX,
                    deltaY: event.scrollingDeltaY
                  ) else {
                return event
            }
            let location = self.convert(event.locationInWindow, from: nil)
            guard self.bounds.contains(location) else { return event }

            // Calling super directly bypasses the nested SwiftUI scroll view;
            // returning nil prevents the same event from being handled twice.
            self.scrollTimeline(with: event)
            return nil
        }
    }

    private func scrollTimeline(with event: NSEvent) {
        super.scrollWheel(with: event)
    }
}

@MainActor
final class AppKitChatNativeTextCell: NSTableCellView {
    private let cardView = NSView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let metadataLabel = NSTextField(labelWithString: "")
    private let label = NSTextField(wrappingLabelWithString: "")
    private let disclosureButton = NSButton()
    private let copyButton = NSButton()
    private let processSeparator = NSView()
    private let processButton = NSButton()
    private var processSeparatorHeight: NSLayoutConstraint!
    private var processButtonHeight: NSLayoutConstraint!
    private var cardWidthConstraint: NSLayoutConstraint!
    private var cardLeadingConstraint: NSLayoutConstraint!
    private var cardTrailingConstraint: NSLayoutConstraint!
    private var expandableTurnId: String?
    private var onToggleExpansion: ((String) -> Void)?
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
        label.translatesAutoresizingMaskIntoConstraints = false
        disclosureButton.translatesAutoresizingMaskIntoConstraints = false
        copyButton.translatesAutoresizingMaskIntoConstraints = false
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
        copyButton.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: "Copy message")
        copyButton.imagePosition = .imageOnly
        copyButton.target = self
        copyButton.action = #selector(copyText)
        copyButton.alphaValue = 0
        copyButton.toolTip = "Copy message"
        processButton.isBordered = false
        processButton.alignment = .left
        processButton.target = self
        processButton.action = #selector(toggleDisclosure)
        processButton.identifier = NSUserInterfaceItemIdentifier("chat.timeline.process")
        addSubview(cardView)
        [titleLabel, metadataLabel, label, disclosureButton, copyButton, processSeparator, processButton].forEach(cardView.addSubview)
        processSeparatorHeight = processSeparator.heightAnchor.constraint(equalToConstant: 0)
        processButtonHeight = processButton.heightAnchor.constraint(equalToConstant: 0)
        cardWidthConstraint = cardView.widthAnchor.constraint(equalToConstant: NativeTimelineCardLayout.maximumWidth)
        cardLeadingConstraint = cardView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2)
        cardTrailingConstraint = cardView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2)
        NSLayoutConstraint.activate([
            cardWidthConstraint,
            cardLeadingConstraint,
            cardView.topAnchor.constraint(equalTo: topAnchor, constant: 1),
            cardView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -1),
            disclosureButton.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            disclosureButton.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 8),
            disclosureButton.widthAnchor.constraint(equalToConstant: 16),
            disclosureButton.heightAnchor.constraint(equalToConstant: 16),
            titleLabel.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            titleLabel.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 9),
            metadataLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            metadataLabel.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
            copyButton.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -4),
            copyButton.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -4),
            copyButton.widthAnchor.constraint(equalToConstant: 22),
            copyButton.heightAnchor.constraint(equalToConstant: 22),
            label.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            label.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 6),
            label.bottomAnchor.constraint(lessThanOrEqualTo: processSeparator.topAnchor, constant: -5),
            processSeparator.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            processSeparator.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            processSeparator.bottomAnchor.constraint(equalTo: processButton.topAnchor),
            processSeparatorHeight,
            processButton.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            processButton.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            processButton.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -3),
            processButtonHeight
        ])
        updateTrackingAreas()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setContent(_ row: AppKitChatTimelineRow, availableWidth: CGFloat, onToggleExpansion: @escaping (String) -> Void) {
        label.attributedStringValue = NativeMarkdownTextCache.shared.value(text: row.nativeText, style: row.nativeStyle)
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
        copiedText = row.copyText
        cardWidthConstraint.constant = NativeTimelineCardLayout.cardWidth(for: row, availableWidth: availableWidth)
        cardLeadingConstraint.isActive = row.nativeStyle != .user
        cardTrailingConstraint.isActive = row.nativeStyle == .user
        let hasProcess = row.processCount != nil
        let isStandaloneProcess = row.nativeStyle == .process
        titleLabel.isHidden = isStandaloneProcess
        metadataLabel.isHidden = isStandaloneProcess
        label.isHidden = isStandaloneProcess
        processSeparator.isHidden = !hasProcess || isStandaloneProcess
        processButton.isHidden = !hasProcess
        processSeparatorHeight.constant = hasProcess && !isStandaloneProcess ? 1 : 0
        processButtonHeight.constant = hasProcess ? 22 : 0
        if let count = row.processCount {
            let chevron = row.isExpanded ? "▾" : "▸"
            let duration = row.processDuration.map { "  \($0)" } ?? ""
            processButton.attributedTitle = NSAttributedString(
                string: "\(chevron)  ↳  Execution process\(duration)   \(count)",
                attributes: [
                    .font: NSFont.systemFont(ofSize: 9.5, weight: .semibold),
                    .foregroundColor: NativeTimelineCardPalette.secondaryText
                ]
            )
        }
        switch row.nativeStyle {
        case .user, .agent:
            cardView.layer?.backgroundColor = NSColor.white.cgColor
            cardView.layer?.borderColor = NSColor.black.withAlphaComponent(0.08).cgColor
        case .process:
            cardView.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.42).cgColor
            cardView.layer?.borderColor = NSColor.black.withAlphaComponent(0.045).cgColor
            cardView.layer?.cornerRadius = 13
        }
        if row.nativeStyle != .process { cardView.layer?.cornerRadius = 14 }
        processSeparator.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.045).cgColor
        needsLayout = true
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
            copyButton.animator().alphaValue = copiedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : 1
        }
    }

    override func mouseExited(with event: NSEvent) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            copyButton.animator().alphaValue = 0
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
}

private enum NativeTimelineCardPalette {
    static let secondaryText = NSColor(calibratedRed: 0.24, green: 0.27, blue: 0.29, alpha: 1)
    static let mutedText = NSColor(calibratedRed: 0.38, green: 0.41, blue: 0.43, alpha: 1)
    static let userText = NSColor(calibratedRed: 0.22, green: 0.35, blue: 0.62, alpha: 1)
    static let agentText = NSColor(calibratedRed: 0.18, green: 0.48, blue: 0.27, alpha: 1)
}

private final class IntrinsicHeightTableView: NSTableView {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        enclosingScrollView?.contentView.postsBoundsChangedNotifications = true
    }
}

@MainActor
final class AppKitChatHostingCell: NSTableCellView {
    private let hostingView = FirstMouseTimelineHostingView(rootView: AnyView(EmptyView()))
    private let collapsedProcessHitTarget = FirstMouseTimelineButton()
    private var expandableTurnId: String?
    private var onToggleExpansion: ((String) -> Void)?

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        hostingView.translatesAutoresizingMaskIntoConstraints = false
        hostingView.sizingOptions = [.intrinsicContentSize]
        hostingView.setContentHuggingPriority(.required, for: .vertical)
        hostingView.setContentCompressionResistancePriority(.required, for: .vertical)
        addSubview(hostingView)
        collapsedProcessHitTarget.translatesAutoresizingMaskIntoConstraints = false
        collapsedProcessHitTarget.isBordered = false
        collapsedProcessHitTarget.title = ""
        collapsedProcessHitTarget.identifier = NSUserInterfaceItemIdentifier("chat.timeline.hosted-process-hit-target")
        collapsedProcessHitTarget.target = self
        collapsedProcessHitTarget.action = #selector(toggleCollapsedProcess)
        collapsedProcessHitTarget.isHidden = true
        addSubview(collapsedProcessHitTarget)
        NSLayoutConstraint.activate([
            hostingView.leadingAnchor.constraint(equalTo: leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: trailingAnchor),
            hostingView.topAnchor.constraint(equalTo: topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: bottomAnchor),
            collapsedProcessHitTarget.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            collapsedProcessHitTarget.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            collapsedProcessHitTarget.bottomAnchor.constraint(equalTo: bottomAnchor),
            collapsedProcessHitTarget.heightAnchor.constraint(equalToConstant: 28)
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setContent(
        _ content: AnyView,
        width: CGFloat,
        expandableTurnId: String? = nil,
        isExpanded: Bool = false,
        onToggleExpansion: @escaping (String) -> Void = { _ in }
    ) {
        self.expandableTurnId = expandableTurnId
        self.onToggleExpansion = onToggleExpansion
        collapsedProcessHitTarget.isHidden = expandableTurnId == nil || isExpanded
        hostingView.rootView = AnyView(
            content
                // NSHostingView otherwise asks SwiftUI for its unconstrained
                // ideal width. Long Markdown may report a width several times
                // wider than the table column and therefore an intrinsic height
                // that is far too short for the actual wrapped content. Give
                // SwiftUI the table's real width before it computes height.
                .frame(width: width, alignment: .topLeading)
                .fixedSize(horizontal: false, vertical: true)
        )
        // NSTableView automatic row heights and the hosting view's Auto Layout
        // constraints are the only sizing authority. Reading the intrinsic size
        // here and feeding it back through a second cache races the table's row
        // geometry and lets newly expanded content draw over the next row.
        hostingView.invalidateIntrinsicContentSize()
        invalidateIntrinsicContentSize()
        needsLayout = true
    }

    @objc private func toggleCollapsedProcess() {
        guard let expandableTurnId else { return }
        onToggleExpansion?(expandableTurnId)
    }
}

private final class FirstMouseTimelineHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }
}

private final class FirstMouseTimelineButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }
}
