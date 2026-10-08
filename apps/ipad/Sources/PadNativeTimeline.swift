import SwiftUI
import UIKit
import Observation
import OSLog
import Combine
import ChatLayout
import CorptieClientCore
import CorptieConversation

struct PadNativeTimelineRowVersion: Equatable {
    var messages: [ClientMessage] = []
    var decoration: String = ""
    var expanded = false
    var canRespond = false
}

/// Only presentation transitions are observed. Offsets never invalidate SwiftUI.
@MainActor @Observable
final class PadNativeTimelineHandle {
    var showsJump = false
    var composerHeight: CGFloat = 0
    var hasNewMessagesBelow = false
    @ObservationIgnored var jump: (() -> Void)?
    @ObservationIgnored var scrollToEntry: ((String) -> Void)?
    @ObservationIgnored var scrollToOffset: ((CGFloat) -> Void)?
    @ObservationIgnored var currentPosition: (() -> PadTimelineReadingPosition?)?
    @ObservationIgnored var scrollbarInteraction: ((Bool) -> Void)?
    @ObservationIgnored var owner: UUID?
}

/// Type-erased presentation access for native integration verification; the
/// controller's hosted row/composer types need not leak out of the container.
@MainActor protocol PadNativeTimelinePresentationSource: AnyObject {
    var presentationHandle: PadNativeTimelineHandle { get }
}

struct PadNativeTimeline<Row: View, Composer: View>: UIViewControllerRepresentable {
    let ids: [String]
    let versions: [String: PadNativeTimelineRowVersion]
    let ready: Bool
    let savedPosition: PadTimelineReadingPosition?
    let jumpRevision: UInt64
    let keyboard: PadKeyboardViewport
    let handle: PadNativeTimelineHandle
    var topOverlayHeight: CGFloat = 0
    var tracksVisibleFrames = true
    let row: (String, CGFloat) -> Row
    let composer: Composer
    let onScrollView: (UIScrollView) -> Void
    let onNearTop: (Bool, Bool, Bool) -> Void
    let onSave: (PadTimelineReadingPosition) -> Void
    let onUserInteraction: () -> Void
    let onVisibleFrames: ([String: CGRect], CGSize) -> Void

    func makeUIViewController(context: Context) -> PadNativeTimelineController<Row, Composer> {
        PadNativeTimelineController(input: self)
    }
    func updateUIViewController(_ controller: PadNativeTimelineController<Row, Composer>, context: Context) {
        controller.update(self)
    }
    static func dismantleUIViewController(_ controller: PadNativeTimelineController<Row, Composer>, coordinator: ()) {
        controller.detach()
    }
}

@MainActor
final class PadNativeTimelineController<Row: View, Composer: View>: UIViewController,
    UICollectionViewDelegate, ChatLayoutDelegate, PadNativeTimelinePresentationSource {
    var presentationHandle: PadNativeTimelineHandle { input.handle }
    private var input: PadNativeTimeline<Row, Composer>
    private let owner = UUID()
    private var detached = false
    private var intentRevision: UInt64 = 0
    private let chatLayout = CollectionViewChatLayout()
    private let collection: TimelineCollectionView
    private let composerHost: UIHostingController<Composer>
    private var dataSource: ChatLayoutDiffableDataSource<Int, String>!
    private var versions: [String: PadNativeTimelineRowVersion] = [:]
    private var applying = false
    private var queuedInput: PadNativeTimeline<Row, Composer>?
    private var configuredWidth: CGFloat = 0
    private var needsRows = false
    private var rowsScheduled = false
    private var following = true
    private var userScrolling = false
    private var placed = false
    private var pendingRestore: PadTimelineReadingPosition?
    private var settledRestore: PadTimelineReadingPosition?
    private var resizeAnchor: PadTimelineReadingPosition?
    private var lastViewport = CGSize.zero
    private var lastInsets = UIEdgeInsets.zero
    private var updatingInsets = false
    private var layingOutContainer = false
    static var bottomMessageGap: CGFloat { 8 }
    private var lastJumpRevision: UInt64
    private var reconciling = false
    private var publishing = false
    private var nearTop: Bool?
    private var nearTopUser = false
    private var wasUnderfilled = false
    private var reportedJump: Bool?
    private var unreadBelow = false
    private var keyboardVisible = false
    private var keyboardChanging = false
    private var keyboardObservers: Set<AnyCancellable> = []
    private static var log: Logger { Logger(subsystem: "com.corptie.mobile", category: "NativeTimeline") }

    init(input: PadNativeTimeline<Row, Composer>) {
        self.input = input
        lastJumpRevision = input.jumpRevision
        following = input.savedPosition?.followsLatest ?? true
        pendingRestore = input.savedPosition?.followsLatest == false ? input.savedPosition : nil
        collection = TimelineCollectionView(frame: .zero, collectionViewLayout: chatLayout)
        composerHost = UIHostingController(rootView: input.composer)
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        chatLayout.delegate = self
        chatLayout.settings.interItemSpacing = PadTimelineLayoutMetrics.rowSpacing
        chatLayout.settings.additionalInsets = UIEdgeInsets(top: PadTimelineLayoutMetrics.verticalPadding,
            left: PadTimelineLayoutMetrics.horizontalMargin, bottom: Self.bottomMessageGap,
            right: PadTimelineLayoutMetrics.horizontalMargin)
        chatLayout.keepContentAtBottomOfVisibleArea = true
        chatLayout.keepContentOffsetAtBottomOnBatchUpdates = following
        collection.backgroundColor = .clear
        collection.alwaysBounceVertical = true
        collection.contentInsetAdjustmentBehavior = .never
        collection.keyboardDismissMode = .interactive
        collection.showsVerticalScrollIndicator = false
        collection.showsHorizontalScrollIndicator = false
        collection.delegate = self
        collection.accessibilityIdentifier = "conversation-timeline"
        collection.register(TimelineCell.self, forCellWithReuseIdentifier: "message")
        collection.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(collection)
        addChild(composerHost)
        composerHost.sizingOptions = .intrinsicContentSize
        // The parent keyboard guide owns avoidance. A second hosting-controller
        // keyboard safe area otherwise changes the composer's intrinsic height.
        composerHost.safeAreaRegions = []
        composerHost.view.backgroundColor = .clear
        composerHost.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(composerHost.view)
        composerHost.didMove(toParent: self)
        // One owner for keyboard space: no extra keyboard inset or SwiftUI padding.
        view.keyboardLayoutGuide.followsUndockedKeyboard = false
        // Full-screen drawing is independent of the readable rectangle. The
        // system guide owns composer movement; its occluded area is an inset.
        let collectionBottomConstraint = collection.bottomAnchor.constraint(
            equalTo: view.bottomAnchor)
        NSLayoutConstraint.activate([
            collection.topAnchor.constraint(equalTo: view.topAnchor),
            collection.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collection.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            collectionBottomConstraint,
            composerHost.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            composerHost.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            composerHost.view.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])
        dataSource = ChatLayoutDiffableDataSource(collectionView: collection) { [weak self] collection, path, id in
            guard let self else { return nil }
            let cell = collection.dequeueReusableCell(withReuseIdentifier: "message", for: path)
            (cell as? TimelineCell)?.allowsAnimatedLayout = { [weak self] in
                guard let self else { return false }
                return self.keyboardChanging || self.input.keyboard.isChanging
            }
            let width = max(1, collection.bounds.width - 2 * PadTimelineLayoutMetrics.horizontalMargin)
            let content = self.input.row(id, width)
            cell.contentConfiguration = UIHostingConfiguration {
                // Native reuse must not carry one message's SwiftUI state or
                // render identity into another message. Same-ID updates keep
                // their state; a reused cell gets the new row's identity.
                content.frame(width: width).id(id)
            }.margins(.all, 0)
            cell.backgroundColor = .clear
            cell.clipsToBounds = false
            cell.contentView.clipsToBounds = false
            return cell
        }
        collection.afterLayout = { [weak self] in
            guard let self, !self.layingOutContainer else { return }
            self.reconcileLayout()
        }
        collection.allowsAnimatedLayout = { [weak self] in
            guard let self else { return false }
            return self.keyboardChanging || self.input.keyboard.isChanging
        }
        observeKeyboardPresentation()
        attachHandle()
        applyRows()
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.detached, self.input.handle.owner == self.owner else { return }
            self.input.onScrollView(self.collection)
        }
    }

    override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        layingOutContainer = true
        // Capture BEFORE the keyboard guide changes the native viewport.
        if placed && !following && !userScrolling && resizeAnchor == nil { resizeAnchor = position() }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layingOutContainer = false
        reconcileLayout()
        resizeAnchor = nil
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        save()
    }

    func update(_ next: PadNativeTimeline<Row, Composer>) {
        if keyboardChanging || next.keyboard.isChanging {
            updateContent(next)
        } else {
            UIView.performWithoutAnimation { updateContent(next) }
        }
    }

    private func updateContent(_ next: PadNativeTimeline<Row, Composer>) {
        let previous = input
        input = next
        guard isViewLoaded else { return }
        composerHost.rootView = next.composer
        // sizingOptions propagates actual intrinsic-size changes. Invalidating
        // again on every presentation update needlessly relayouts the timeline.
        if !following, previous.ids.last != next.ids.last {
            unreadBelow = true
        }
        // Keyboard visibility affects only the control, never reading intent.
        if !placed, next.ready {
            following = next.savedPosition?.followsLatest ?? true
            pendingRestore = next.savedPosition?.followsLatest == false ? next.savedPosition : nil
        }
        if next.jumpRevision != lastJumpRevision {
            lastJumpRevision = next.jumpRevision
            // The revision cancels a scrollbar drag; explicit intent already
            // executes synchronously through the handle, not a second writer.
        }
        if applying { queuedInput = next; return }
        if previous.ids != next.ids || versions != next.versions { applyRows() }
        else { reconcileLayout(); publish() }
    }

    private func attachHandle() {
        input.handle.owner = owner
        input.handle.jump = { [weak self] in self?.jumpToLatest() }
        input.handle.scrollToEntry = { [weak self] id in
            guard let self, self.dataSource.indexPath(for: id) != nil else { return }
            self.following = false
            self.intentRevision &+= 1
            self.pendingRestore = PadTimelineReadingPosition(followsLatest: false, entryID: id, minY: 0)
            self.reconcileLayout()
        }
        input.handle.currentPosition = { [weak self] in self?.position() }
        input.handle.scrollbarInteraction = { [weak self] active in
            guard let self else { return }
            self.userScrolling = active
            if active {
                self.intentRevision &+= 1
                self.input.onUserInteraction()
                self.following = false
                self.pendingRestore = nil
                self.settledRestore = nil
            }
            else { self.following = self.geometry.isAtBottom; self.save() }
            self.chatLayout.keepContentOffsetAtBottomOnBatchUpdates = self.following
        }
    }

    private func applyRows() {
        guard !applying else { return }
        let width = collection.bounds.width.rounded(.down)
        // Never create fixed-width card content before Auto Layout has given
        // the collection its real lane width.
        guard width > 2 * PadTimelineLayoutMetrics.horizontalMargin else {
            needsRows = true
            return
        }
        needsRows = false
        let widthChanged = width != configuredWidth
        let anchor = placed && !following && !userScrolling ? position() : nil
        let anchorRevision = intentRevision
        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        snapshot.appendItems(input.ids)
        let oldIDs = Set(dataSource.snapshot?.itemIdentifiers ?? [])
        snapshot.reconfigureItems(input.ids.filter {
            oldIDs.contains($0) && (widthChanged || versions[$0] != input.versions[$0])
        })
        let nextVersions = input.versions
        applying = true
        chatLayout.keepContentOffsetAtBottomOnBatchUpdates = following
        // No row insertion/fade animation competing with keyboard animation.
        dataSource.apply(snapshot, animatingDifferences: false, commitAlongsideUpdates: {
            self.versions = nextVersions
            self.configuredWidth = width
        }) { [weak self] in
            guard let self else { return }
            self.applying = false
            if self.intentRevision == anchorRevision, self.pendingRestore == nil,
               !self.following, !self.userScrolling {
                self.pendingRestore = anchor
            }
            self.collection.layoutIfNeeded()
            self.reconcileLayout()
            if let queued = self.queuedInput {
                self.queuedInput = nil
                self.update(queued)
            }
        }
    }

    private var geometry: PadNativeTimelineGeometry {
        PadNativeTimelineGeometry(contentHeight: collection.contentSize.height,
            viewportHeight: collection.bounds.height, topInset: collection.adjustedContentInset.top,
            bottomInset: collection.adjustedContentInset.bottom, offset: collection.contentOffset.y)
    }


    private func jumpToLatest() {
        intentRevision &+= 1
        // Cancel inertia AND an active finger/scrollbar drag before taking ownership.
        collection.panGestureRecognizer.isEnabled = false
        collection.panGestureRecognizer.isEnabled = true
        collection.setContentOffset(collection.contentOffset, animated: false)
        userScrolling = false
        following = true
        unreadBelow = false
        pendingRestore = nil
        settledRestore = nil
        resizeAnchor = nil
        chatLayout.keepContentOffsetAtBottomOnBatchUpdates = true
        if !applying, let id = input.ids.last, let path = dataSource.indexPath(for: id) {
            // Realize the actual final cell; the layout's snapshot restoration
            // handles self-sizing, unlike an unrelated transparent SwiftUI anchor.
            reconciling = true
            chatLayout.restoreContentOffset(with: .init(indexPath: path, edge: .bottom))
            reconciling = false
        }
        reconcileLayout()
        Self.log.info("event=jump-request rows=\(self.input.ids.count) remaining=\(self.geometry.remaining)")
    }

    private func reconcileLayout() {
        guard !reconciling, !updatingInsets else { return }
        synchronizeReadingInsets()
        if !applying, collection.bounds.width > 2 * PadTimelineLayoutMetrics.horizontalMargin,
           needsRows || configuredWidth != collection.bounds.width.rounded(.down) {
            if placed, !following, !userScrolling, pendingRestore == nil {
                pendingRestore = resizeAnchor ?? position()
            }
            scheduleRowsForWidthChange()
            return
        }
        guard !reconciling, !applying, input.ready, collection.bounds.height > 0,
              !input.ids.isEmpty else { publish(); return }
        reconciling = true
        defer { reconciling = false; publish() }
        let resized = lastViewport != collection.bounds.size || lastInsets != collection.contentInset
        lastViewport = collection.bounds.size
        lastInsets = collection.contentInset
        if !userScrolling, let anchor = pendingRestore ?? (resized && !following ? resizeAnchor : nil)
                ?? (!following && !userScrolling ? settledRestore : nil),
           let id = anchor.entryID, let path = dataSource.indexPath(for: id) {
            let attributes = chatLayout.layoutAttributesForItem(at: path)
            let desired = attributes.map {
                min(geometry.maximum, max(geometry.minimum,
                    $0.frame.minY - CGFloat(anchor.minY) - collection.adjustedContentInset.top))
            }
            if desired == nil || abs(collection.contentOffset.y - desired!) > 0.5 {
                chatLayout.restoreContentOffset(with: .init(indexPath: path, edge: .top,
                    offset: CGFloat(anchor.minY) - chatLayout.settings.additionalInsets.top))
            }
            // Self-sizing rows revealed by a prepend can finish after the
            // snapshot's completion. Keep the same anchor until a new user
            // scroll/jump owns the viewport, rather than accepting that drift.
            settledRestore = anchor
            pendingRestore = nil
            following = false
            placed = true
        } else if following && !userScrolling {
            if !placed, let id = input.ids.last, let path = dataSource.indexPath(for: id) {
                chatLayout.restoreContentOffset(with: .init(indexPath: path, edge: .bottom))
            }
            let target = geometry.maximum
            if abs(collection.contentOffset.y - target) > 0.5 {
                // Participate in the guide's system transaction; there is no
                // independent keyboard height calculation or animation timer.
                collection.bounds = CGRect(origin: CGPoint(x: 0, y: target), size: collection.bounds.size)
            }
            placed = true
        }
        chatLayout.keepContentOffsetAtBottomOnBatchUpdates = following
    }

    private func synchronizeReadingInsets() {
        // Drawing covers the whole lane. Only the readable rectangle excludes
        // floating chrome; cells remain realized underneath the glass.
        // Never subtract sibling frames midway through an Auto Layout pass.
        let bottom = max(0, view.bounds.maxY - view.keyboardLayoutGuide.layoutFrame.minY
            + composerHost.view.bounds.height)
        let insets = UIEdgeInsets(top: input.topOverlayHeight, left: 0, bottom: bottom, right: 0)
        guard insets != collection.contentInset else { return }
        updatingInsets = true
        defer { updatingInsets = false }
        collection.contentInset = insets
        // Chrome/insets change the reading rectangle, not message sizes.
        // A blanket invalidation discards ChatLayout's measured heights. When
        // a keyboard later exposes those rows, estimates get corrected inside
        // its animation and move cell positions independently of the viewport.
        let context = ChatLayoutInvalidationContext()
        context.invalidateLayoutMetrics = false
        chatLayout.invalidateLayout(with: context)
        collection.layoutIfNeeded()
    }

    private func observeKeyboardPresentation() {
        // Notifications inform control visibility only. The system guide still
        // owns all layout and animation; never infer visibility from its resting
        // safe-area rectangle in a nested SwiftUI host.
        for (name, changing) in [(UIResponder.keyboardWillChangeFrameNotification, true),
                                 (UIResponder.keyboardDidChangeFrameNotification, false)] {
            // Receive UIKit's main-thread notification without delaying the
            // presentation gate. No keyboard layout mutation occurs here.
            let observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                    guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
                    MainActor.assumeIsolated {
                        guard let self, !self.detached, let window = self.view.window else { return }
                        let local = window.convert(frame, from: window.screen.coordinateSpace)
                        self.keyboardVisible = PadNativeTimelineGeometry.keyboardIntersectsWindow(
                            frame: local, bounds: window.bounds)
                        self.keyboardChanging = changing
                        self.publish()
                    }
                }
            AnyCancellable { NotificationCenter.default.removeObserver(observer) }
                .store(in: &keyboardObservers)
        }
    }

    private func scheduleRowsForWidthChange() {
        guard !rowsScheduled else { return }
        rowsScheduled = true
        // Do not mutate the data source from inside UICollectionView.layoutSubviews.
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.detached else { return }
            self.rowsScheduled = false
            self.applyRows()
        }
    }

    private func position() -> PadTimelineReadingPosition? {
        guard placed, pendingRestore == nil else { return nil }
        if following { return .init(followsLatest: true, entryID: nil, minY: 0) }
        let paths = collection.indexPathsForVisibleItems.sorted()
        guard let path = paths.first(where: {
            dataSource.itemIdentifier(for: $0) != "__history__"
                && chatLayout.layoutAttributesForItem(at: $0)?.frame.intersects(chatLayout.visibleBounds) == true
        }),
              let id = dataSource.itemIdentifier(for: path),
              let attributes = chatLayout.layoutAttributesForItem(at: path) else { return nil }
        return .init(followsLatest: false, entryID: id,
            minY: Double(attributes.frame.minY - chatLayout.visibleBounds.minY))
    }

    private func save() { if let value = position() { input.onSave(value) } }

    private func publish() {
        guard !publishing else { return }
        publishing = true
        // Coalesce SwiftUI presentation updates outside UIKit's layout callback.
        // Offsets/frames stay native; only Boolean transitions enter SwiftUI.
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.detached, self.input.handle.owner == self.owner else { return }
            self.publishing = false
            if self.input.handle.hasNewMessagesBelow != self.unreadBelow {
                self.input.handle.hasNewMessagesBelow = self.unreadBelow
            }
            let show = self.placed && self.geometry.showsJump(hasMessages: self.input.ids.contains { $0 != "__history__" },
                keyboardVisible: self.keyboardVisible || self.input.keyboard.isVisible,
                keyboardChanging: self.keyboardChanging || self.input.keyboard.isChanging)
            if self.reportedJump != show {
                self.reportedJump = show
                self.input.handle.showsJump = show
                Self.log.info("event=jump-presentation show=\(show) remaining=\(self.geometry.remaining) keyboardVisible=\(self.keyboardVisible) keyboardChanging=\(self.keyboardChanging)")
            }
            let top = self.placed && self.geometry.offset <= self.geometry.minimum + 80
            let underfilled = self.placed && self.geometry.maximum <= self.geometry.minimum + 0.5
            if self.nearTop != top || self.nearTopUser != self.userScrolling || self.wasUnderfilled != underfilled {
                self.nearTop = top
                self.nearTopUser = self.userScrolling
                self.wasUnderfilled = underfilled
                self.input.onNearTop(top, self.userScrolling, underfilled)
            }
            let composerHeight = max(0, self.view.bounds.maxY - self.composerHost.view.frame.minY)
            if abs(self.input.handle.composerHeight - composerHeight) > 0.5 {
                self.input.handle.composerHeight = composerHeight
            }
            guard self.input.tracksVisibleFrames else { return }
            var frames: [String: CGRect] = [:]
            for path in self.collection.indexPathsForVisibleItems {
                guard let id = self.dataSource.itemIdentifier(for: path),
                      let attributes = self.chatLayout.layoutAttributesForItem(at: path) else { continue }
                frames[id] = attributes.frame.offsetBy(dx: -self.collection.contentOffset.x,
                    dy: -self.collection.contentOffset.y)
            }
            self.input.onVisibleFrames(frames, self.collection.bounds.size)
        }
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        intentRevision &+= 1
        input.onUserInteraction()
        userScrolling = true
        pendingRestore = nil
        settledRestore = nil
        resizeAnchor = nil
    }
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if userScrolling && !keyboardChanging && !input.keyboard.isChanging && !reconciling && !updatingInsets {
            following = geometry.isAtBottom
            if following { unreadBelow = false }
            chatLayout.keepContentOffsetAtBottomOnBatchUpdates = following
        }
        publish()
    }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { endInteraction() }
    }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { endInteraction() }
    private func endInteraction() {
        userScrolling = false
        reconcileLayout()
        save()
    }

    func detach() {
        save()
        detached = true
        keyboardObservers.removeAll()
        collection.afterLayout = nil
        collection.allowsAnimatedLayout = nil
        collection.delegate = nil
        if input.handle.owner == owner {
            input.handle.owner = nil
            input.handle.jump = nil
            input.handle.scrollToEntry = nil
            input.handle.currentPosition = nil
            input.handle.scrollbarInteraction = nil
        }
    }
}


/// Native post-layout callback, not an offset observer rebuilding the page.
@MainActor private final class TimelineCollectionView: UICollectionView {
    var afterLayout: (() -> Void)?
    var allowsAnimatedLayout: (() -> Bool)?
    override func layoutSubviews() {
        if allowsAnimatedLayout?() == true {
            // Keep UIKit's system keyboard transaction intact.
            super.layoutSubviews()
            afterLayout?()
        } else {
            // Self-sizing corrections are geometry, not a visual transition.
            // Suppress cell frame animations only, not UIScrollView's native
            // dragging, deceleration or whole-list rubber-band movement.
            UIView.performWithoutAnimation {
                super.layoutSubviews()
                afterLayout?()
            }
        }
    }
}

/// UIKit applies attributes outside layoutSubviews too. Prevent an ambient
/// UIView transaction from interpolating different rows' positions/heights.
@MainActor private final class TimelineCell: UICollectionViewCell {
    var allowsAnimatedLayout: (() -> Bool)?
    override func action(for layer: CALayer, forKey event: String) -> (any CAAction)? {
        if layer === self.layer, (event == "position" || event == "bounds"),
           allowsAnimatedLayout?() != true {
            return NSNull()
        }
        return super.action(for: layer, forKey: event)
    }
}
