import AppKit
import SwiftUI
import CorptieConversation
import CorptieClientCore

@MainActor
enum NativeMarkdownAttributedText {
    static func make(text: String, style: AppKitChatTimelineRow.NativeStyle,
                     boundary: MessageTextBoundary = .both, typography: ConversationTypography = .classic) -> NSAttributedString {
        let sharedStyle: MessageMarkdown.Style = switch style {
        case .user: .user
        case .agent: .agent
        case .process: .process
        }
        return MessageMarkdown.make(text: text, style: sharedStyle, boundary: boundary, typography: typography)
    }
}

/// Full-width Markdown detection is shared with the iPad timeline (`MessageBubbleWidthPolicy`).
enum NativeMarkdownCompatibility {
    static func requiresFullWidthLayout(_ markdown: String) -> Bool {
        MessageBubbleWidthPolicy.requiresFullWidthLayout(markdown)
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
        ConversationMessageDisplayText.resolve(text: item.text,
            presentationText: item.presentationText, title: item.title, type: item.type,
            hasImages: item.images?.isEmpty == false)
    }

    static func copyText(for item: CodexThreadItem) -> String {
        ConversationMessageDisplayText.copyText(type: item.type,
            authoritativeText: item.text, presentationText: item.presentationText,
            displayedText: displayText(for: item))
    }
}

@MainActor
final class NativeMarkdownTextCache {
    private struct Key: Hashable {
        let text: String
        let style: AppKitChatTimelineRow.NativeStyle
        let boundary: MessageTextBoundary
    }

    static let shared = NativeMarkdownTextCache()
    private struct Entry { let typography: ConversationTypography; let value: NSAttributedString }
    private var values: [Key: Entry] = [:]
    private var accessByKey: [Key: UInt64] = [:]
    private var accessSequence: UInt64 = 0
    private let limit = 1_000
    private let byteLimit = 16 * 1_024 * 1_024
    private var estimatedBytes = 0

    func value(text: String, style: AppKitChatTimelineRow.NativeStyle,
               boundary: MessageTextBoundary = .both, typography: ConversationTypography = .classic) -> NSAttributedString {
        let key = Key(text: text, style: style, boundary: boundary)
        if let cached = values[key], cached.typography == typography {
            touch(key)
            return cached.value
        }
        if let old = values[key] { estimatedBytes -= estimatedByteCount(for: key, value: old.value) }
        let attributed = NativeMarkdownAttributedText.make(text: text, style: style, boundary: boundary, typography: typography)
        values[key] = Entry(typography: typography, value: attributed)
        touch(key)
        estimatedBytes += estimatedByteCount(for: key, value: attributed)
        while values.count > limit || estimatedBytes > byteLimit,
              let oldest = accessByKey.min(by: { $0.value < $1.value })?.key {
            if let removed = values.removeValue(forKey: oldest) {
                estimatedBytes = max(0, estimatedBytes - estimatedByteCount(for: oldest, value: removed.value))
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
        (key.text.utf16.count * 2) + (value.length * 6) + 128 + MessageMarkdown.mathImageCost(in: value)
    }
}

/// The single geometry source for native message text. Both cached row heights
/// and the on-screen body use TextKit with the same container width, padding,
/// and attributed content. This prevents a row from being measured with one
/// wrapping engine and rendered with another.
@MainActor
enum NativeTextKitLayout {
    private final class Workspace {
        let source: NSAttributedString
        let storage: NSTextStorage
        let manager = NSLayoutManager()
        let container = NSTextContainer(containerSize: NSSize(width: 1, height: CGFloat.greatestFiniteMagnitude))

        init(_ source: NSAttributedString) {
            self.source = source
            storage = NSTextStorage(attributedString: source)
            container.lineFragmentPadding = 0
            container.widthTracksTextView = false
            container.heightTracksTextView = false
            manager.addTextContainer(container)
            storage.addLayoutManager(manager)
        }

        func height(of text: NSAttributedString, width: CGFloat, maximumLines: Int) -> CGFloat {
            // Support mutable callers too; immutable markdown keeps its glyphs
            // across width changes instead of constructing a new layout stack.
            if !storage.isEqual(to: text) { storage.setAttributedString(text) }
            container.lineBreakMode = maximumLines > 0 ? .byTruncatingTail : .byWordWrapping
            container.maximumNumberOfLines = maximumLines
            container.containerSize = NSSize(width: max(1, width), height: .greatestFiniteMagnitude)
            manager.ensureLayout(for: container)
            return ceil(manager.usedRect(for: container).height)
        }
    }

    // Identity lookup over four workspaces adds no hashing. Bound retained
    // glyph state independently of the existing attributed-string caches.
    private static var workspaces: [Workspace] = []
    private static let maximumCharacters = 200_000

    static func height(of attributedText: NSAttributedString, width: CGFloat, maximumLines: Int = 0) -> CGFloat {
        guard attributedText.length > 0 else { return 0 }
        let workspace: Workspace
        if let index = workspaces.firstIndex(where: { $0.source === attributedText }) {
            workspace = workspaces.remove(at: index)
        } else {
            workspace = Workspace(attributedText)
        }
        let height = workspace.height(of: attributedText, width: width, maximumLines: maximumLines)
        if attributedText.length <= maximumCharacters { workspaces.append(workspace) }
        while workspaces.count > 4 || workspaces.reduce(0, { $0 + $1.storage.length }) > maximumCharacters {
            workspaces.removeFirst()
        }
        return height
    }
}

/// Reuses TextKit's paragraph layout when a plan revision changes only a few
/// checklist lines. The resulting height still comes from the same layout
/// manager as the cold path; no estimated geometry reaches NSTableView.
@MainActor
final class NativePlanChecklistHeightCache {
    private struct TaskEntry {
        let revision: Int
        let collapsed: CGFloat
        let expanded: CGFloat
        var access: UInt64
    }
    private struct Key: Hashable {
        let widthBucket: Int
        let lifecycle: String
        let explanation: String?
        let totalCount: Int
        let visibleTexts: [String]
    }
    private struct Entry {
        let height: CGFloat
        var access: UInt64
    }
    static let shared = NativePlanChecklistHeightCache()
    private var entries: [Key: Entry] = [:]
    private var taskEntries: [String: TaskEntry] = [:]
    private var sequence: UInt64 = 0
    private(set) var measurementCount = 0
    private(set) var taskPreparationCount = 0

    func height(of plan: ConversationExecutionPlan, width: CGFloat, expanded: Bool = false) -> CGFloat {
        if plan.taskId != nil {
            // Both heights are prepared together on data/width changes. A
            // disclosure click is a constant-time lookup, not a list scan or
            // an offscreen render of every item.
            let key = plan.planId + ":" + String(Int((width * 2).rounded(.down)))
            sequence &+= 1
            if var cached = taskEntries[key], cached.revision == plan.revision {
                cached.access = sequence
                taskEntries[key] = cached
                return expanded ? cached.expanded : cached.collapsed
            }
            let heights = TaskExecutionChecklist.heights(plan: plan, width: width)
            let entry = TaskEntry(revision: plan.revision, collapsed: heights.collapsed,
                                  expanded: heights.expanded, access: sequence)
            taskEntries[key] = entry
            taskPreparationCount += 1
            if taskEntries.count > 64, let oldest = taskEntries.min(by: { $0.value.access < $1.value.access })?.key {
                taskEntries.removeValue(forKey: oldest)
            }
            return expanded ? entry.expanded : entry.collapsed
        }
        let key = Key(widthBucket: Int((width * 2).rounded()), lifecycle: plan.lifecycle,
            explanation: plan.explanation, totalCount: plan.steps.count,
            visibleTexts: plan.steps.map(\.text))
        sequence &+= 1
        if var entry = entries[key] {
            entry.access = sequence
            entries[key] = entry
            return entry.height
        }
        let host = NSHostingView(rootView: ExecutionPlanChecklist(plan: plan)
            .frame(width: width, alignment: .leading))
        host.frame = NSRect(x: 0, y: 0, width: width, height: 1)
        host.layoutSubtreeIfNeeded()
        let height = ceil(host.fittingSize.height)
        measurementCount += 1
        entries[key] = Entry(height: height, access: sequence)
        if entries.count > 64, let oldest = entries.min(by: { $0.value.access < $1.value.access })?.key {
            entries.removeValue(forKey: oldest)
        }
        return height
    }
}

/// Final native row geometry, shared by all retained Session hosts. The cache
/// key includes every input that can affect wrapping, so a row is never shown
/// with an estimated height and corrected after the first paint.
typealias NativeExecutionTimelineStep = ConversationExecutionStep
typealias NativeExecutionTimelineProjection = ConversationExecutionProjection

@MainActor
enum NativeExecutionTimelineAttributedText {
    static func make(steps: [NativeExecutionTimelineStep]) -> NSAttributedString {
        ExecutionTimelineAttributedText.make(steps: steps, localize: { L10n($0) })
    }
}

@MainActor
final class NativeTimelineLayoutCache {
    struct Layout {
        var timeSeparatorHeight: CGFloat = 0
        var typography: ConversationTypography = .classic
        var imageLayout = MessageImageGalleryLayout.layout(geometries: [], width: 0)
        enum RichBlock {
            case markdown(id: String, NSAttributedString, CGFloat)
            case chart(id: String, ConversationChartSpec, CGFloat)
            case table(id: String, ConversationMarkdownTable, ConversationMarkdownTableLayout)

            var id: String {
                switch self {
                case .markdown(let id, _, _), .chart(let id, _, _), .table(let id, _, _): id
                }
            }
        }
        struct ProcessBlock {
            let step: NativeExecutionTimelineStep
            let attributedText: NSAttributedString
            let textHeight: CGFloat
            let hasOverflow: Bool
            var height: CGFloat { textHeight + 14 + (hasOverflow ? 20 : 0) }
        }
        let attributedText: NSAttributedString
        let richBlocks: [RichBlock]
        let processBlocks: [ProcessBlock]
        let cardWidth: CGFloat
        let textHeight: CGFloat
        let rawStatusHeight: CGFloat
        var rowHeight: CGFloat
        /// Painted card height, excluding the separator and exterior row insets.
        var cardHeight: CGFloat = 0
        var scrollsUserContent = false
        var triggerText: NSAttributedString? = nil
        var triggerTextHeight: CGFloat = 0
        var triggerCanExpand = false
        var sourceIdentity: AppKitChatRowReuseIdentity? = nil
        var sourceSessionID: String? = nil
        var rawStatusText: NSAttributedString? = nil
    }

    static let shared = NativeTimelineLayoutCache()

    func intrinsicContent(for row: AppKitChatTimelineRow, columnWidth: CGFloat,
                          skin: ConversationSkin, reusing previous: Layout? = nil) -> Layout {
        let typography = row.readingTypography(skin.typography(for: row.nativeStyle == .user ? .user : .assistant))
        let width = columnWidth - ReplyLeadingLayout.additionalCardInset(for: row, skin: skin)
        let cardWidth: CGFloat
        if let plan = row.executionPlan, plan.taskId != nil {
            cardWidth = min(780, max(120, width - 14))
        } else if row.userInput != nil || row.executionPlan != nil {
            cardWidth = min(ChatBubbleWidthPolicy.functionalCardMaximumWidth, max(120, width - 8))
        } else {
            cardWidth = ChatBubbleWidthPolicy.cardWidth(for: row, availableWidth: max(120, width), typography: typography)
        }
        let textWidth = max(20, cardWidth - ChatBubbleWidthPolicy.horizontalPadding)
        let identity = AppKitChatRowReuseIdentity(id: row.id, contentRevision: row.contentRevision)
        let reusable = previous.flatMap {
            $0.typography == typography && $0.sourceIdentity == identity && $0.sourceSessionID == row.sessionID ? $0 : nil
        }
        let processBlocks: [Layout.ProcessBlock] = reusable?.processBlocks ?? (row.nativeStyle == .process && row.isExpanded
            ? row.processSteps.map { step in
                let structured = step.tool != nil || step.changeSet != nil
                    ? ExecutionStructuredStepPresentation(step: step) : nil
                let detail = step.plan == nil && structured == nil ? ExecutionStepDetailPresentation(step: step) : nil
                return Layout.ProcessBlock(step: step,
                    attributedText: detail.map { NativeExecutionTimelineAttributedText.make(steps: [$0.displayedStep]) }
                        ?? NSAttributedString(string: ""), textHeight: 0,
                    hasOverflow: structured?.hasOverflow ?? detail?.hasOverflow ?? false)
            } : [])
        let candidates = reusable == nil && row.nativeStyle != .process && MacSharedMessageTextCard.supports(row) &&
            (row.nativeText.contains("|") || row.nativeText.contains("```corptie-chart"))
            ? ConversationChartBlockCache.shared.locatedBlocks(messageID: row.id, authoritativeText: row.nativeText) : []
        let hasRich = reusable.map { !$0.richBlocks.isEmpty } ?? candidates.contains { block in
            if case .markdown = block.content { return false }; return true
        }
        let rich: [Layout.RichBlock] = reusable.map { old in
            old.richBlocks.map { block in
                if case let .table(id, table, _) = block {
                    return .table(id: id, table, .measured(table, width: textWidth,
                        style: row.nativeStyle == .user ? .user : .agent, typography: typography))
                }
                return block
            }
        } ?? (hasRich ? candidates.enumerated().map { index, block in
            let boundary = MessageTextBoundary.fragment(index: index, count: candidates.count)
            switch block.content {
            case .markdown(let text):
                return .markdown(id: block.id, NativeMarkdownTextCache.shared.value(text: text,
                    style: row.nativeStyle, boundary: boundary, typography: typography), 0)
            case .invalidChart(let original, let reason):
                return .markdown(id: block.id, NativeMarkdownTextCache.shared.value(text: "> \(reason)\n\n\(original)",
                    style: row.nativeStyle, boundary: boundary, typography: typography), 0)
            case .chart(let spec, _): return .chart(id: block.id, spec, 0)
            case .table(let table): return .table(id: block.id, table,
                .measured(table, width: textWidth, style: row.nativeStyle == .user ? .user : .agent, typography: typography))
            }
        } : [])
        let text = reusable?.attributedText ?? (row.userInput != nil || row.executionPlan != nil || row.coordinationProgress != nil
            || !processBlocks.isEmpty || hasRich || (row.nativeStyle == .process && !row.isExpanded)
            ? NSAttributedString(string: "")
            : NativeMarkdownTextCache.shared.value(text: row.nativeText, style: row.nativeStyle, typography: typography))
        var content = Layout(typography: typography,
            imageLayout: MessageImageGalleryLayout.layout(geometries: row.imageGeometries, width: textWidth),
            attributedText: text, richBlocks: rich, processBlocks: processBlocks,
            cardWidth: cardWidth, textHeight: 0, rawStatusHeight: 0, rowHeight: 0)
        content.sourceIdentity = identity
        content.sourceSessionID = row.sessionID
        content.rawStatusText = reusable?.rawStatusText ?? (row.rawStatusText.isEmpty ? nil
            : NSAttributedString(string: row.rawStatusText, attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 9.5, weight: .regular),
                .foregroundColor: NSColor(calibratedRed: 0.38, green: 0.41, blue: 0.43, alpha: 1)]))
        if skin.showsTimelineTimeSeparators { content.timeSeparatorHeight = row.timeSeparatorHeight }
        if let trigger = row.scheduledTrigger {
            let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byCharWrapping
            let message = reusable?.triggerText ?? NSAttributedString(string: trigger.text, attributes: [
                .font: NSFont.systemFont(ofSize: 11, weight: .medium),
                .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph])
            content.triggerText = message
            // Overflow eligibility is a local preview policy, not a row-height
            // truth. The actual body and expanded text still size themselves.
            content.triggerCanExpand = NativeTextKitLayout.height(of: message, width: textWidth)
                > NativeTextKitLayout.height(of: message, width: textWidth, maximumLines: 3)
        }
        return content
    }

}
