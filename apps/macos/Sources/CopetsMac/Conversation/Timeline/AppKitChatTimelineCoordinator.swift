import AppKit
import SwiftUI
import CorptieConversation
import CorptieClientCore

@MainActor
final class AppKitChatTimelineCoordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    static let columnIdentifier = NSUserInterfaceItemIdentifier("chat.timeline.column")
    private static let nativeCellIdentifier = NSUserInterfaceItemIdentifier("chat.timeline.native.cell")
    private static let sharedTextCellIdentifier = NSUserInterfaceItemIdentifier("chat.timeline.shared-text.cell")
    private var skin = ConversationSkin.classic
    private let useSharedTextCards: Bool
    private let useSharedProcessCards: Bool

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
    private weak var processCollapseButton: NSButton?
    private var visibleProcessCollapseRowID: String?
    private var pendingProcessCollapseRowID: String?
    private var hasExpandedProcessRows = false
    private var rows: [AppKitChatTimelineRow] = []
    private var presentationActive = true
    private var lastAppliedContentRevision: UInt64?
    private var lastAppliedContentSessionID: String?
    private var canAdvanceProcessClock: Bool
    private var processClockTimer: Timer?
    private var activeProcessClockRowIndex: Int?
    private var revisionsByID: [String: Int] = [:]
    private var heightCache: [HeightCacheKey: CGFloat] = [:]
    private var pendingImageGeometryRows = Set<String>()
    private var imageGeometryCommitScheduled = false
    private var cellsByKey: [CellCacheKey: NSTableCellView & AppKitChatRowRendering] = [:]
    private var cellRecency: [CellCacheKey] = []
    private var lastMeasuredWidth: CGFloat = 0
    private var scrollCommandGeneration = 0
    private var nearTopSuppressionGeneration = 0
    private var suppressesNearTopTrigger = false
    var lastScrollToBottomRevision = Int.min
    var lastScrollToTurnRevision = Int.min
    var lastHistoryRequestEpoch = Int.min
    private enum ViewportMode { case followingLatest, readingHistory }
    private var viewportMode: ViewportMode = .followingLatest
    var followsLatest: Bool {
        get { viewportMode == .followingLatest }
        set { viewportMode = newValue ? .followingLatest : .readingHistory }
    }
    private enum Correction {
        case bottom
        case anchor(id: String, offset: CGFloat)
    }
    private var pendingCorrection: Correction?
    private var correctionScheduled = false
    private var applyingCorrection = false
    private var diagnosticEvents: [String] = []

    private func traceViewport(_ event: String) {
        #if DEBUG
        let entry = "\(ProcessInfo.processInfo.systemUptime) \(event) mode=\(viewportMode) epoch=\(scrollCommandGeneration) rows=\(rows.count)"
        if diagnosticEvents.count == 128 { diagnosticEvents.removeFirst() }
        diagnosticEvents.append(entry)
        #endif
    }
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
    private var topClearance: CGFloat = 0
    private var bottomClearance: CGFloat = 0

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
        let imageGeometries: [MessageImageGeometry?]
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
        canAdvanceProcessClock: Bool = false,
        followsLatest: Binding<Bool>,
        useSharedTextCards: Bool = true,
        useSharedProcessCards: Bool = true,
        onToggleExpansion: @escaping (String) -> Void,
        onAction: @escaping (AppKitChatTimelineRow.Action) -> Void = { _ in },
        onNearTop: @escaping () -> Void = {},
        hasMoreHistory: Bool = false,
        onUnderfilledHistory: @escaping () -> Void = {},
        onPositionChange: @escaping (AppKitChatTimelinePosition) -> Void = { _ in }
    ) {
        self.representedSessionID = sessionID
        self.baseDirectory = Self.normalizedBaseDirectory(baseDirectory)
        self.canAdvanceProcessClock = canAdvanceProcessClock
        self.followsLatestBinding = followsLatest
        self.useSharedTextCards = useSharedTextCards
        self.useSharedProcessCards = useSharedProcessCards
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
        initialPosition: AppKitChatTimelinePosition?,
        deferReloadUntilRowsArrive: Bool = false
    ) {
        guard representedSessionID != sessionID else { return }
        let trace = SessionSwitchTrace.shared.start(.sessionRebind, sessionID: sessionID)
        defer { SessionSwitchTrace.shared.finish(trace) }
        publishPositionImmediately()
        positionPublishCorptieTask?.cancel()
        positionPublishCorptieTask = nil
        scrollCommandGeneration &+= 1
        pendingCorrection = nil
        nearTopSuppressionGeneration &+= 1
        suppressesNearTopTrigger = false
        representedSessionID = sessionID
        pendingSearchRowID = nil
        lastSearchRevision = -1
        if searchHighlightActive {
            tableView?.selectionHighlightStyle = .none
            searchHighlightActive = false
        }
        rows.removeAll(keepingCapacity: true)
        pendingImageGeometryRows.removeAll(keepingCapacity: true)
        hasExpandedProcessRows = false
        visibleProcessCollapseRowID = nil
        pendingProcessCollapseRowID = nil
        processCollapseButton?.isHidden = true
        synchronizeProcessClock()
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
        // updateNSView installs target rows synchronously in apply. Avoid
        // an empty reload that tears down cells before their replacement is ready.
        if !deferReloadUntilRowsArrive { tableView?.reloadData() }
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
        guard lastRequestedRestorePosition == nil else { return }
        restore(position: position)
    }

    isolated deinit {
        processClockTimer?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    /// Called by the native page switcher before changing visibility. Pausing
    /// is constant work: no row scan, diff, or SwiftUI publication.
    func setPresentationActive(_ active: Bool) {
        guard presentationActive != active else { return }
        presentationActive = active
        if !active { processClockTimer?.invalidate(); processClockTimer = nil }
        else { synchronizeProcessClock(); scheduleImageGeometryCommit(); scheduleUnderfilledHistoryEvaluation() }
    }

    func setProcessClockEnabled(_ enabled: Bool) {
        guard canAdvanceProcessClock != enabled else { return }
        canAdvanceProcessClock = enabled
        synchronizeProcessClock()
    }

    private func synchronizeProcessClock() {
        activeProcessClockRowIndex = rows.lastIndex(where: {
            $0.nativeStyle == .process && $0.processState == .running && $0.processStartedAt != nil
        })
        let shouldTick = presentationActive && canAdvanceProcessClock && activeProcessClockRowIndex != nil
        guard shouldTick else {
            processClockTimer?.invalidate()
            processClockTimer = nil
            return
        }
        guard processClockTimer == nil else { return }
        let timer = Timer(timeInterval: ConversationProcessPresentation.elapsedRefreshInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshVisibleProcessElapsed() }
        }
        RunLoop.main.add(timer, forMode: .common)
        processClockTimer = timer
    }

    var isProcessClockScheduled: Bool { processClockTimer != nil }

    private func refreshVisibleProcessElapsed(now: Date = Date()) {
        guard presentationActive, canAdvanceProcessClock, let tableView,
              tableView.window != nil, !tableView.isHiddenOrHasHiddenAncestor else { return }
        let visible = tableView.rows(in: tableView.visibleRect)
        guard visible.location != NSNotFound, let index = activeProcessClockRowIndex,
              rows.indices.contains(index), NSLocationInRange(index, visible) else { return }
        (tableView.view(atColumn: 0, row: index, makeIfNecessary: false)
            as? AppKitChatRowRendering)?.refreshProcessElapsed(now: now)
    }

    func attach(tableView: NSTableView, scrollView: NSScrollView) {
        self.tableView = tableView
        self.scrollView = scrollView
        let collapseButton = NSButton(title: L10n("Collapse"), target: self,
                                      action: #selector(collapseVisibleProcess))
        collapseButton.image = NSImage(systemSymbolName: "chevron.up", accessibilityDescription: nil)
        collapseButton.imagePosition = .imageLeading
        collapseButton.bezelStyle = .rounded
        collapseButton.controlSize = .small
        collapseButton.font = .systemFont(ofSize: 11, weight: .semibold)
        collapseButton.frame.size = NSSize(width: 80, height: 32)
        collapseButton.identifier = NSUserInterfaceItemIdentifier("chat.timeline.process-follow-collapse")
        collapseButton.setAccessibilityLabel(L10n("Collapse") + " · " + L10n("Execution process"))
        collapseButton.isHidden = true
        scrollView.addSubview(collapseButton, positioned: .above, relativeTo: scrollView.contentView)
        processCollapseButton = collapseButton
        if let firstLayoutScrollView = scrollView as? FirstLayoutRestoringScrollView {
            firstLayoutScrollView.onLayout = { [weak self] in
                self?.restoreInitialViewportSynchronouslyIfNeeded()
                self?.reconcileLayout()
                if let self {
                    SessionSwitchTrace.shared.mark(.viewportLayout, sessionID: self.representedSessionID)
                }
            }
            firstLayoutScrollView.onUserScrollWillBegin = { [weak self] in
                self?.userScrollEventWillBegin()
            }
            firstLayoutScrollView.onUserScrollDidEnd = { [weak self] in
                self?.userScrollEventDidEnd()
            }
            if let scroller = scrollView.verticalScroller as? TimelineIntentScroller {
                scroller.onBegin = firstLayoutScrollView.onUserScrollWillBegin
                scroller.onEnd = firstLayoutScrollView.onUserScrollDidEnd
            }
        }
        tableView.dataSource = self
        tableView.delegate = self
        NotificationCenter.default.addObserver(self, selector: #selector(messageSubmissionAccepted(_:)), name: .sessionTimelineSubmissionAccepted, object: nil)
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
            selector: #selector(windowDidEndLiveResize(_:)),
            name: ConsoleNativeSplitView.didEndDividerTracking,
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
        lastAppliedContentRevision = nil
        baseDirectory = normalized
        // Cached cells retain their owning Session's link context. Updating
        // another Session's host here defeats warm reuse and rewrites its links.
        // A returning cell is reconciled by tableView(_:viewFor:row:).
        for (key, cell) in cellsByKey where key.sessionID == representedSessionID {
            cell.updateLinkContext(baseDirectory: normalized)
        }
    }

    func updateProcessCollapseLocalization() {
        guard let button = processCollapseButton else { return }
        let title = L10n("Collapse")
        guard button.title != title else { return }
        button.title = title
        button.setAccessibilityLabel(title + " · " + L10n("Execution process"))
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
        let isLiveResize = ConsoleNativeSplitView.isResizing(tableView)
        let measurementWidth = LiveResizeWidthPolicy.measurementWidth(
            columnWidth,
            isLiveResize: isLiveResize
        )
        let key = HeightCacheKey(
            sessionID: representedSessionID,
            id: item.id,
            revision: item.contentRevision,
            widthBucket: Int((measurementWidth * 2).rounded()),
            isLiveResizeApproximation: isLiveResize,
            imageGeometries: item.imageGeometries
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


    private func usesSharedCard(_ row: AppKitChatTimelineRow) -> Bool {
        (row.userInput != nil || row.executionPlan != nil || (row.nativeStyle == .process ? useSharedProcessCards : useSharedTextCards))
            && MacSharedMessageTextCard.supports(row)
    }

    /// A skin changes paint only: retain row heights, selection, editor and viewport.
    func updateSkin(_ next: ConversationSkin) {
        guard skin != next else { return }
        skin = next
        guard let tableView, let scrollView else { return }
        let visible = tableView.rows(in: scrollView.contentView.bounds)
        guard visible.location != NSNotFound, visible.length > 0 else { return }
        for row in visible.location..<NSMaxRange(visible) {
            (tableView.view(atColumn: 0, row: row, makeIfNecessary: false) as? AppKitChatRowRendering)?
                .updateAppearance(skin: next)
        }
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
        let usesSharedText = usesSharedCard(rowModel)
        if let cachedCell = cellsByKey[cacheKey],
           (cachedCell is AppKitSharedMessageTextCell) == usesSharedText {
            SessionSwitchTrace.shared.recordCell(.hit, sessionID: representedSessionID, rowID: rowModel.id)
            configureImageGeometryCallback(cachedCell, row: rowModel)
            touchCell(cacheKey)
            cachedCell.updateCallbacks(
                onToggleExpansion: onToggleExpansion,
                onAction: onAction
            )
            cachedCell.updateLinkContext(baseDirectory: baseDirectory)
            if !cachedCell.updateLayoutIfContentUnchanged(
                rowModel,
                availableWidth: availableWidth
            ) {
                SessionSwitchTrace.shared.recordCell(.hitReconfigured, sessionID: representedSessionID, rowID: rowModel.id)
                ChatPerformanceRecorder.shared.increment(.appKitRowsConfigured)
                cachedCell.setContent(rowModel, availableWidth: availableWidth,
                    baseDirectory: baseDirectory, onToggleExpansion: onToggleExpansion,
                    onAction: onAction)
                cacheCell(cachedCell, for: rowModel)
            }
            cachedCell.updateAppearance(skin: skin)
            return cachedCell
        }
        SessionSwitchTrace.shared.recordCell(.miss, sessionID: representedSessionID, rowID: rowModel.id)
        let identifier = usesSharedText ? Self.sharedTextCellIdentifier : Self.nativeCellIdentifier
        let cell: NSTableCellView & AppKitChatRowRendering =
            (tableView.makeView(withIdentifier: identifier, owner: nil) as? (NSTableCellView & AppKitChatRowRendering)) ?? {
                ChatPerformanceRecorder.shared.increment(.appKitCellsCreated)
                if usesSharedText { return AppKitSharedMessageTextCell(identifier: identifier) }
                return AppKitChatNativeTextCell(identifier: identifier)
            }()
        ChatPerformanceRecorder.shared.increment(.appKitRowsConfigured)
        configureImageGeometryCallback(cell, row: rowModel)
        cell.updateAppearance(skin: skin)
        cell.setContent(
            rowModel,
            availableWidth: availableWidth,
            baseDirectory: baseDirectory,
            onToggleExpansion: onToggleExpansion,
            onAction: onAction
        )
        cacheCell(cell, for: rowModel)
        return cell
    }

    private func configureImageGeometryCallback(_ cell: NSTableCellView, row: AppKitChatTimelineRow) {
        let sessionID = representedSessionID
        let changed = { [weak self] in
            guard let self, self.representedSessionID == sessionID else { return }
            self.pendingImageGeometryRows.insert(row.id)
            self.scheduleImageGeometryCommit()
        }
        (cell as? AppKitChatNativeTextCell)?.onImageGeometryChanged = changed
        (cell as? AppKitSharedMessageTextCell)?.onImageGeometryChanged = changed
    }

    private func scheduleImageGeometryCommit() {
        guard presentationActive, !imageGeometryCommitScheduled, !pendingImageGeometryRows.isEmpty else { return }
        imageGeometryCommitScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.imageGeometryCommitScheduled = false
            self.commitImageGeometry()
        }
    }

    private func commitImageGeometry() {
        guard presentationActive, !isProcessingUserScrollEvent, let tableView, !pendingImageGeometryRows.isEmpty else { return }
        let ids = pendingImageGeometryRows
        pendingImageGeometryRows.removeAll(keepingCapacity: true)
        let changed = IndexSet(rows.indices.filter { ids.contains(rows[$0].id) })
        guard !changed.isEmpty else { return }
        let anchor = followsLatest ? nil : visibleAnchor(in: tableView)
        heightCache = heightCache.filter { !ids.contains($0.key.id) }
        let width = tableView.tableColumns.first?.width ?? tableView.bounds.width
        for index in changed {
            if let cell = tableView.view(atColumn: 0, row: index, makeIfNecessary: false) as? (NSTableCellView & AppKitChatRowRendering) {
                cell.setContent(rows[index], availableWidth: width, baseDirectory: baseDirectory,
                    onToggleExpansion: onToggleExpansion, onAction: onAction)
            }
        }
        tableView.noteHeightOfRows(withIndexesChanged: changed)
        synchronizeDocumentHeight(in: tableView)
        if followsLatest { enqueueCorrection(.bottom) }
        else if let anchor { restore(anchor: anchor, in: tableView) }
    }

    /// A mutable cell may only be indexed by the revision it currently renders.
    /// In-place expansion and width-reflow repairs must obey the same rule as reuse.
    private func cacheCell(_ cell: NSTableCellView & AppKitChatRowRendering,
                           for row: AppKitChatTimelineRow) {
        let key = CellCacheKey(sessionID: representedSessionID, rowID: row.id,
                               revision: row.contentRevision)
        cellsByKey = cellsByKey.filter {
            let sameCell = $0.value === cell
            let sameRow = $0.key.sessionID == key.sessionID && $0.key.rowID == key.rowID
            if sameCell && $0.key.sessionID != key.sessionID {
                SessionSwitchTrace.shared.recordCell(.crossSessionRebind, sessionID: key.sessionID, rowID: key.rowID)
            }
            if sameRow && $0.key.revision != key.revision {
                SessionSwitchTrace.shared.recordCell(.revisionReplaced, sessionID: key.sessionID, rowID: key.rowID)
            }
            return !sameCell && !sameRow
        }
        cellRecency.removeAll { cellsByKey[$0] == nil }
        cellsByKey[key] = cell
        touchCell(key)
        while cellRecency.count > 96, let oldest = cellRecency.first {
            cellRecency.removeFirst()
            SessionSwitchTrace.shared.recordCell(.capacityEvicted, sessionID: oldest.sessionID, rowID: oldest.rowID)
            cellsByKey[oldest] = nil
        }
    }

    private func touchCell(_ key: CellCacheKey) {
        cellRecency.removeAll { $0 == key }
        cellRecency.append(key)
    }

    func apply(rows nextRows: [AppKitChatTimelineRow], contentRevision: UInt64? = nil, animated: Bool = false) {
        if let contentRevision, lastAppliedContentRevision == contentRevision,
           lastAppliedContentSessionID == representedSessionID { return }
        lastAppliedContentRevision = contentRevision
        lastAppliedContentSessionID = representedSessionID
        let trace = SessionSwitchTrace.shared.start(.timelineApply, sessionID: representedSessionID)
        defer { SessionSwitchTrace.shared.finish(trace) }
        let nextRows = ConversationTimeSeparatorPolicy.applying(to: Self.uniquedRows(nextRows))
        hasExpandedProcessRows = nextRows.contains { $0.nativeStyle == .process && $0.isExpanded }
        defer { synchronizeProcessClock(); updateProcessCollapseButton() }
        suppressNearTopDuringLayout()
        guard let tableView else {
            rows = nextRows
            revisionsByID = Dictionary(uniqueKeysWithValues: nextRows.map { ($0.id, $0.contentRevision) })
            return
        }
        if isAwaitingSessionRows {
            // Install the data source before any width or viewport work can
            // query it. The table may still contain the previous Session's rows.
            isAwaitingSessionRows = false
            rows = nextRows
            revisionsByID = Dictionary(uniqueKeysWithValues: nextRows.map { ($0.id, $0.contentRevision) })
            tableView.reloadData()
            synchronizeTableWidth()
            synchronizeDocumentHeight(in: tableView)
            restoreInitialViewportSynchronouslyIfNeeded()
            schedulePendingInitialViewportRestoreIfNeeded()
            return
        }
        let oldIDs = rows.map(\.id)
        let newIDs = nextRows.map(\.id)
        let oldRevisions = revisionsByID
        let oldReplyIdentities = rows.map(\.replyIdentity)
        let replyIdentityChanged = rows.first(where: { $0.replyIdentity != nil })?.replyIdentity
            != nextRows.first(where: { $0.replyIdentity != nil })?.replyIdentity
        // Preserve reader intent across the entire mutation, including
        // geometry feedback before a coalesced correction has committed.
        let followedLatestBeforeUpdate = followsLatest
        // Physical viewport geometry is authoritative over the semantic
        // `followsLatest` flag, which lags behind the reader's actual
        // position (SwiftUI binding publication is a frame behind AppKit
        // scroll geometry). A stale `true` at the top/middle must not
        // yank the reader to the bottom, and a stale `false` at the
        // physical bottom must not strand a completed reply below the
        // visible document. Only an empty projection has no geometry to
        // consult, so it falls back to the semantic flag.
        let shouldFollowAfterUpdate = pendingProcessCollapseRowID == nil && (rows.isEmpty
            ? followedLatestBeforeUpdate
            : isViewportNearBottom())
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
        let prependAnchor = !shouldFollowAfterUpdate && !hasPendingInitialViewport
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


        guard oldIDs == newIDs else {
            applyStructuralDifference(
                from: oldIDs,
                to: newIDs,
                oldRevisions: oldRevisions,
                replyIdentityChanged: replyIdentityChanged,
                in: tableView
            )
            synchronizeDocumentHeight(in: tableView)
            if let rowID = pendingProcessCollapseRowID {
                pendingProcessCollapseRowID = nil
                scrollToProcessRow(rowID)
            } else if shouldFollowAfterUpdate, !pendingInitialScrollToBottom {
                scrollToBottom()
            } else if let returningFromEmptyProjection {
                deferredEmptyProjectionViewport = nil
                if returningFromEmptyProjection.followsLatest {
                    scrollToBottom()
                } else if let anchor = returningFromEmptyProjection.anchor,
                          restoreClosestAvailableAnchor(
                              anchor,
                              previousIDs: returningFromEmptyProjection.previousIDs,
                              in: tableView,
                              synchronously: true
                          ) {
                    // The semantic row returned; its relative offset is
                    // restored before another wheel event can observe
                    // uncompensated structural geometry.
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
                    in: tableView,
                    synchronously: true
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
                || oldReplyIdentities[index] != nextRows[index].replyIdentity
        })
        guard !changed.isEmpty else { return }
        heightCache = heightCache.filter { key, _ in
            key.sessionID != representedSessionID
                || !changed.contains { index in nextRows[index].id == key.id }
        }
        for row in changed {
            let currentCell = tableView.view(atColumn: 0, row: row, makeIfNecessary: false)
            if let nativeCell = currentCell as? (NSTableCellView & AppKitChatRowRendering) {
                if (nativeCell is AppKitSharedMessageTextCell) != usesSharedCard(nextRows[row]) {
                    tableView.reloadData(forRowIndexes: IndexSet(integer: row), columnIndexes: IndexSet(integer: 0))
                    continue
                }
                nativeCell.setContent(
                    nextRows[row],
                    availableWidth: tableView.tableColumns.first?.width ?? tableView.bounds.width,
                    baseDirectory: baseDirectory,
                    onToggleExpansion: onToggleExpansion,
                    onAction: onAction
                )
                cacheCell(nativeCell, for: nextRows[row])
            }
        }
        tableView.noteHeightOfRows(withIndexesChanged: changed)
        synchronizeDocumentHeight(in: tableView)
        if let rowID = pendingProcessCollapseRowID {
            pendingProcessCollapseRowID = nil
            scrollToProcessRow(rowID)
        } else if shouldFollowAfterUpdate,
           !pendingInitialScrollToBottom {
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
        replyIdentityChanged: Bool,
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
                && (oldRevisions[newIDs[index]] != rows[index].contentRevision
                    || (replyIdentityChanged && rows[index].replyIdentity != nil))
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
        let rowsHeight = (rows.isEmpty
            ? 0
            : tableView.rect(ofRow: rows.count - 1).maxY)
        // Keep chrome clearance in the scrollable document, outside the table.
        // The table's origin is the readable top boundary at scroll position 0.
        if abs(tableView.frame.minY - topClearance) >= 0.5
            || abs(tableView.frame.height - rowsHeight) >= 0.5 {
            tableView.frame = NSRect(
                x: 0,
                y: topClearance,
                width: tableView.frame.width,
                height: rowsHeight
            )
        }
        let documentHeight = topClearance + rowsHeight + bottomClearance
        if let documentView = scrollView?.documentView {
            let documentSize = NSSize(
                width: max(tableView.frame.width, scrollView?.contentView.bounds.width ?? 0),
                height: documentHeight
            )
            if abs(documentView.frame.width - documentSize.width) >= 0.5
                || abs(documentView.frame.height - documentSize.height) >= 0.5 {
                documentView.setFrameSize(documentSize)
            }
        }
        scheduleUnderfilledHistoryEvaluation()
    }

    func setTopClearance(_ value: CGFloat) {
        let next = max(0, value.isFinite ? value : 0)
        guard abs(topClearance - next) >= 0.5 else { return }
        let anchor = !followsLatest && !isProcessingUserScrollEvent
            ? tableView.flatMap { visibleAnchor(in: $0) }
            : nil
        topClearance = next
        guard let tableView else { return }
        synchronizeDocumentHeight(in: tableView)
        if followsLatest {
            enqueueCorrection(.bottom)
        } else if let anchor {
            enqueueCorrection(.anchor(id: anchor.id, offset: anchor.offset))
        }
    }

    func setBottomClearance(_ value: CGFloat) {
        let next = max(0, value.isFinite ? value : 0)
        guard abs(bottomClearance - next) >= 0.5 else { return }
        let anchor = !followsLatest && !isProcessingUserScrollEvent
            ? tableView.flatMap { visibleAnchor(in: $0) }
            : nil
        bottomClearance = next
        guard let tableView else { return }
        synchronizeDocumentHeight(in: tableView)
        if followsLatest {
            enqueueCorrection(.bottom)
        } else if let anchor {
            enqueueCorrection(.anchor(id: anchor.id, offset: anchor.offset))
        }
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
                  self.presentationActive, self.underfilledHistoryEvaluationGeneration == generation,
                  self.hasMoreHistory,
                  self.underfilledHistoryRequestCount < 4,
                  let tableView = self.tableView,
                  let clipView = self.scrollView?.contentView,
                  !self.rows.isEmpty,
                  clipView.bounds.height > 1 else { return }
            let contentHeight = tableView.rect(ofRow: self.rows.count - 1).maxY
            let readableHeight = max(0, clipView.bounds.height - self.topClearance - self.bottomClearance)
            guard contentHeight <= readableHeight + 0.5 else { return }
            let signature = "\(self.representedSessionID)|\(self.rows.map(\.id).joined(separator: ","))"
            guard signature != self.lastUnderfilledHistoryRequestSignature else { return }
            self.lastUnderfilledHistoryRequestSignature = signature
            self.underfilledHistoryRequestCount += 1
            self.onUnderfilledHistory()
        }
    }

    func scrollToBottom() {
        guard !isProcessingUserScrollEvent,
              tableView != nil else { return }
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
        enqueueCorrection(.bottom)
    }

    func jumpToLatest() {
        claimViewportIntent()
        scrollToBottom()
    }

    private func claimViewportIntent() {
        traceViewport("cancel-pending=\(pendingCorrection != nil)")
        scrollCommandGeneration &+= 1
        pendingCorrection = nil
        userOwnsViewport = true
        SessionViewportController.shared.discardPendingHydration(for: representedSessionID)
        traceViewport("user-intent")
    }

    @objc private func messageSubmissionAccepted(_ notification: Notification) {
        guard notification.object as? String == representedSessionID else { return }
        claimViewportIntent()
        if followsLatest {
            pendingRestorePosition = nil
            scrollToBottom()
        }
        traceViewport("send-accepted")
    }

    /// A single coalesced effect consumes the latest data, never a captured
    /// row index. Data updates refine the target; only user/session intent
    /// cancels it. Layout notifications cannot change the semantic mode.
    private func enqueueCorrection(_ correction: Correction) {
        guard !isProcessingUserScrollEvent else { return }
        if case .anchor = correction,
           case let .anchor(id, _)? = pendingCorrection,
           rows.contains(where: { $0.id == id }) {
            // Keep the pre-mutation anchor through consecutive updates.
        } else {
            pendingCorrection = correction
        }
        guard !correctionScheduled else { return }
        correctionScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.correctionScheduled = false
            self.commitCorrection()
        }
    }

    private func commitCorrection(allowDuringUserScroll: Bool = false) {
        guard !applyingCorrection, (!isProcessingUserScrollEvent || allowDuringUserScroll),
              let correction = pendingCorrection,
              let tableView, let clip = scrollView?.contentView,
              !rows.isEmpty, clip.bounds.height > 0 else { return }
        pendingCorrection = nil
        applyingCorrection = true
        defer { applyingCorrection = false }
        tableView.layoutSubtreeIfNeeded()
        synchronizeDocumentHeight(in: tableView)
        let maximumY = max(0, (scrollView?.documentView?.frame.height ?? 0) - clip.bounds.height)
        let y: CGFloat
        switch correction {
        case .bottom:
            guard followsLatest else { return }
            y = maximumY
        case let .anchor(id, offset):
            guard !followsLatest, let index = rows.firstIndex(where: { $0.id == id }) else { return }
            y = min(maximumY, max(0, tableView.rect(ofRow: index).minY + offset))
        }
        clip.scroll(to: NSPoint(x: 0, y: y))
        scrollView?.reflectScrolledClipView(clip)
        let anchor = visibleAnchor(in: tableView)
        traceViewport("commit y=\(y) anchor=\(anchor?.id ?? "none")")
        schedulePositionPublish()
    }

    private func reconcileLayout() {
        guard !applyingCorrection, !isRestoringInitialViewport,
              !isProcessingUserScrollEvent,
              pendingRestorePosition == nil, !pendingInitialScrollToBottom else { return }
        if followsLatest, !isViewportNearBottom() {
            enqueueCorrection(.bottom)
        } else if let pendingCorrection {
            enqueueCorrection(pendingCorrection)
        }
    }

    private func isViewportNearBottom() -> Bool {
        guard let scrollView, let tableView, !rows.isEmpty else {
            return followsLatest
        }
        let visibleMaxY = scrollView.contentView.bounds.maxY
        let contentMaxY = scrollView.documentView?.frame.height ?? tableView.frame.height
        return contentMaxY - visibleMaxY <= 8
    }

    func viewportDidScroll(userInitiated: Bool? = nil) {
        guard let scrollView, !rows.isEmpty else { return }
        let acceptsHistoryRequest = userInitiated
            ?? isProcessingUserScrollEvent
        // Geometry feedback never changes intent, even if it arrives
        // several run-loop turns after the mutation that caused it.
        guard acceptsHistoryRequest else { return }
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
        if presentationActive && nearTop && acceptsHistoryRequest
            && !nearTopTriggered && !suppressesNearTopTrigger {
            nearTopTriggered = true
            onNearTop()
        } else if !nearTop {
            nearTopTriggered = false
        }
        schedulePositionPublish()
    }

    @objc private func viewportBoundsDidChange(_ notification: Notification) {
        updateProcessCollapseButton()
        viewportDidScroll()
    }

    @objc private func collapseVisibleProcess() {
        guard let rowID = visibleProcessCollapseRowID,
              let turnID = rows.first(where: { $0.id == rowID })?.expandableTurnId else { return }
        // The click is explicit reader intent. The row-height update must land
        // on this compact card, not restore an offset inside its removed body.
        claimViewportIntent()
        followsLatest = false
        if followsLatestBinding.wrappedValue { followsLatestBinding.wrappedValue = false }
        pendingProcessCollapseRowID = rowID
        processCollapseButton?.isHidden = true
        onToggleExpansion(turnID)
    }

    private func updateProcessCollapseButton() {
        guard hasExpandedProcessRows,
              let tableView, let scrollView, let button = processCollapseButton,
              let column = tableView.tableColumns.first, !rows.isEmpty else {
            processCollapseButton?.isHidden = true
            visibleProcessCollapseRowID = nil
            return
        }
        let clip = scrollView.contentView
        let visible = tableView.convert(clip.bounds, from: clip)
        let readable = NSRect(x: visible.minX, y: visible.minY + topClearance,
                              width: visible.width,
                              height: max(0, visible.height - topClearance - bottomClearance))
        let range = tableView.rows(in: readable)
        guard range.location != NSNotFound else {
            button.isHidden = true
            visibleProcessCollapseRowID = nil
            return
        }
        let cardWidth = MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 0, expanded: true, laneWidth: column.width)
        let candidates: [ProcessCollapseCandidate] = (range.location..<min(rows.count, range.location + range.length))
            .compactMap { index in
                let row = rows[index]
                guard row.nativeStyle == .process, row.isExpanded,
                      row.expandableTurnId != nil else { return nil }
                let rowRect = tableView.rect(ofRow: index)
                return ProcessCollapseCandidate(id: row.id,
                    frame: CGRect(x: rowRect.minX + 2,
                                  y: rowRect.minY + row.timeSeparatorHeight + row.replyIdentityHeight,
                                  width: cardWidth,
                                  height: max(0, rowRect.height - row.timeSeparatorHeight - row.replyIdentityHeight)),
                    headerHeight: row.processCurrentStepTitle == nil ? 32 : 48)
            }
        guard let placement = ProcessCollapsePlacementPolicy.placement(
            candidates: candidates, viewport: readable,
            handleSize: button.frame.size) else {
            button.isHidden = true
            visibleProcessCollapseRowID = nil
            return
        }
        visibleProcessCollapseRowID = placement.id
        let buttonRect = NSRect(origin: placement.origin, size: button.frame.size)
        let converted = tableView.convert(buttonRect, to: scrollView)
        if button.frame != converted { button.frame = converted }
        button.isHidden = false
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
        claimViewportIntent()
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
        scheduleImageGeometryCommit()
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
        updateProcessCollapseButton()
        reconcileLayout()
        scheduleUnderfilledHistoryEvaluation()
    }

    @objc private func capturePositionForTermination(_ notification: Notification) {
        publishPositionImmediately()
        #if DEBUG
        NSLog("[TimelineViewport %@] %@", representedSessionID, diagnosticEvents.joined(separator: "\n"))
        #endif
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
        if let documentView = scrollView.documentView {
            documentView.setFrameSize(NSSize(
                width: scrollView.contentView.bounds.width,
                height: documentView.frame.height
            ))
        }
        // This path now runs only for an actual container resize. Scroller
        // visibility no longer changes the layout width.
        lastMeasuredWidth = width
        if !rows.isEmpty {
            let visible = tableView.rows(in: tableView.visibleRect)
            let isLiveResize = ConsoleNativeSplitView.isResizing(scrollView)
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
                    ) as? (NSTableCellView & AppKitChatRowRendering) {
                        if !nativeCell.updateLayoutIfContentUnchanged(
                            rows[row],
                            availableWidth: measurementWidth
                        ) {
                            nativeCell.setContent(
                                rows[row],
                                availableWidth: measurementWidth,
                                baseDirectory: baseDirectory,
                                onToggleExpansion: onToggleExpansion,
                                onAction: onAction
                            )
                            cacheCell(nativeCell, for: rows[row])
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
                if followsLatest { enqueueCorrection(.bottom) }
                else if let anchor { _ = restore(anchor: anchor, in: tableView) }
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
                ) as? (NSTableCellView & AppKitChatRowRendering) {
                    if !nativeCell.updateLayoutIfContentUnchanged(
                        rows[row],
                        availableWidth: exactWidth
                    ) {
                        nativeCell.setContent(
                            rows[row],
                            availableWidth: exactWidth,
                            baseDirectory: baseDirectory,
                            onToggleExpansion: onToggleExpansion,
                            onAction: onAction
                        )
                        cacheCell(nativeCell, for: rows[row])
                    }
                }
            }
        }
        lastReflowMeasurementWidth = exactWidth
        tableView.noteHeightOfRows(
            withIndexesChanged: IndexSet(integersIn: 0..<rows.count)
        )
        synchronizeDocumentHeight(in: tableView)
        if followsLatest { enqueueCorrection(.bottom) }
        else if let anchor { _ = restore(anchor: anchor, in: tableView) }
    }

    private func visibleAnchor(in tableView: NSTableView) -> (id: String, offset: CGFloat)? {
        guard let clipView = scrollView?.contentView, !rows.isEmpty else { return nil }
        // The table begins after topClearance. The readable viewport also
        // begins after topClearance, so the two offsets cancel in table space.
        // Do not anchor to a row hidden behind the floating header.
        let readableY = max(0, clipView.bounds.minY)
        let row = tableView.row(at: NSPoint(x: 1, y: readableY))
        guard rows.indices.contains(row) else { return nil }
        let offset = readableY - tableView.rect(ofRow: row).minY
        return (rows[row].id, offset)
    }

    @discardableResult
    private func restore(anchor: (id: String, offset: CGFloat), in tableView: NSTableView,
                         synchronously: Bool = false) -> Bool {
        guard (synchronously || !isProcessingUserScrollEvent),
              (synchronously || !followsLatest),
              rows.contains(where: { $0.id == anchor.id }) else { return false }
        suppressNearTopDuringLayout()
        if synchronously {
            // Structural insertion is coordinate compensation, not a new
            // navigation command. Finish it in this transaction, including
            // during scrollbar tracking, before the next user delta. Keep
            // ordinary reflows and explicit navigation cancellable as before.
            followsLatest = false
            pendingCorrection = .anchor(id: anchor.id, offset: anchor.offset)
            commitCorrection(allowDuringUserScroll: true)
            return true
        }
        enqueueCorrection(.anchor(id: anchor.id, offset: anchor.offset))
        return true
    }

    func restore(position: AppKitChatTimelinePosition) {
        guard !isProcessingUserScrollEvent else { return }
        prepareInitialPosition(position)
        schedulePendingInitialViewportRestoreIfNeeded()
    }

    private var searchHighlightActive = false
    private var lastSearchRevision = -1
    private var pendingSearchRowID: String?
    func applySearchTarget(rowID: String?, revision: Int) {
        if lastSearchRevision != revision {
            lastSearchRevision = revision
            pendingSearchRowID = rowID
        }
        guard let id = pendingSearchRowID,
              let row = rows.firstIndex(where: { $0.id == id }), let tableView else { return }
        pendingSearchRowID = nil
        scrollToRow(row)
        // Native selection provides a short focus cue without a new row layer.
        searchHighlightActive = true
        tableView.selectionHighlightStyle = .regular
        tableView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        let sessionID = representedSessionID
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self, weak tableView] in
            guard let self, self.representedSessionID == sessionID, self.lastSearchRevision == revision else { return }
            self.searchHighlightActive = false
            tableView?.deselectAll(nil)
            tableView?.selectionHighlightStyle = .none
        }
    }

    func scrollToTurn(_ turnID: String) {
        guard let row = AppKitChatTimelineView.rowIndex(forTurnID: turnID, in: rows) else { return }
        scrollToRow(row)
    }

    private func scrollToProcessRow(_ rowID: String) {
        guard let row = rows.firstIndex(where: { $0.id == rowID }) else { return }
        scrollToRow(row)
    }

    private func scrollToRow(_ row: Int) {
        guard !isProcessingUserScrollEvent,
              let tableView,
              let clipView = scrollView?.contentView else { return }
        claimViewportIntent()
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
        in tableView: NSTableView,
        synchronously: Bool = false
    ) -> Bool {
        if restore(anchor: anchor, in: tableView, synchronously: synchronously) { return true }
        guard let removedIndex = previousIDs.firstIndex(of: anchor.id) else { return false }
        let successor = previousIDs.dropFirst(removedIndex + 1).first(where: { candidate in
            rows.contains(where: { $0.id == candidate })
        })
        if let successor {
            return restore(anchor: (successor, anchor.offset), in: tableView, synchronously: synchronously)
        }
        let predecessor = previousIDs[..<removedIndex].reversed().first(where: { candidate in
            rows.contains(where: { $0.id == candidate })
        })
        guard let predecessor else { return false }
        return restore(anchor: (predecessor, anchor.offset), in: tableView, synchronously: synchronously)
    }

    func prepareInitialPosition(_ position: AppKitChatTimelinePosition) {
        lastRequestedRestorePosition = position
        pendingRestorePosition = position
        pendingInitialScrollToBottom = false
        followsLatest = position.followsLatest
        // Called from make/updateNSView. Publish only after viewport restoration,
        // outside SwiftUI's view-update transaction.
    }

    func prepareInitialScrollToBottom() {
        lastRequestedRestorePosition = nil
        pendingRestorePosition = nil
        pendingInitialScrollToBottom = true
        followsLatest = true
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
        let maximumY = max(0, (scrollView?.documentView?.frame.height ?? 0) - clipView.bounds.height)
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
            }
        } else if pendingInitialScrollToBottom {
            clipView.scroll(to: NSPoint(x: 0, y: maximumY))
        }
        scrollView?.reflectScrolledClipView(clipView)
        pendingRestorePosition = nil
        pendingInitialScrollToBottom = false
        traceViewport("initial-restoration-complete")
        schedulePositionPublish()
    }

    private func schedulePositionPublish() {
        positionPublishCorptieTask?.cancel()
        let sessionID = representedSessionID
        let task = DispatchWorkItem { [weak self] in
            guard let self, self.representedSessionID == sessionID,
                  let tableView = self.tableView,
                  let anchor = self.visibleAnchor(in: tableView) else { return }
            if self.followsLatestBinding.wrappedValue != self.followsLatest {
                self.followsLatestBinding.wrappedValue = self.followsLatest
            }
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
        commitCorrection()
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
