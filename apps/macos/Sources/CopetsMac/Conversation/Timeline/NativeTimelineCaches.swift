import AppKit
import SwiftUI
import CorptieConversation
import CorptieClientCore

@MainActor
enum NativeMarkdownAttributedText {
    static func make(text: String, style: AppKitChatTimelineRow.NativeStyle) -> NSAttributedString {
        let sharedStyle: MessageMarkdown.Style = switch style {
        case .user: .user
        case .agent: .agent
        case .process: .process
        }
        return MessageMarkdown.make(text: text, style: sharedStyle)
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
            presentationText: item.presentationText, title: item.title, type: item.type)
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

/// Reuses TextKit's paragraph layout when a plan revision changes only a few
/// checklist lines. The resulting height still comes from the same layout
/// manager as the cold path; no estimated geometry reaches NSTableView.
@MainActor
final class NativeIncrementalPlanLayoutCache {
    private struct Key: Hashable {
        let rowID: String
        let widthBucket: Int
    }

    private final class Entry {
        var attributedText: NSAttributedString
        let storage: NSTextStorage
        let manager: NSLayoutManager
        let container: NSTextContainer
        var access: UInt64
        var estimatedBytes: Int

        init(attributedText: NSAttributedString, width: CGFloat, access: UInt64) {
            self.attributedText = attributedText
            storage = NSTextStorage(attributedString: attributedText)
            manager = NSLayoutManager()
            container = NSTextContainer(containerSize: NSSize(
                width: width, height: CGFloat.greatestFiniteMagnitude
            ))
            container.lineFragmentPadding = 0
            container.lineBreakMode = .byCharWrapping
            container.widthTracksTextView = false
            container.heightTracksTextView = false
            manager.addTextContainer(container)
            storage.addLayoutManager(manager)
            self.access = access
            estimatedBytes = attributedText.length * 32 + 512
        }
    }

    static let shared = NativeIncrementalPlanLayoutCache()
    private var entries: [Key: Entry] = [:]
    private var sequence: UInt64 = 0
    private var estimatedBytes = 0
    private let byteLimit = 8 * 1_024 * 1_024

    func height(of attributedText: NSAttributedString, rowID: String, width: CGFloat) -> CGFloat {
        let key = Key(rowID: rowID, widthBucket: Int((width * 2).rounded()))
        sequence &+= 1
        let entry: Entry
        if let existing = entries[key] {
            entry = existing
            if !entry.attributedText.isEqual(to: attributedText) {
                replaceChangedLines(in: entry, with: attributedText)
                estimatedBytes -= entry.estimatedBytes
                entry.attributedText = attributedText
                entry.estimatedBytes = attributedText.length * 32 + 512
                estimatedBytes += entry.estimatedBytes
            }
            entry.access = sequence
        } else {
            entry = Entry(attributedText: attributedText, width: width, access: sequence)
            entries[key] = entry
            estimatedBytes += entry.estimatedBytes
        }
        entry.manager.ensureLayout(for: entry.container)
        let height = ceil(entry.manager.usedRect(for: entry.container).height)
        while estimatedBytes > byteLimit || entries.count > 128,
              let oldest = entries.min(by: { $0.value.access < $1.value.access })?.key {
            if let removed = entries.removeValue(forKey: oldest) {
                estimatedBytes -= removed.estimatedBytes
            }
        }
        return height
    }

    private func replaceChangedLines(in entry: Entry, with next: NSAttributedString) {
        let oldRanges = Self.lineRanges(in: entry.attributedText.string as NSString)
        let newRanges = Self.lineRanges(in: next.string as NSString)
        guard oldRanges.count == newRanges.count else {
            entry.storage.setAttributedString(next)
            return
        }
        let changed = oldRanges.indices.filter { index in
            !entry.attributedText.attributedSubstring(from: oldRanges[index])
                .isEqual(to: next.attributedSubstring(from: newRanges[index]))
        }
        guard changed.count <= 16 else {
            entry.storage.setAttributedString(next)
            return
        }
        entry.storage.beginEditing()
        for index in changed.reversed() {
            entry.storage.replaceCharacters(
                in: oldRanges[index],
                with: next.attributedSubstring(from: newRanges[index])
            )
        }
        entry.storage.endEditing()
    }

    private static func lineRanges(in string: NSString) -> [NSRange] {
        var ranges: [NSRange] = []
        var offset = 0
        while offset < string.length {
            let range = string.lineRange(for: NSRange(location: offset, length: 0))
            ranges.append(range)
            offset = NSMaxRange(range)
        }
        return ranges
    }
}

/// SwiftUI owns the checklist geometry. Status-only revisions preserve the
/// same measured height, so their frequent updates do not remeasure text.
@MainActor
final class NativePlanChecklistHeightCache {
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
    private var sequence: UInt64 = 0
    private(set) var measurementCount = 0

    func height(of plan: ConversationExecutionPlan, width: CGFloat) -> CGFloat {
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
    private struct ChartHeightKey: Hashable {
        let kind: ConversationChartSpec.Kind
        let title: String
        let unit: String?
        let sourceNote: String?
        let width: CGFloat
    }

    struct Layout {
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
        let processLanguageCode: String?
        let processState: AppKitChatTimelineRow.ProcessState
        let processCurrentStepTitle: String?
        let processSteps: [NativeExecutionTimelineStep]
        let processPlan: ConversationExecutionPlan?
        let isExpanded: Bool
        let showsHeader: Bool
        let actionCount: Int
        let showsCollaborationSentStatus: Bool
        let showsMessageStatusBar: Bool
        let hasTimeSeparator: Bool
        let widthBucket: Int
        let isWorkspaceCard: Bool
        let imagePaths: [String]
        let userInput: ConversationUserInput?
        let userInputStatus: String?
        let executionPlan: ConversationExecutionPlan?

        var estimatedTextLength: Int {
            text.utf16.count + rawStatusText.utf16.count + processSteps.reduce(into: 0) { total, step in
                total += step.title.utf16.count + (step.detail?.utf16.count ?? 0) + 32
                if let plan = step.plan {
                    total += plan.explanation?.utf16.count ?? 0
                    for planStep in plan.steps { total += planStep.text.utf16.count + planStep.stepId.utf16.count }
                }
                if let tool = step.tool {
                    total += tool.name.utf16.count + (tool.input?.utf16.count ?? 0)
                        + (tool.result?.utf16.count ?? 0)
                }
                if let changeSet = step.changeSet {
                    for change in changeSet.changes {
                        total += change.path.utf16.count + (change.diffPreview?.utf16.count ?? 0)
                    }
                }
            }
        }
    }

    static let shared = NativeTimelineLayoutCache()
    private var values: [Key: Layout] = [:]
    private var accessByKey: [Key: UInt64] = [:]
    private var accessSequence: UInt64 = 0
    private var chartHeights: [ChartHeightKey: (height: CGFloat, access: UInt64)] = [:]
    private(set) var chartMeasurementCount = 0
    private var estimatedBytes = 0
    private let byteLimit = 64 * 1_024 * 1_024
    private let chartHeightLimit = 128

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
            processLanguageCode: row.processLanguageCode,
            processState: row.processState,
            processCurrentStepTitle: row.processCurrentStepTitle,
            processSteps: row.isExpanded ? row.processSteps : [],
            processPlan: row.processPlan,
            isExpanded: row.isExpanded,
            showsHeader: row.showsHeader,
            actionCount: row.actions.count,
            showsCollaborationSentStatus: row.showsCollaborationSentStatus,
            showsMessageStatusBar: row.showsMessageStatusBar,
            hasTimeSeparator: row.timeSeparatorText != nil,
            widthBucket: Int((normalizedWidth * 2).rounded()),
            isWorkspaceCard: row.isWorkspaceCard,
            imagePaths: row.images.map { $0.managedPath },
            userInput: row.userInput,
            userInputStatus: row.userInputStatus,
            executionPlan: row.executionPlan
        )
        if let cached = values[key] {
            touch(key)
            return cached
        }

        if let request = row.userInput {
            let cardWidth = min(560, max(120, normalizedWidth - 8))
            let layout = Layout(attributedText: NSAttributedString(string: ""), richBlocks: [],
                processBlocks: [], cardWidth: cardWidth, textHeight: 0, rawStatusHeight: 0,
                rowHeight: userInputHeight(request, status: row.userInputStatus, cardWidth: cardWidth)
                    + row.timeSeparatorHeight)
            values[key] = layout
            touch(key)
            estimatedBytes += 512 + request.questions.reduce(0) { $0 + $1.question.utf16.count * 8 }
            evictIfNeeded()
            return layout
        }

        if let plan = row.executionPlan {
            let cardWidth = min(560, max(120, normalizedWidth - 8))
            let measured = NativePlanChecklistHeightCache.shared.height(of: plan, width: cardWidth - 28)
            let height = min(300, measured) + 28
            let layout = Layout(attributedText: NSAttributedString(string: ""), richBlocks: [],
                processBlocks: [], cardWidth: cardWidth, textHeight: 0, rawStatusHeight: 0,
                rowHeight: height + row.timeSeparatorHeight)
            values[key] = layout
            touch(key)
            estimatedBytes += 512 + plan.steps.reduce(0) { $0 + $1.text.utf16.count * 8 }
            evictIfNeeded()
            return layout
        }

        let chartCandidates = row.nativeStyle != .process && MacSharedMessageTextCard.supports(row)
            && (row.nativeText.contains("|") || row.nativeText.contains("```corptie-chart"))
            ? ConversationChartBlockCache.shared.locatedBlocks(
                messageID: row.id, authoritativeText: row.nativeText) : []
        let hasRichBlock = chartCandidates.contains { block in
            switch block.content {
            case .chart, .invalidChart, .table: true
            case .markdown: false
            }
        }
        let cardWidth = ChatBubbleWidthPolicy.cardWidth(for: row, availableWidth: normalizedWidth)
        let textWidth = max(20, cardWidth - ChatBubbleWidthPolicy.horizontalPadding)
        let processBlocks: [Layout.ProcessBlock] = row.nativeStyle == .process && row.isExpanded
            ? row.processSteps.map { step in
                let structured = step.tool != nil || step.changeSet != nil
                    ? ExecutionStructuredStepPresentation(step: step) : nil
                let presentation = step.plan == nil && structured == nil
                    ? ExecutionStepDetailPresentation(step: step) : nil
                let value = step.plan == nil && structured == nil
                    ? NativeExecutionTimelineAttributedText.make(steps: [presentation!.displayedStep])
                    : NSAttributedString(string: "")
                let blockWidth = max(20, textWidth - 16)
                let height: CGFloat
                if let plan = step.plan {
                    let measured = NativePlanChecklistHeightCache.shared.height(of: plan, width: blockWidth)
                    height = min(300, measured)
                } else if let structured {
                    height = structured.height
                } else {
                    height = NativeTextKitLayout.height(of: value, width: blockWidth)
                }
                return Layout.ProcessBlock(step: step, attributedText: value,
                    textHeight: height, hasOverflow: structured?.hasOverflow ?? presentation?.hasOverflow ?? false)
            } : []
        let attributed = !processBlocks.isEmpty || hasRichBlock ? NSAttributedString(string: "")
            : NativeMarkdownTextCache.shared.value(text: row.nativeText, style: row.nativeStyle)
        let richBlocks: [Layout.RichBlock] = hasRichBlock ? chartCandidates.map { block in
            switch block.content {
            case .markdown(let text):
                let value = NativeMarkdownTextCache.shared.value(text: text, style: row.nativeStyle)
                return .markdown(id: block.id, value, NativeTextKitLayout.height(of: value, width: textWidth))
            case .chart(let spec, _):
                return .chart(id: block.id, spec, chartHeight(spec, width: textWidth))
            case .table(let table):
                return .table(id: block.id, table,
                    .measured(table, width: textWidth, style: row.nativeStyle == .user ? .user : .agent))
            case .invalidChart(let original, let reason):
                let value = NativeMarkdownTextCache.shared.value(
                    text: "> \(reason)\n\n\(original)", style: row.nativeStyle)
                return .markdown(id: block.id, value, NativeTextKitLayout.height(of: value, width: textWidth))
            }
        } : []
        let textHeight: CGFloat
        if row.nativeStyle == .process && !row.isExpanded {
            textHeight = 0
        } else if hasRichBlock {
            textHeight = richBlocks.reduce(0) { height, block in
                switch block {
                case .markdown(_, _, let blockHeight): height + blockHeight
                case .chart(_, _, let chartHeight): height + chartHeight
                case .table(_, _, let layout): height + layout.height
                }
            }
        } else if !processBlocks.isEmpty {
            textHeight = processBlocks.reduce(0) { $0 + $1.height }
                + CGFloat(max(0, processBlocks.count - 1)) * 6
        } else {
            textHeight = NativeTextKitLayout.height(of: attributed, width: textWidth)
        }
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
        let processSummaryExtraHeight: CGFloat = row.nativeStyle == .process
            ? Self.processSummaryExtraHeight(for: row, cardWidth: cardWidth,
                includesCurrentStep: !MacSharedMessageTextCard.supportsProcess(row)) : 0
        if row.nativeStyle == .process && !row.isExpanded {
            rowHeight = (row.processCurrentStepTitle == nil ? 32 : 48) + processSummaryExtraHeight
        } else {
            // This exactly matches the native cell's 10pt leading/trailing
            // constraints and the NativeTimelineTextView's TextKit container.
            if row.nativeStyle == .process {
                rowHeight = max(54, textHeight + 48 + processSummaryExtraHeight
                    + (row.processCurrentStepTitle == nil ? 0 : 16)
                    + (rawStatusHeight > 0 ? rawStatusHeight + 8 : 0))
            } else {
                let footerHeight: CGFloat = row.processCount == nil ? 0 : 24
                let actionHeight: CGFloat = row.actions.isEmpty ? 0 : 34
                let sentStatusHeight: CGFloat = row.showsCollaborationSentStatus ? 30 : 0
                let messageStatusBarHeight: CGFloat = 0 // Shared and native cards use a non-layout glow.
                // Replaces the ordinary 6pt title-to-body gap with
                // 8pt + 92pt summary + 10pt, for a net 104pt addition.
                let collaborationRouteHeight: CGFloat = row.collaborationRoute == nil ? 0 : 104
                let verticalChrome: CGFloat = (row.showsHeader ? 39 : 20) + collaborationRouteHeight
                rowHeight = max(
                    row.showsHeader ? 54 : 30,
                    textHeight + verticalChrome + footerHeight + actionHeight + sentStatusHeight + messageStatusBarHeight
                ) + (row.images.isEmpty ? 0 : MessageImageGalleryLayout.height(count: row.images.count, width: textWidth) + 8) + row.timeSeparatorHeight
            }
        }
        let layout = Layout(
            attributedText: attributed,
            richBlocks: richBlocks,
            processBlocks: processBlocks,
            cardWidth: cardWidth,
            textHeight: textHeight,
            rawStatusHeight: rawStatusHeight,
            rowHeight: rowHeight
        )
        values[key] = layout
        touch(key)
        estimatedBytes += (key.estimatedTextLength * 8) + attributed.length * 8
            + processBlocks.reduce(0) { $0 + $1.attributedText.length * 8 } + 192
        evictIfNeeded()
        return layout
    }

    static func processSummaryExtraHeight(for row: AppKitChatTimelineRow,
                                          cardWidth: CGFloat,
                                          includesCurrentStep: Bool = false) -> CGFloat {
        // Collapsed headers truncate on one line and never need wrapping height.
        guard row.isExpanded else { return 0 }
        let progressWidth = row.processPlanProgressLabel.map {
            ceil(($0 as NSString).size(withAttributes: [
                .font: NSFont.systemFont(ofSize: 9, weight: .semibold)
            ]).width)
        } ?? 0
        // ProcessCard keeps the icon, progress label and chevron on the same
        // HStack; only the summary wraps inside the remaining native row width.
        let summaryWidth = max(20, cardWidth - 76 - progressWidth)
        let font = NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .medium)
        let summary = includesCurrentStep ? row.processSummary : row.processPrimarySummary
        let measuredHeight = ceil((summary as NSString).boundingRect(
            with: NSSize(width: summaryWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font]
        ).height) + 2
        return max(0, measuredHeight - 22)
    }

    private func userInputHeight(_ request: ConversationUserInput, status: String?, cardWidth: CGFloat) -> CGFloat {
        let contentWidth = max(80, cardWidth - 28)
        func textHeight(_ text: String, size: CGFloat, width: CGFloat) -> CGFloat {
            let font = NSFont.systemFont(ofSize: size)
            return max(ceil(font.boundingRectForFont.height), ceil((text as NSString).boundingRect(
                with: NSSize(width: max(40, width), height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: [.font: font]
            ).height))
        }
        var height: CGFloat = 28 + 26 + 12
        if request.url != nil { height += 28 }
        for question in request.questions {
            if !question.header.isEmpty { height += 18 + 8 }
            height += textHeight(question.question, size: 13, width: contentWidth) + 8
            if question.required == false { height += 18 + 8 }
            for option in question.options ?? [] {
                let label = textHeight(option.label, size: 13, width: contentWidth - 42)
                let description = option.description.isEmpty ? 0
                    : textHeight(option.description, size: 11, width: contentWidth - 42) + 2
                height += max(38, label + description + 16) + 8
            }
            if question.options == nil || question.isOther {
                let entered = status == "submitted"
                    ? ConversationInputAnswerPresentation.textAnswers(
                        for: question, submittedAnswers: request.submittedAnswers)
                    : []
                height += max(42, entered.reduce(0) {
                    $0 + textHeight($1, size: 13, width: contentWidth) + 8
                })
            }
            height += 16
        }
        if status == "pending" {
            let direct = ConversationUserInputInteractionPolicy.directSelectionQuestionID(request) != nil
            if !direct { height += 38 }
            if request.canCancel == true { height += 32 }
        } else {
            height += 20
        }
        return max(72, height + 8)
    }

    private func chartHeight(_ spec: ConversationChartSpec, width: CGFloat) -> CGFloat {
        // Measure the actual SwiftUI chrome without constructing a Charts plot.
        // A completed chart remains identical while trailing text streams, so
        // cache its height separately from the whole-message layout.
        // The plot and data-table regions have the same fixed height. Data
        // values affect drawing, not the title/note chrome that is measured.
        let key = ChartHeightKey(kind: spec.kind, title: spec.title, unit: spec.unit,
                                 sourceNote: spec.sourceNote, width: width)
        accessSequence &+= 1
        if var cached = chartHeights[key] {
            cached.access = accessSequence
            chartHeights[key] = cached
            return cached.height
        }
        let height = ConversationChartView.measuredHeight(spec: spec, width: width)
        chartMeasurementCount += 1
        chartHeights[key] = (height, accessSequence)
        if chartHeights.count > chartHeightLimit,
           let oldest = chartHeights.min(by: { $0.value.access < $1.value.access })?.key {
            chartHeights.removeValue(forKey: oldest)
        }
        return height
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
                    - (oldest.estimatedTextLength * 8)
                    - removed.attributedText.length * 8
                    - removed.processBlocks.reduce(0) { $0 + $1.attributedText.length * 8 }
                    - 192
            )
        }
    }
}
