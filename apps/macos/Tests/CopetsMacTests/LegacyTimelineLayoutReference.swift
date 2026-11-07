import AppKit
import SwiftUI
import CorptieClientCore
import CorptieConversation
@testable import CorptieMac

// Frozen pre-migration estimator for historical rendering comparisons only.
// New correctness gates assert real NSTableView/NSHostingView geometry instead.
@MainActor
final class LegacyTimelineLayoutReference {
    private struct ChartHeightKey: Hashable {
        let kind: ConversationChartSpec.Kind
        let title: String
        let unit: String?
        let sourceNote: String?
        let width: CGFloat
    }

    typealias Layout = NativeTimelineLayoutCache.Layout

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
        let hasScheduledSource: Bool
        let widthBucket: Int
        let isWorkspaceCard: Bool
        let imagePaths: [String]
        let imageGeometries: [MessageImageGeometry?]
        let userInput: ConversationUserInput?
        let userInputStatus: String?
        let executionPlan: ConversationExecutionPlan?
        let taskChecklistID: String?
        let taskChecklistRevision: Int?
        let scheduledTriggerText: String?
        let scheduledTriggerExpanded: Bool

        var estimatedTextLength: Int {
            text.utf16.count + rawStatusText.utf16.count + (scheduledTriggerText?.utf16.count ?? 0) + processSteps.reduce(into: 0) { total, step in
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

    static let shared = LegacyTimelineLayoutReference()
    private var values: [Key: Layout] = [:]
    private var accessByKey: [Key: UInt64] = [:]
    private var accessSequence: UInt64 = 0
    private var chartHeights: [ChartHeightKey: (height: CGFloat, access: UInt64)] = [:]
    private(set) var chartMeasurementCount = 0
    private var estimatedBytes = 0
    private let byteLimit = 64 * 1_024 * 1_024
    private let chartHeightLimit = 128

    func layout(for row: AppKitChatTimelineRow, columnWidth: CGFloat, typography requested: ConversationTypography = .classic,
                skin: ConversationSkin = .classic) -> Layout {
        var row = row
        if !skin.showsTimelineTimeSeparators { row.timeSeparatorText = nil }
        let contentWidth = columnWidth - ReplyLeadingLayout.additionalCardInset(for: row, skin: skin)
        var layout = contentLayout(for: row, columnWidth: contentWidth, typography: requested)
        layout.timeSeparatorHeight = row.timeSeparatorHeight
        layout.rowHeight += row.replyIdentityHeight + row.replyActionsHeight
        if !row.rawStatusText.isEmpty {
            layout.rawStatusText = NSAttributedString(string: row.rawStatusText, attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 9.5, weight: .regular),
                .foregroundColor: NSColor(calibratedRed: 0.38, green: 0.41, blue: 0.43, alpha: 1)])
        }
        return layout
    }

    private func contentLayout(for row: AppKitChatTimelineRow, columnWidth: CGFloat, typography requested: ConversationTypography) -> Layout {
        let typography = row.readingTypography(requested)
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
            hasScheduledSource: row.scheduledMessageSource != nil,
            widthBucket: row.executionPlan?.taskId != nil
                ? Int((normalizedWidth * 2).rounded(.down)) : Int((normalizedWidth * 2).rounded()),
            isWorkspaceCard: row.isWorkspaceCard,
            imagePaths: row.images.map { $0.managedPath },
            imageGeometries: row.imageGeometries,
            userInput: row.userInput,
            userInputStatus: row.userInputStatus,
            executionPlan: row.executionPlan?.taskId == nil ? row.executionPlan : nil,
            taskChecklistID: row.executionPlan?.taskId == nil ? nil : row.executionPlan?.planId,
            taskChecklistRevision: row.executionPlan?.taskId == nil ? nil : row.executionPlan?.revision,
            scheduledTriggerText: row.scheduledTrigger?.text,
            scheduledTriggerExpanded: row.scheduledTrigger?.isExpanded ?? false
        )
        if let cached = values[key], cached.typography == typography {
            touch(key)
            return cached
        }
        if let old = values[key] { estimatedBytes -= layoutCost(key, old) }

        if let request = row.userInput {
            let cardWidth = min(ChatBubbleWidthPolicy.functionalCardMaximumWidth, max(120, normalizedWidth - 8))
            let height = userInputHeight(request, status: row.userInputStatus, cardWidth: cardWidth)
            let layout = Layout(attributedText: NSAttributedString(string: ""), richBlocks: [],
                processBlocks: [], cardWidth: cardWidth, textHeight: 0, rawStatusHeight: 0,
                rowHeight: height + 2 * typography.rowInset + row.timeSeparatorHeight,
                cardHeight: height)
            values[key] = layout
            touch(key)
            estimatedBytes += 512 + request.questions.reduce(0) { $0 + $1.question.utf16.count * 8 }
            evictIfNeeded()
            return layout
        }

        if let plan = row.executionPlan {
            let cardWidth = plan.taskId != nil
                ? min(780, max(120, normalizedWidth - 14))
                : min(ChatBubbleWidthPolicy.functionalCardMaximumWidth, max(120, normalizedWidth - 8))
            let measured = NativePlanChecklistHeightCache.shared.height(of: plan, width: cardWidth - 28, expanded: row.isExpanded)
            let height = (plan.taskId != nil ? measured : min(300, measured)) + 28
            let layout = Layout(attributedText: NSAttributedString(string: ""), richBlocks: [],
                processBlocks: [], cardWidth: cardWidth, textHeight: 0, rawStatusHeight: 0,
                rowHeight: height + row.timeSeparatorHeight
                    + (plan.taskId != nil ? 2 * typography.rowInset : 0),
                cardHeight: height)
            values[key] = layout
            touch(key)
            estimatedBytes += plan.taskId != nil ? 512 : 512 + plan.steps.reduce(0) { $0 + $1.text.utf16.count * 8 }
            evictIfNeeded()
            return layout
        }

        if let trigger = row.scheduledTrigger {
            let cardWidth = ChatBubbleWidthPolicy.cardWidth(for: row, availableWidth: normalizedWidth)
            let width = max(20, cardWidth - 20)
            let details = NativeMarkdownTextCache.shared.value(text: row.nativeText, style: .agent, typography: .classic)
            let detailsHeight = NativeTextKitLayout.height(of: details, width: width)
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byCharWrapping
            let message = NSAttributedString(string: trigger.text, attributes: [
                .font: NSFont.systemFont(ofSize: 11, weight: .medium),
                .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph])
            let previewHeight = NativeTextKitLayout.height(of: message, width: width, maximumLines: 3)
            let fullHeight = NativeTextKitLayout.height(of: message, width: width)
            let canExpand = fullHeight > previewHeight
            let messageHeight = trigger.isExpanded ? fullHeight : previewHeight
            let contentHeight: CGFloat = 16 + (detailsHeight > 0 ? 8 + detailsHeight : 0)
                + (trigger.text.isEmpty ? 0 : 8 + 14 + 8 + messageHeight + (canExpand ? 8 + 20 : 0))
            let cardHeight = contentHeight + 20
            var layout = Layout(attributedText: details, richBlocks: [], processBlocks: [],
                cardWidth: cardWidth, textHeight: detailsHeight, rawStatusHeight: 0,
                rowHeight: cardHeight + row.timeSeparatorHeight + 2, cardHeight: cardHeight)
            layout.triggerText = message
            layout.triggerTextHeight = messageHeight
            layout.triggerCanExpand = canExpand
            values[key] = layout
            touch(key)
            estimatedBytes += layoutCost(key, layout)
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
        let cardWidth = ChatBubbleWidthPolicy.cardWidth(for: row, availableWidth: normalizedWidth, typography: typography)
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
            : NativeMarkdownTextCache.shared.value(text: row.nativeText, style: row.nativeStyle, typography: typography)
        let richBlocks: [Layout.RichBlock] = hasRichBlock ? chartCandidates.enumerated().map { index, block in
            let boundary = MessageTextBoundary.fragment(index: index, count: chartCandidates.count)
            switch block.content {
            case .markdown(let text):
                let value = NativeMarkdownTextCache.shared.value(text: text, style: row.nativeStyle, boundary: boundary, typography: typography)
                return .markdown(id: block.id, value, NativeTextKitLayout.height(of: value, width: textWidth))
            case .chart(let spec, _):
                return .chart(id: block.id, spec, chartHeight(spec, width: textWidth))
            case .table(let table):
                return .table(id: block.id, table,
                    .measured(table, width: textWidth, style: row.nativeStyle == .user ? .user : .agent, typography: typography))
            case .invalidChart(let original, let reason):
                let value = NativeMarkdownTextCache.shared.value(
                    text: "> \(reason)\n\n\(original)", style: row.nativeStyle, boundary: boundary, typography: typography)
                return .markdown(id: block.id, value, NativeTextKitLayout.height(of: value, width: textWidth))
            }
        } : []
        let textHeight: CGFloat
        if row.coordinationProgress != nil {
            textHeight = 0
        } else if row.nativeStyle == .process && !row.isExpanded {
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
        } else if !row.images.isEmpty && row.nativeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            textHeight = 0
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
        let imageLayout = MessageImageGalleryLayout.layout(geometries: row.imageGeometries, width: textWidth)
        let rowHeight: CGFloat
        let cardHeight: CGFloat
        let processSummaryExtraHeight: CGFloat = row.nativeStyle == .process
            ? Self.processSummaryExtraHeight(for: row, cardWidth: cardWidth,
                includesCurrentStep: !MacSharedMessageTextCard.supportsProcess(row)) : 0
        if let progress = row.coordinationProgress {
            cardHeight = CGFloat(54 + min(3, progress.items.count) * 30) // Legacy estimate; production uses the fitted SwiftUI card.
            rowHeight = MessageCardMetrics.rowHeight(cardHeight: cardHeight, separatorHeight: row.timeSeparatorHeight, typography: typography)
        } else if row.nativeStyle == .process && !row.isExpanded {
            rowHeight = (row.processCurrentStepTitle == nil ? 32 : 48) + processSummaryExtraHeight
            cardHeight = rowHeight - 2
        } else {
            // This exactly matches the native cell's 10pt leading/trailing
            // constraints and the NativeTimelineTextView's TextKit container.
            if row.nativeStyle == .process {
                rowHeight = max(54, textHeight + 48 + processSummaryExtraHeight
                    + (row.processCurrentStepTitle == nil ? 0 : 16)
                    + (rawStatusHeight > 0 ? rawStatusHeight + 8 : 0))
                cardHeight = rowHeight - 2
            } else if MacSharedMessageTextCard.supports(row) {
                let sourceHeight: CGFloat = row.scheduledMessageSource == nil ? 0 : 19
                let imageHeight = row.images.isEmpty ? 0 : imageLayout.size.height
                let imageSpacing: CGFloat = imageHeight > 0 && textHeight > 0 ? MessageCardMetrics.contentSpacing : 0
                let actionHeight: CGFloat = row.actions.isEmpty ? 0 : 34
                cardHeight = MessageCardMetrics.cardHeight(contentHeight:
                    sourceHeight + textHeight + imageHeight + imageSpacing + actionHeight)
                rowHeight = MessageCardMetrics.rowHeight(cardHeight: cardHeight, separatorHeight: row.timeSeparatorHeight, typography: typography)
            } else {
                let footerHeight: CGFloat = row.processCount == nil ? 0 : 24
                let actionHeight: CGFloat = row.actions.isEmpty ? 0 : 34
                let sentStatusHeight: CGFloat = row.showsCollaborationSentStatus ? 30 : 0
                let messageStatusBarHeight: CGFloat = 0 // Shared and native cards use a non-layout glow.
                // Replaces the ordinary 6pt title-to-body gap with
                // 8pt + 92pt summary + 10pt, for a net 104pt addition.
                let collaborationRouteHeight: CGFloat = row.collaborationRoute == nil ? 0 : 104
                let verticalChrome: CGFloat = (row.showsHeader ? 42 : 20) + collaborationRouteHeight
                cardHeight = max(
                    row.showsHeader ? 57 : (row.images.isEmpty ? 30 : 20),
                    textHeight + verticalChrome + footerHeight + actionHeight + sentStatusHeight + messageStatusBarHeight
                ) + (row.images.isEmpty ? 0 : imageLayout.size.height + (textHeight > 0 ? MessageCardMetrics.contentSpacing : 0))
                rowHeight = MessageCardMetrics.rowHeight(cardHeight: cardHeight, separatorHeight: row.timeSeparatorHeight, typography: typography)
            }
        }
        let visibleCardHeight = row.nativeStyle == .user && MacSharedMessageTextCard.supports(row)
            ? min(cardHeight, MessageCardMetrics.maximumUserCardHeight) : cardHeight
        var layout = Layout(
            attributedText: attributed,
            richBlocks: richBlocks,
            processBlocks: processBlocks,
            cardWidth: cardWidth,
            textHeight: textHeight,
            rawStatusHeight: rawStatusHeight,
            rowHeight: rowHeight - cardHeight + visibleCardHeight,
            cardHeight: visibleCardHeight
        )
        layout.typography = typography
        layout.scrollsUserContent = visibleCardHeight < cardHeight
        layout.imageLayout = imageLayout
        values[key] = layout
        touch(key)
        estimatedBytes += layoutCost(key, layout)
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
                .font: NSFont.systemFont(ofSize: 12, weight: .semibold)
            ]).width)
        } ?? 0
        // ProcessCard keeps the icon, progress label and chevron on the same
        // HStack; only the summary wraps inside the remaining native row width.
        let summaryWidth = max(20, cardWidth - 76 - progressWidth)
        let font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        let summary = includesCurrentStep ? row.processSummary : row.processPrimarySummary
        let measuredHeight = ceil((summary as NSString).boundingRect(
            with: NSSize(width: summaryWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font]
        ).height) + 2
        return max(0, measuredHeight - 22)
    }

    private func userInputHeight(_ request: ConversationUserInput, status: String?, cardWidth: CGFloat) -> CGFloat {
        // Use the same form, width and padding as the rendered card. The enclosing
        // layout cache already keys request, status and width, so this host exists
        // only on cache misses and is not retained with the conversation.
        let host = NSHostingView(rootView: ConversationInlineUserInput(request: request, status: status,
            respond: { _, _ in })
            .padding(14)
            .frame(width: cardWidth, alignment: .topLeading)
            .environment(\.conversationSkin, .classic))
        host.frame = NSRect(x: 0, y: 0, width: cardWidth, height: 1)
        host.layoutSubtreeIfNeeded()
        return ceil(host.fittingSize.height)
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

    private func layoutCost(_ key: Key, _ value: Layout) -> Int {
        key.estimatedTextLength * 8 + value.attributedText.length * 8
            + (value.triggerText?.length ?? 0) * 8
            + value.processBlocks.reduce(0) { $0 + $1.attributedText.length * 8 } + 192
    }

    private func evictIfNeeded() {
        while estimatedBytes > byteLimit,
              let oldest = accessByKey.min(by: { $0.value < $1.value })?.key {
            accessByKey[oldest] = nil
            guard let removed = values.removeValue(forKey: oldest) else { continue }
            estimatedBytes = max(0, estimatedBytes - layoutCost(oldest, removed))
        }
    }
}

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
