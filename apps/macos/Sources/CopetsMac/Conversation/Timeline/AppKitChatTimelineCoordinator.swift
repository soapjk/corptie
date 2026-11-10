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
    private var needsTypographyReflow = false
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
    private weak var processCollapseHost: NSView?
    private var visibleProcessCollapseRowID: String?
    private var pendingProcessCollapseRowID: String?
    private var hasExpandedProcessRows = false
    private var rowIndexesByID: [String: Int] = [:]
    private var processGroupEndIndexes: [String: Int] = [:]
    private var rows: [AppKitChatTimelineRow] = [] {
        didSet {
            rowIndexesByID = Dictionary(rows.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first })
            processGroupEndIndexes = [:]
            for (index, row) in rows.enumerated() {
                if let parent = row.processParentID { processGroupEndIndexes[parent] = index }
            }
        }
    }
    private var presentationActive = true
    private var needsPresentationLayout = false
    private var lastAppliedContentRevision: UInt64?
    private var lastAppliedContentSessionID: String?
    private var canAdvanceProcessClock: Bool
    /// The live elapsed clock is a chain of one-shot ticks, not a retained
    /// repeating Timer. Stopping only bumps the generation; a tick already
    /// queued in the RunLoop sees the stale generation and expires on its own.
    private(set) var isProcessClockScheduled = false
    private var processClockGeneration: UInt64 = 0
    private var activeProcessClockRowIndex: Int?
    private var revisionsByID: [String: Int] = [:]
    private var pendingImageGeometryRows = Set<String>()
    private var imageGeometryCommitScheduled = false
    private var cellsByKey: [CellCacheKey: NSTableCellView & AppKitChatRowRendering] = [:]
    private var cellRecency: [CellCacheKey] = []
    /// A flat 96-cell bound multiplied by every resident page used to keep
    /// hundreds of offscreen NSHostingView trees (and their constraints, KVO
    /// dependencies and AttributeGraph subgraphs) reachable at a high-water
    /// plateau. Warm reuse only needs the rows around the visible viewport.
    private static let cellCacheCapacity = 32
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
    private var isProvidingCell = false
    private var isSynchronizingDocumentExtent = false
    private var isReloadingSDKRowData = false
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
    #if DEBUG
    private(set) var resizeLayoutCommitCount = 0
    private(set) var sdkRowResetCount = 0
    private(set) var documentHeightSyncCount = 0
    #endif
    private var lastReflowMeasurementWidth: CGFloat?
    private var topClearance: CGFloat = 0
    private var bottomClearance: CGFloat = 0
    private var reservesVerticalScrollerGutter = true
    /// Opt-in: only the wide, standard conversation page spreads the scroll
    /// view across the detail column and pins its table to the reading lane.
    /// Detached/compact hosts keep the historical full-width table.
    private var centersReadingLane = false

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
    /// callback and row model change; native content views stay cached while
    /// Session-specific revisions and SDK virtual row data are replaced.
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
        processStepVersions.removeAll()
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
        processClockGeneration &+= 1
        isProcessClockScheduled = false
        NotificationCenter.default.removeObserver(self)
    }

    /// Called by the native page switcher before changing visibility. Pausing
    /// is constant work: no row scan, diff, or SwiftUI publication.
    func setPresentationActive(_ active: Bool) {
        guard presentationActive != active else { return }
        presentationActive = active
        if !active {
            needsPresentationLayout = true
            stopProcessClock()
            releaseDetachedCells()
        }
        else {
            if needsPresentationLayout {
                needsPresentationLayout = false
                synchronizeTableWidth()
                reconcileLayout()
                positionProcessCollapseButton()
            }
            if needsTypographyReflow { reflowForTypography() }
            synchronizeProcessClock(); scheduleImageGeometryCommit(); scheduleUnderfilledHistoryEvaluation()
        }
    }

    /// Hidden resident pages keep their semantic rows but must not retain an
    /// offscreen SwiftUI hosting tree per cached cell. Cells still mounted in
    /// a live window are visible rows AppKit owns; leaving them intact keeps
    /// switching back instant.
    func releaseDetachedCells() {
        let detachedKeys = cellsByKey.filter { $0.value.window == nil }.map(\.key)
        guard !detachedKeys.isEmpty else { return }
        for key in detachedKeys {
            cellsByKey.removeValue(forKey: key)?.releaseRenderingResources()
        }
        cellRecency.removeAll { cellsByKey[$0] == nil }
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
            stopProcessClock()
            return
        }
        guard !isProcessClockScheduled else { return }
        isProcessClockScheduled = true
        scheduleProcessClockTick()
    }

    /// Stops the chain without owning anything to invalidate. A one-shot tick
    /// already queued in the RunLoop fails the generation check on fire and
    /// simply does not reschedule itself, so stopping leaves no object behind.
    private func stopProcessClock() {
        processClockGeneration &+= 1
        isProcessClockScheduled = false
    }

    private func scheduleProcessClockTick() {
        guard isProcessClockScheduled else { return }
        let generation = processClockGeneration
        let interval = ConversationProcessPresentation.elapsedRefreshInterval
        // Fire at the next whole-second boundary of the running turn, so the
        // label changes exactly when its displayed integer second changes.
        let now = Date()
        let fireAt: Date
        if let index = activeProcessClockRowIndex, rows.indices.contains(index),
           let start = rows[index].processStartedAt {
            let elapsed = now.timeIntervalSince(start)
            fireAt = start.addingTimeInterval((elapsed.rounded(.down) + 1) * interval)
        } else {
            fireAt = now.addingTimeInterval(interval)
        }
        let timer = Timer(fire: max(fireAt, now.addingTimeInterval(0.02)),
                          interval: interval, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.isProcessClockScheduled,
                      self.processClockGeneration == generation else { return }
                self.refreshVisibleProcessElapsed()
                self.scheduleProcessClockTick()
            }
        }
        // .default contains no NSEventTrackingRunLoopMode: during a window
        // drag / live resize the tick never fires. On mouse-up the overdue
        // one-shot fires once, reads the real clock, and realigns to the next
        // boundary, so the label catches up without ever drifting.
        RunLoop.main.add(timer, forMode: .default)
    }

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
        // The handle lives in the message document, not in the viewport. Its
        // frame is pinned to the end of the expanded process card, so scrolling
        // and live resize move it with the content instead of chasing the
        // visible rect on every frame.
        let host = scrollView.documentView ?? tableView
        host.addSubview(collapseButton, positioned: .above, relativeTo: nil)
        processCollapseHost = host
        processCollapseButton = collapseButton
        if let firstLayoutScrollView = scrollView as? FirstLayoutRestoringScrollView {
            firstLayoutScrollView.onLayout = { [weak self] in
                self?.restoreInitialViewportSynchronouslyIfNeeded()
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
        if let intrinsicTable = tableView as? IntrinsicHeightTableView {
            intrinsicTable.onLayout = { [weak self] in
                self?.scheduleDocumentExtentSync()
            }
        }
        tableView.dataSource = self
        tableView.delegate = self
        tableView.usesAutomaticRowHeights = true
        tableView.rowHeight = 100 // AppKit's offscreen estimate, never an exact height cache.
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

    private func usesSharedCard(_ row: AppKitChatTimelineRow) -> Bool {
        return (row.coordinationProgress != nil || row.scheduledTrigger != nil || row.userInput != nil || row.executionPlan != nil || (row.nativeStyle == .process ? useSharedProcessCards : useSharedTextCards))
            && MacSharedMessageTextCard.supports(row)
    }

    /// Reuse the existing width reflow transaction for reading metrics too.
    func updateSkin(_ next: ConversationSkin) {
        guard skin != next else { return }
        // Capture while the old width and typography still describe the
        // displayed glyphs. synchronizeTableWidth may already reflow cells.
        let oldWidth = tableView?.tableColumns.first?.width ?? 0
        let anchor: TypographyAnchor?
        if let saved = typographyReadingAnchor, saved.generation == scrollCommandGeneration,
           saved.width == oldWidth, rows.contains(where: { $0.id == saved.anchor.rowID }), !followsLatest {
            anchor = saved.anchor
        } else {
            anchor = presentationActive ? captureTypographyAnchor() : nil
        }
        skin = next
        synchronizeTableWidth()
        needsTypographyReflow = tableView != nil && !rows.isEmpty
        if needsTypographyReflow && presentationActive { reflowForTypography(preserving: anchor) }
    }

    private struct TypographyAnchor {
        let rowID: String
        let fragment: Int
        let character: Int
        let viewportY: CGFloat
    }

    // Keep the exact character through repeated toggles. Re-capturing a new
    // line's first glyph each time would accumulate a line of rounding drift.
    private var typographyReadingAnchor: (anchor: TypographyAnchor, generation: Int, width: CGFloat)?

    private func textViews(in view: NSView) -> [NSTextView] {
        if let text = view as? NativeTimelineTextView { return [text] }
        return view.subviews.flatMap { textViews(in: $0) }
    }

    private func captureTypographyAnchor() -> TypographyAnchor? {
        guard !followsLatest, let tableView, let scrollView,
              let anchor = visibleAnchor(in: tableView),
              let index = rows.firstIndex(where: { $0.id == anchor.id }),
              let cell = tableView.view(atColumn: 0, row: index, makeIfNecessary: false) else { return nil }
        let viewportY = scrollView.contentView.bounds.minY
        let leaves = textViews(in: cell)
        for (fragment, text) in leaves.enumerated() {
            let frame = tableView.convert(text.bounds, from: text)
            guard frame.maxY >= viewportY, text.string.utf16.count > 0,
                  let manager = text.layoutManager, let container = text.textContainer else { continue }
            manager.ensureLayout(for: container)
            let point = NSPoint(x: 0, y: max(0, viewportY - frame.minY))
            let glyph = manager.glyphIndex(for: point, in: container)
            guard glyph < manager.numberOfGlyphs else { continue }
            let rect = manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            return TypographyAnchor(rowID: anchor.id, fragment: fragment,
                character: manager.characterIndexForGlyph(at: glyph),
                viewportY: tableView.convert(rect.origin, from: text).y - viewportY)
        }
        return nil
    }

    @discardableResult
    private func restoreTypographyAnchor(_ anchor: TypographyAnchor) -> Bool {
        guard !followsLatest, let tableView,
              let index = rows.firstIndex(where: { $0.id == anchor.rowID }),
              let cell = tableView.view(atColumn: 0, row: index, makeIfNecessary: true) else { return false }
        cell.layoutSubtreeIfNeeded()
        let leaves = textViews(in: cell)
        guard leaves.indices.contains(anchor.fragment) else { return false }
        let text = leaves[anchor.fragment]
        guard anchor.character < text.string.utf16.count,
              let manager = text.layoutManager, let container = text.textContainer else { return false }
        manager.ensureLayout(for: container)
        let glyph = manager.glyphIndexForCharacter(at: anchor.character)
        guard glyph < manager.numberOfGlyphs else { return false }
        let rect = manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        let y = tableView.convert(rect.origin, from: text).y - anchor.viewportY
        // The width transaction queued a pixel anchor. Replace it with the
        // more precise character anchor; enqueueCorrection otherwise retains
        // the first pre-mutation anchor through consecutive updates.
        guard !isProcessingUserScrollEvent else { return false }
        pendingCorrection = nil
        return restore(anchor: (anchor.rowID, y - tableView.rect(ofRow: index).minY), in: tableView)
    }

    private func reflowForTypography(preserving capturedAnchor: TypographyAnchor? = nil) {
        guard let tableView, let scrollView else { return }
        needsTypographyReflow = false
        let width = tableView.tableColumns.first?.width ?? tableView.bounds.width
        let anchor: TypographyAnchor?
        if let capturedAnchor {
            anchor = capturedAnchor
        } else if let saved = typographyReadingAnchor, saved.generation == scrollCommandGeneration,
           saved.width == width, rows.contains(where: { $0.id == saved.anchor.rowID }), !followsLatest {
            anchor = saved.anchor
        } else { anchor = captureTypographyAnchor() }
        typographyReadingAnchor = anchor.map { ($0, scrollCommandGeneration, width) }
        let visible = tableView.rows(in: scrollView.contentView.bounds)
        if visible.location != NSNotFound {
            for row in visible.location..<min(rows.count, NSMaxRange(visible)) {
                (tableView.view(atColumn: 0, row: row, makeIfNecessary: false) as? AppKitChatRowRendering)?
                    .updateAppearance(skin: skin)
            }
        }
        // Typography changes can shrink native automatic heights even when
        // width is unchanged. Invalidate these containers only for this action.
        if visible.location != NSNotFound {
            resetSDKRowContainers(IndexSet(integersIn: visible.location..<min(rows.count, NSMaxRange(visible))), in: tableView)
        }
        performExactWidthReflow()
        if let anchor { _ = restoreTypographyAnchor(anchor) }
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard rows.indices.contains(row) else { return nil }
        isProvidingCell = true
        defer { isProvidingCell = false }
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
            cachedCell.updateAppearance(skin: skin)
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
            return cachedCell
        }
        SessionSwitchTrace.shared.recordCell(.miss, sessionID: representedSessionID, rowID: rowModel.id)
        let identifier = usesSharedText ? Self.sharedTextCellIdentifier : Self.nativeCellIdentifier
        // Cached cells remain bound to a semantic message. AppKit's reuse
        // queue cannot also rebind them while a row container is recreated.
        let cell: NSTableCellView & AppKitChatRowRendering = {
                ChatPerformanceRecorder.shared.increment(.appKitCellsCreated)
                if usesSharedText { return AppKitSharedMessageTextCell(identifier: identifier) }
                return AppKitChatNativeTextCell(identifier: identifier)
            }()
        cell.identifier = nil
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
        let width = tableView.tableColumns.first?.width ?? tableView.bounds.width
        for index in changed {
            if let cell = tableView.view(atColumn: 0, row: index, makeIfNecessary: false) as? (NSTableCellView & AppKitChatRowRendering) {
                cell.setContent(rows[index], availableWidth: width, baseDirectory: baseDirectory,
                    onToggleExpansion: onToggleExpansion, onAction: onAction)
            }
        }
        resetSDKRowContainers(changed, in: tableView)
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
        while cellRecency.count > Self.cellCacheCapacity, let oldest = cellRecency.first {
            cellRecency.removeFirst()
            SessionSwitchTrace.shared.recordCell(.capacityEvicted, sessionID: oldest.sessionID, rowID: oldest.rowID)
            if let evicted = cellsByKey.removeValue(forKey: oldest) {
                evicted.releaseRenderingResources()
            }
        }
    }

    private func touchCell(_ key: CellCacheKey) {
        cellRecency.removeAll { $0 == key }
        cellRecency.append(key)
    }

    private var processStepVersions: [String: (step: NativeExecutionTimelineStep, revision: Int)] = [:]

    private func virtualizedProcessRows(_ source: [AppKitChatTimelineRow]) -> [AppKitChatTimelineRow] {
        var result: [AppKitChatTimelineRow] = []
        var retained = Set(cellsByKey.keys.map(\.rowID))
        for original in source {
            guard original.nativeStyle == .process, original.isExpanded,
                  original.processParentID == nil, !original.processSteps.isEmpty,
                  original.rawStatusText.isEmpty, useSharedProcessCards else { result.append(original); continue }
            var header = original
            header.processSteps = []
            header.nativeText = ""
            header.hasVirtualProcessChildren = true
            result.append(header)
            for step in original.processSteps {
                let id = original.id + "/step/" + step.id
                let previous = processStepVersions[id]
                let revision = previous?.step == step ? previous!.revision : (previous?.revision ?? 0) &+ 1
                processStepVersions[id] = (step, revision)
                retained.insert(id)
                var child = AppKitChatTimelineRow(id: id, contentRevision: revision,
                    nativeText: "", copyText: NativeExecutionTimelineProjection.plainText(for: [step]),
                    nativeStyle: .process, title: "", metadata: "", expandableTurnId: nil,
                    isExpanded: true, processSteps: [step], showsHeader: false)
                child.sessionID = original.sessionID
                child.processParentID = original.id
                child.processStep = step
                result.append(child)
            }
        }
        processStepVersions = processStepVersions.filter { retained.contains($0.key) }
        return result
    }

    func apply(rows nextRows: [AppKitChatTimelineRow], contentRevision: UInt64? = nil, animated: Bool = false) {
        if let contentRevision, lastAppliedContentRevision == contentRevision,
           lastAppliedContentSessionID == representedSessionID { return }
        lastAppliedContentRevision = contentRevision
        lastAppliedContentSessionID = representedSessionID
        let trace = SessionSwitchTrace.shared.start(.timelineApply, sessionID: representedSessionID)
        defer { SessionSwitchTrace.shared.finish(trace) }
        let nextRows = ConversationTimeSeparatorPolicy.applying(to: Self.uniquedRows(virtualizedProcessRows(nextRows)))
        hasExpandedProcessRows = nextRows.contains { $0.nativeStyle == .process && $0.isExpanded }
        defer { synchronizeProcessClock(); positionProcessCollapseButton(); scheduleUnderfilledHistoryEvaluation() }
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
            // Set the target width before mounting target cells. Width
            // synchronization must not cause a second SDK data reload.
            isReloadingSDKRowData = true
            synchronizeTableWidth(reflowingRows: false)
            tableView.reloadData()
            isReloadingSDKRowData = false
            lastReflowMeasurementWidth = tableView.tableColumns.first?.width
            synchronizeDocumentHeight(in: tableView)
            restoreInitialViewportSynchronouslyIfNeeded()
            schedulePendingInitialViewportRestoreIfNeeded()
            return
        }
        let previousRows = rows
        let oldIDs = rows.map(\.id)
        let newIDs = nextRows.map(\.id)
        let oldRevisions = revisionsByID
        let oldReplyIdentities = rows.map(\.replyIdentity)
        let oldReplyIdentitiesByID = Dictionary(uniqueKeysWithValues: rows.compactMap { row in
            row.replyIdentity.map { (row.id, $0) }
        })
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
        let shouldFollowAfterUpdate = pendingProcessCollapseRowID == nil
            && (pendingRestorePosition?.followsLatest ?? (rows.isEmpty
                ? followedLatestBeforeUpdate : isViewportNearBottom()))
        // Native layout can resolve during the mutation. Commit physical
        // reader intent first so an old SwiftUI follow value cannot win.
        followsLatest = shouldFollowAfterUpdate
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
        rows = nextRows
        revisionsByID = Dictionary(uniqueKeysWithValues: nextRows.map { ($0.id, $0.contentRevision) })


        guard oldIDs == newIDs else {
            applyStructuralDifference(
                from: oldIDs,
                to: newIDs,
                oldRevisions: oldRevisions,
                oldReplyIdentities: oldReplyIdentitiesByID,
                in: tableView
            )
            // Structural changes can remove headers or precede an explicit
            // session restore; settle their document before compensation.
            synchronizeDocumentHeight(in: tableView)
            if let rowID = pendingProcessCollapseRowID {
                pendingProcessCollapseRowID = nil
                scrollToProcessRow(rowID)
            } else if shouldFollowAfterUpdate, !hasPendingInitialViewport {
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
        let resetSDKRows = IndexSet(changed.filter { index in
            (oldRevisions[nextRows[index].id] != nextRows[index].contentRevision
                && !(usesSharedCard(previousRows[index]) && usesSharedCard(nextRows[index])
                    && SDKRowContainerResetPolicy.canRetainForAppend(previous: previousRows[index], next: nextRows[index])))
                || (oldReplyIdentities[index] == nil) != (nextRows[index].replyIdentity == nil)
        })
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
        resetSDKRowContainers(resetSDKRows, in: tableView)
        tableView.noteHeightOfRows(withIndexesChanged: changed)
        // The reset classification above already checked the suffix. Reuse
        // that result instead of scanning an appended body a second time.
        let onlyStableAppend = resetSDKRows.isEmpty && changed.allSatisfy {
            oldRevisions[nextRows[$0].id] != nextRows[$0].contentRevision
        }
        if !onlyStableAppend || !shouldFollowAfterUpdate || hasPendingInitialViewport {
            synchronizeDocumentHeight(in: tableView)
        }
        if let rowID = pendingProcessCollapseRowID {
            pendingProcessCollapseRowID = nil
            scrollToProcessRow(rowID)
        } else if shouldFollowAfterUpdate,
           !hasPendingInitialViewport {
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
        oldReplyIdentities: [String: ConversationReplyIdentity],
        in tableView: NSTableView
    ) {
        let selectedIDs = tableView.selectedRowIndexes.compactMap {
            oldIDs.indices.contains($0) ? oldIDs[$0] : nil
        }
        let width = tableView.tableColumns.first?.width ?? tableView.bounds.width
        let visible = tableView.rows(in: tableView.visibleRect)
        let mountedIDs = Set(visible.location == NSNotFound ? [] : oldIDs.dropFirst(visible.location).prefix(visible.length))
        for row in rows where mountedIDs.contains(row.id) {
            guard let revision = oldRevisions[row.id],
                  revision != row.contentRevision || oldReplyIdentities[row.id] != row.replyIdentity,
                  let cell = cellsByKey[CellCacheKey(sessionID: representedSessionID, rowID: row.id, revision: revision)],
                  (cell is AppKitSharedMessageTextCell) == usesSharedCard(row) else { continue }
            cell.setContent(row, availableWidth: width, baseDirectory: baseDirectory,
                onToggleExpansion: onToggleExpansion, onAction: onAction)
            cacheCell(cell, for: row)
        }
        let selectedRows = IndexSet(selectedIDs.compactMap { rowIndexesByID[$0] })
        let difference = newIDs.difference(from: oldIDs)
        var removed = IndexSet(), inserted = IndexSet()
        for change in difference {
            switch change {
            case .remove(let offset, _, _): removed.insert(offset)
            case .insert(let offset, _, _): inserted.insert(offset)
            }
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0; context.allowsImplicitAnimation = false
            tableView.beginUpdates()
            if !removed.isEmpty { tableView.removeRows(at: removed, withAnimation: []) }
            if !inserted.isEmpty { tableView.insertRows(at: inserted, withAnimation: []) }
            tableView.endUpdates()
        }
        tableView.selectRowIndexes(selectedRows, byExtendingSelection: false)
    }

    private func scheduleDocumentExtentSync() {
        guard presentationActive, !isSynchronizingDocumentExtent, !applyingCorrection else { return }
        scheduleViewportCommit()
    }

    /// Layout completion and scroll intent share one pending main-queue effect.
    private func scheduleViewportCommit() {
        guard !correctionScheduled else { return }
        correctionScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.correctionScheduled = false
            guard self.presentationActive, let table = self.tableView else { return }
            if self.pendingCorrection != nil { self.commitCorrection() }
            else {
                let previousHeight = self.scrollView?.documentView?.frame.height
                self.synchronizeDocumentExtent(in: table)
                // Only a changed document extent needs follow reconciliation.
                // Ordinary native layout while scrolling must not create a jump.
                if previousHeight != self.scrollView?.documentView?.frame.height {
                    self.reconcileLayout()
                }
            }
        }
    }

    private func synchronizeDocumentHeight(in tableView: NSTableView) {
        #if DEBUG
        documentHeightSyncCount += 1
        #endif
        tableView.layoutSubtreeIfNeeded()
        synchronizeDocumentExtent(in: tableView)
    }

    private func synchronizeDocumentExtent(in tableView: NSTableView) {
        guard !isSynchronizingDocumentExtent else { return }
        isSynchronizingDocumentExtent = true
        defer { isSynchronizingDocumentExtent = false }
        let rowsHeight = (rows.isEmpty
            ? 0
            : tableView.rect(ofRow: rows.count - 1).maxY)
        if abs(tableView.frame.minY - topClearance) >= 0.5 || abs(tableView.frame.height - rowsHeight) >= 0.5 {
            tableView.frame = NSRect(x: tableView.frame.minX, y: topClearance,
                width: tableView.frame.width, height: rowsHeight)
        }
        if let document = scrollView?.documentView {
            let height = topClearance + rowsHeight + bottomClearance
            if abs(document.frame.height - height) >= 0.5 {
                document.setFrameSize(NSSize(width: document.frame.width, height: height))
            }
        }
        // Measured row heights can move the process card's bottom edge. Snap
        // the pinned handle to it, but never during a live resize frame:
        // windowDidEndLiveResize performs that single catch-up on mouse-up.
        if !(scrollView?.window?.inLiveResize ?? false),
           !(scrollView.map(ConsoleNativeSplitView.isResizing) ?? false) {
            positionProcessCollapseButton()
        }
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
                  self.scrollView.map({ !ConsoleNativeSplitView.isResizing($0) }) == true,
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
        scheduleViewportCommit()
    }

    private func commitCorrection(allowDuringUserScroll: Bool = false) {
        guard !applyingCorrection, (!isProcessingUserScrollEvent || allowDuringUserScroll),
              let correction = pendingCorrection,
              let tableView, let clip = scrollView?.contentView,
              !rows.isEmpty, clip.bounds.height > 0 else { return }
        pendingCorrection = nil
        applyingCorrection = true
        defer { applyingCorrection = false }
        if case let .anchor(id, _) = correction,
           let index = rows.firstIndex(where: { $0.id == id }) {
            prepareSDKDestination(index, in: tableView)
        }
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
        let realizedRows = tableView.rows(in: tableView.visibleRect)
        clip.scroll(to: NSPoint(x: 0, y: y))
        if tableView.needsLayout || tableView.rows(in: tableView.visibleRect) != realizedRows
            || abs(max(0, (scrollView?.documentView?.frame.height ?? 0) - clip.bounds.height) - maximumY) > 0.5 {
            // Scrolling realizes neighbouring estimates. Resolve that layout
            // once in this transaction before committing the semantic target.
            synchronizeDocumentHeight(in: tableView)
            let maximum = max(0, (scrollView?.documentView?.frame.height ?? 0) - clip.bounds.height)
            let settledY: CGFloat
            switch correction {
            case .bottom: settledY = maximum
            case let .anchor(id, offset):
                guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
                settledY = min(maximum, max(0, tableView.rect(ofRow: index).minY + offset))
            }
            clip.scroll(to: NSPoint(x: 0, y: settledY))
        }

        scrollView?.reflectScrolledClipView(clip)
        let anchor = visibleAnchor(in: tableView)
        traceViewport("commit y=\(y) anchor=\(anchor?.id ?? "none")")
        schedulePositionPublish()
    }

    private func reconcileLayout() {
        guard presentationActive else { needsPresentationLayout = true; return }
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
        // The collapse handle is document-anchored; scrolling never repositions it.
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

    /// The collapse handle is anchored to the bottom edge of the last expanded
    /// process group. Its frame lives in document coordinates, so neither
    /// scrolling nor a live resize moves it; only a content/layout change (new
    /// rows, measured row heights, or a finished resize) repositions it.
    private func positionProcessCollapseButton() {
        guard hasExpandedProcessRows,
              let tableView, let button = processCollapseButton,
              let host = processCollapseHost ?? button.superview,
              let column = tableView.tableColumns.first, !rows.isEmpty else {
            processCollapseButton?.isHidden = true
            visibleProcessCollapseRowID = nil
            return
        }
        guard let headerIndex = rows.lastIndex(where: {
            $0.nativeStyle == .process && $0.isExpanded && $0.expandableTurnId != nil
        }) else {
            button.isHidden = true
            visibleProcessCollapseRowID = nil
            return
        }
        let lastMountedRow = min(rows.count, tableView.numberOfRows) - 1
        guard lastMountedRow >= 0 else {
            button.isHidden = true
            visibleProcessCollapseRowID = nil
            return
        }
        let endIndex = min(processGroupEndIndexes[rows[headerIndex].id] ?? headerIndex, lastMountedRow)
        let endRect = tableView.rect(ofRow: endIndex)
        guard endRect.height > 0 else {
            button.isHidden = true
            visibleProcessCollapseRowID = nil
            return
        }
        let cardWidth = MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: 0, expanded: true, laneWidth: column.width)
        let size = button.frame.size
        let margin: CGFloat = 10
        let rightEdge = min(endRect.maxX, endRect.minX + 2 + cardWidth)
        let targetInTable = NSRect(
            x: max(endRect.minX + margin, rightEdge - size.width - margin),
            y: max(endRect.minY, endRect.maxY - size.height - margin),
            width: size.width, height: size.height)
        let target = host === tableView
            ? targetInTable : tableView.convert(targetInTable, to: host)
        if button.frame != target { button.frame = target }
        visibleProcessCollapseRowID = rows[headerIndex].id
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
        (scrollView?.verticalScroller as? TimelineIntentScroller)?.beginScrollInteraction()
        // Complete a ready first-frame restore before granting the gesture
        // viewport ownership. If geometry is not ready, userDidBeginScrolling
        // leaves the restore pending for the next layout pass.
        restoreInitialViewportSynchronouslyIfNeeded()
        isProcessingUserScrollEvent = true
        userDidBeginScrolling()
    }

    func userScrollEventDidEnd() {
        (scrollView?.verticalScroller as? TimelineIntentScroller)?.endScrollInteraction()
        // A wheel/trackpad gesture at the bottom can be fully clamped by
        // the scroll boundary. AppKit then emits no bounds-change event,
        // so `userDidBeginScrolling()` would otherwise leave follow mode
        // false even though the viewport never left the latest region.
        // Reconcile once from final geometry after every user gesture.
        if let tableView { synchronizeDocumentHeight(in: tableView) }
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
        containerGeometryDidChange(isResizing: scrollView.map(ConsoleNativeSplitView.isResizing) ?? false)
    }

    func containerGeometryDidChange(isResizing: Bool) {
        guard presentationActive else { needsPresentationLayout = true; return }
        commitContainerGeometry()
    }

    private func commitContainerGeometry() {
        #if DEBUG
        resizeLayoutCommitCount += 1
        #endif
        // Read current geometry once; never replay queued intermediate widths.
        // The collapse handle is left alone during live resize: it is pinned
        // to the process card, not to the viewport.
        synchronizeTableWidth()
        reconcileLayout()
    }

    @objc private func capturePositionForTermination(_ notification: Notification) {
        publishPositionImmediately()
        #if DEBUG
        NSLog("[TimelineViewport %@] %@", representedSessionID, diagnosticEvents.joined(separator: "\n"))
        #endif
    }

    @objc private func windowDidEndLiveResize(_ notification: Notification) {
        guard let window = notification.object as? NSWindow,
              window === scrollView?.window else { return }
        guard presentationActive else { needsPresentationLayout = true; return }
        commitContainerGeometry()
        // Row heights may have changed with the new column width; snap the
        // document-anchored handle back onto the process card's bottom edge.
        positionProcessCollapseButton()
    }

    func setReservesVerticalScrollerGutter(_ reserves: Bool) {
        guard reservesVerticalScrollerGutter != reserves else { return }
        reservesVerticalScrollerGutter = reserves
        synchronizeTableWidth()
        reconcileLayout()
    }

    func setCentersReadingLane(_ centers: Bool) {
        guard centersReadingLane != centers else { return }
        centersReadingLane = centers
        synchronizeTableWidth()
        reconcileLayout()
    }

    private func synchronizeTableWidth(reflowingRows: Bool = true) {
        guard presentationActive else { needsPresentationLayout = true; return }
        guard let tableView, let scrollView else { return }
        // Every timeline stays overlay-style: a restored legacy preference
        // would introduce an opaque track strip and narrow the clip view.
        if let timelineScrollView = scrollView as? FirstLayoutRestoringScrollView,
           !timelineScrollView.forcesOverlayScrollers {
            timelineScrollView.forcesOverlayScrollers = true
        }
        // Only the wide standard page spreads the scroll view across the whole
        // detail column: AppKit then parks its overlay indicator on the far
        // right, inside the blank gutter, while the message table keeps the
        // centred reading lane. Compact hosts stay full-width end to end.
        let viewportWidth = scrollView.contentView.bounds.width
        let centers = centersReadingLane && reservesVerticalScrollerGutter
        // AppKit's uniform column autoresizing would silently stretch a pinned
        // lane back to the document width on the next tile. Switch it off only
        // while the lane is active and restore the defaults when it is not.
        if centers {
            if tableView.autoresizingMask != [] { tableView.autoresizingMask = [] }
            if tableView.columnAutoresizingStyle != .noColumnAutoresizing {
                tableView.columnAutoresizingStyle = .noColumnAutoresizing
            }
            if let column = tableView.tableColumns.first, column.resizingMask != [] {
                column.resizingMask = []
            }
        } else {
            if tableView.autoresizingMask != [.width] { tableView.autoresizingMask = [.width] }
            if tableView.columnAutoresizingStyle != .uniformColumnAutoresizingStyle {
                tableView.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
            }
            if let column = tableView.tableColumns.first, column.resizingMask != .autoresizingMask {
                column.resizingMask = .autoresizingMask
            }
        }
        let lane = centers
            ? WorkbenchStyle.lane(viewportWidth: viewportWidth)
            : CGRect(x: 0, y: 0, width: viewportWidth, height: 0)
        let laneWidth = min(viewportWidth, max(120, lane.width))
        let laneMinX = centers ? (viewportWidth - laneWidth) / 2 : 0
        let laneFrame = NSRect(x: laneMinX, y: tableView.frame.minY,
                               width: laneWidth, height: tableView.frame.height)
        if abs(tableView.frame.minX - laneFrame.minX) >= 0.5
            || abs(tableView.frame.width - laneFrame.width) >= 0.5 {
            tableView.frame = laneFrame
        }
        if let column = tableView.tableColumns.first, abs(column.width - laneWidth) >= 0.5 {
            column.width = laneWidth
        }
        if let document = scrollView.documentView,
           abs(document.frame.width - viewportWidth) >= 0.5 {
            document.setFrameSize(NSSize(width: viewportWidth, height: document.frame.height))
        }
        let width = tableView.bounds.width
        guard width > 0, abs((lastReflowMeasurementWidth ?? -1) - width) >= 0.5 else { return }
        lastReflowMeasurementWidth = width
        let anchor = visibleAnchor(in: tableView)
        // This path now runs only for an actual container resize. Scroller
        // visibility no longer changes the layout width.
        lastMeasuredWidth = width
        if reflowingRows, !rows.isEmpty {
            let visible = tableView.rows(in: tableView.visibleRect)
            let isLiveResize = ConsoleNativeSplitView.isResizing(scrollView)
            let measurementWidth = width
            let rowsToReflow = LiveResizeRowReflowPolicy.indexes(
                rowCount: rows.count,
                visibleRows: visible,
                isLiveResize: isLiveResize
            )
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
                    if !rowsToReflow.isEmpty {
                    updateWidthReflowHeights(rowsToReflow, in: tableView)
                }
            } else {
                updateWidthReflowHeights(rowsToReflow, in: tableView)
            }
            do {
                lastReflowMeasurementWidth = measurementWidth
                if followsLatest { enqueueCorrection(.bottom) }
                else if let anchor { _ = restore(anchor: anchor, in: tableView) }
            }
        }
    }

    private func performExactWidthReflow() {
        guard presentationActive else { needsPresentationLayout = true; return }
        guard let tableView else { return }
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
        // Finishing a resize reconciles mounted rows only. Offscreen
        // estimates and their eventual exact heights belong to AppKit.
        let affected = visible.location == NSNotFound ? IndexSet()
            : IndexSet(integersIn: visible.location..<min(rows.count, NSMaxRange(visible)))
        updateWidthReflowHeights(affected, in: tableView)
        if followsLatest { enqueueCorrection(.bottom) }
        else if let anchor { _ = restore(anchor: anchor, in: tableView) }
    }

    private func resetSDKRowContainers(_ indexes: IndexSet, in tableView: NSTableView) {
        guard !indexes.isEmpty else { return }
        #if DEBUG
        sdkRowResetCount += indexes.count
        #endif
        // Content changes invalidate only their native row containers.
        // Width-only changes bypass this path and retain mounted cells.
        tableView.beginUpdates()
        tableView.removeRows(at: indexes, withAnimation: [])
        tableView.insertRows(at: indexes, withAnimation: [])
        tableView.endUpdates()
    }

    private func updateWidthReflowHeights(_ indexes: IndexSet, in tableView: NSTableView) {
        guard !isReloadingSDKRowData else { return }
        let visible = tableView.rows(in: tableView.visibleRect)
        guard visible.location != NSNotFound, visible.location < rows.count else { return }
        let mounted = indexes.intersection(IndexSet(integersIn: visible.location..<min(rows.count, NSMaxRange(visible))))
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0
            context.allowsImplicitAnimation = false
            tableView.noteHeightOfRows(withIndexesChanged: mounted)
        }
    }

    private func visibleAnchor(in tableView: NSTableView) -> (id: String, offset: CGFloat)? {
        guard let clipView = scrollView?.contentView, !rows.isEmpty else { return nil }
        // The table begins after topClearance. The readable viewport also
        // begins after topClearance, so the two offsets cancel in table space.
        // Do not anchor to a row hidden behind the floating header.
        let readableY = max(0, clipView.bounds.minY)
        let row = tableView.row(at: NSPoint(x: 1, y: readableY))
        guard rows.indices.contains(row) else { return nil }
        // Keep the existing semantic process anchor across child-row virtualization.
        let anchorRow = rows[row].processParentID.flatMap { rowIndexesByID[$0] } ?? row
        let offset = readableY - tableView.rect(ofRow: anchorRow).minY
        return (rows[anchorRow].id, offset)
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

    private var navigationSessionID: String?
    private var lastNavigationRevision = -1
    private var pendingNavigationRowID: String?
    func applyMessageNavigation(rowID: String?, revision: Int) {
        if navigationSessionID != representedSessionID || lastNavigationRevision != revision {
            navigationSessionID = representedSessionID
            lastNavigationRevision = revision
            pendingNavigationRowID = rowID
        }
        guard let id = pendingNavigationRowID,
              let row = rows.firstIndex(where: { $0.id == id }), tableView != nil else { return }
        pendingNavigationRowID = nil
        scrollToRow(row)
    }

    func scrollToTurn(_ turnID: String) {
        guard let row = AppKitChatTimelineView.rowIndex(forTurnID: turnID, in: rows) else { return }
        scrollToRow(row)
    }

    private func scrollToProcessRow(_ rowID: String) {
        guard let row = rows.firstIndex(where: { $0.id == rowID }) else { return }
        scrollToRow(row, clampsToDocument: true)
        if isViewportNearBottom() {
            followsLatest = true
            if !followsLatestBinding.wrappedValue { followsLatestBinding.wrappedValue = true }
        }
    }

    private func prepareSDKDestination(_ row: Int, in tableView: NSTableView) {
        // Resolve only the semantic destination through AppKit, rather than
        // navigating into an offscreen estimated row height.
        _ = tableView.rowView(atRow: row, makeIfNecessary: true)
        tableView.noteHeightOfRows(withIndexesChanged: IndexSet(integer: row))
    }

    private func scrollToRow(_ row: Int, clampsToDocument: Bool = false) {
        guard !isProcessingUserScrollEvent,
              let tableView,
              let clipView = scrollView?.contentView else { return }
        claimViewportIntent()
        pendingRestorePosition = nil
        pendingInitialScrollToBottom = false
        suppressNearTopDuringLayout()
        followsLatest = false
        if followsLatestBinding.wrappedValue { followsLatestBinding.wrappedValue = false }
        prepareSDKDestination(row, in: tableView)
        tableView.layoutSubtreeIfNeeded()
        synchronizeDocumentHeight(in: tableView)
        // A collapsed row can be near the end of a now much shorter document.
        // Clamp navigation to its new scroll range instead of exposing empty space.
        let maximumY = max(0, (scrollView?.documentView?.frame.height ?? 0) - clipView.bounds.height)
        let targetY = max(0, tableView.rect(ofRow: row).minY - 10)
        let y = clampsToDocument ? min(maximumY, targetY) : targetY
        clipView.scroll(to: NSPoint(x: 0, y: y))
        scrollView?.reflectScrolledClipView(clipView)
        // One coalesced correction for this navigation intent. Subsequent
        // input clears it through the existing viewport-intent machinery.
        enqueueCorrection(.anchor(id: rows[row].id, offset: -10))

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
        pendingCorrection = nil
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
        guard !isRestoringInitialViewport, !isProvidingCell,
              pendingRestorePosition != nil || pendingInitialScrollToBottom,
              let tableView,
              let clipView = scrollView?.contentView,
              clipView.bounds.width > 0,
              clipView.bounds.height > 0,
              !rows.isEmpty else { return }
        isRestoringInitialViewport = true
        defer { isRestoringInitialViewport = false }
        suppressNearTopDuringLayout()
        if let position = pendingRestorePosition,
           let row = rows.firstIndex(where: { $0.id == position.rowID }) {
            prepareSDKDestination(row, in: tableView)
        }
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
