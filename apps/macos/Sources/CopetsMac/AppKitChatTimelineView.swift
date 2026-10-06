import AppKit
import SwiftUI
import CorptieConversation
import CorptieClientCore

struct AppKitChatTimelineView: NSViewRepresentable {
    let sessionID: String
    let rows: [AppKitChatTimelineRow]
    let scrollToBottomRevision: Int
    var baseDirectory: String? = nil
    var canAdvanceProcessClock = false
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
    /// Scrollable space occupied by chrome above the native viewport.
    var topClearance: CGFloat = 0
    /// Extend the native scrollable document for chrome overlaid on this viewport.
    /// The full-height clip view lets earlier rows pass beneath the glass.
    var bottomClearance: CGFloat = 0

    nonisolated static func rowIndex(forTurnID turnID: String, in rows: [AppKitChatTimelineRow]) -> Int? {
        rows.firstIndex(where: {
            $0.id == turnID || $0.expandableTurnId == turnID || $0.id.contains(turnID)
        })
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            sessionID: sessionID,
            baseDirectory: baseDirectory,
            canAdvanceProcessClock: canAdvanceProcessClock,
            followsLatest: $followsLatest,
            onToggleExpansion: onToggleExpansion,
            onAction: onAction,
            onNearTop: onNearTop,
            hasMoreHistory: hasMoreHistory,
            onUnderfilledHistory: onUnderfilledHistory,
            onPositionChange: onPositionChange
        )
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
        // The parent owns the viewport, not the table's document/fitting size.
        // In the compact workspace a long row must wrap inside its card rather
        // than widen the NSViewRepresentable into the neighbouring Work grid.
        let width = proposal.width ?? 10
        let height = proposal.height ?? 10
        return CGSize(
            width: width.isFinite ? max(0, width) : 10,
            height: height.isFinite ? max(0, height) : 10
        )
    }

    func makeNSView(context: Context) -> NSScrollView {
        let tableView = Self.makeTableView()
        let scrollView = Self.makeScrollView(tableView: tableView)

        context.coordinator.attach(tableView: tableView, scrollView: scrollView)
        context.coordinator.setProcessClockEnabled(canAdvanceProcessClock)
        if let initialPosition, !initialPosition.followsLatest {
            context.coordinator.prepareInitialPosition(initialPosition)
        } else {
            context.coordinator.prepareInitialScrollToBottom()
        }
        context.coordinator.apply(rows: rows, animated: false)
        context.coordinator.setTopClearance(topClearance)
        context.coordinator.setBottomClearance(bottomClearance)
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
        tableView.intercellSpacing = NSSize(width: 0, height: 6)
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
        scrollView.automaticallyAdjustsContentInsets = false
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.verticalScroller = TimelineIntentScroller()
        scrollView.scrollerStyle = .overlay
        scrollView.contentView.drawsBackground = false
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.verticalScrollElasticity = .none
        scrollView.horizontalScrollElasticity = .none
        let documentView = TimelineScrollDocumentView()
        documentView.addSubview(tableView)
        scrollView.documentView = documentView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.switchSessionIfNeeded(
            to: sessionID,
            initialPosition: initialPosition
        )
        context.coordinator.updateBaseDirectory(baseDirectory)
        context.coordinator.updateProcessCollapseLocalization()
        context.coordinator.setProcessClockEnabled(canAdvanceProcessClock)
        context.coordinator.onToggleExpansion = onToggleExpansion
        context.coordinator.onAction = onAction
        context.coordinator.onNearTop = onNearTop
        context.coordinator.onUnderfilledHistory = onUnderfilledHistory
        context.coordinator.updateHistoryAvailability(hasMoreHistory)
        context.coordinator.onPositionChange = onPositionChange
        context.coordinator.apply(rows: rows, animated: context.transaction.animation != nil)
        // Decide whether to follow new rows against the previous stable
        // viewport before changing the document's chrome clearances.
        context.coordinator.setTopClearance(topClearance)
        context.coordinator.setBottomClearance(bottomClearance)
        if let initialPosition {
            context.coordinator.restoreIfNeeded(position: initialPosition)
        }
        if context.coordinator.lastScrollToBottomRevision != scrollToBottomRevision {
            context.coordinator.lastScrollToBottomRevision = scrollToBottomRevision
            context.coordinator.jumpToLatest()
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

    typealias Coordinator = AppKitChatTimelineCoordinator
}

/// The table owns only message rows. Its enclosing document owns scrollable
/// clearance under the overlaid header and composer.
private final class TimelineScrollDocumentView: NSView {
    override var isFlipped: Bool { true }
}
