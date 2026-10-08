import SwiftUI
import UIKit
import Observation

/// Isolated candidate sharing only the presentation contract, not ChatLayout.
/// Frame observations never feed back into row sizes or scroll offset loops.
struct PadStandardTimeline<Row: View, Composer: View>: View {
    let input: PadNativeTimeline<Row, Composer>
    let contentRevision: UInt64
    @State private var position = ScrollPosition(idType: String.self)
    @State private var policy = PadStandardTimelinePolicy()
    @State private var metrics = StandardTimelineMetrics()
    @State private var placed = false
    @State private var pendingRestore: PadTimelineReadingPosition?
    @State private var owner = UUID()
    @State private var reader = StandardTimelineReader()
    private let coordinate = "standard-timeline-viewport"

    var body: some View {
        GeometryReader { viewport in
            ScrollView(.vertical) {
                LazyVStack(spacing: PadTimelineLayoutMetrics.rowSpacing) {
                    ForEach(input.ids, id: \.self) { id in
                        input.row(id, max(1, viewport.size.width - 2 * PadTimelineLayoutMetrics.horizontalMargin))
                            .frame(width: max(1, viewport.size.width - 2 * PadTimelineLayoutMetrics.horizontalMargin))
                            .background {
                                GeometryReader { geometry in
                                    Color.clear.preference(key: StandardTimelineFrames.self,
                                        value: [id: geometry.frame(in: .named(coordinate))])
                                }
                            }
                            .padding(.bottom, id == input.ids.last ? 8 : 0)
                            .id(id)
                    }
                }
                .scrollTargetLayout()
                .frame(width: viewport.size.width)
                .padding(.top, PadTimelineLayoutMetrics.verticalPadding)
                .background(StandardTimelineScrollAttachment(onResolve: { scroll in
                    reader.scroll = scroll
                    input.onScrollView(scroll)
                }, onLayout: {
                    if reader.awaitingKeyboardLayout {
                        reader.awaitingKeyboardLayout = false
                        diagnose("keyboard-first-layout")
                    }
                }))
            }
            .accessibilityIdentifier("conversation-timeline")
            .scrollPosition($position, anchor: .bottom)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .alignment)
            .defaultScrollAnchor(policy.followsLatest ? .bottom : nil, for: .sizeChanges)
            .contentMargins(.top, input.topOverlayHeight, for: .scrollContent)
            .scrollIndicators(.hidden)
            .scrollClipDisabled()
            .scrollDismissesKeyboard(.interactively)
            .coordinateSpace(name: coordinate)
            .onScrollGeometryChange(for: CGSize.self) { geometry in
                CGSize(width: geometry.contentSize.height, height: geometry.containerSize.height)
            } action: { _, _ in
                diagnose("layout", limited: true)
                bindFollowingTail(force: true)
            }
            .onScrollGeometryChange(for: StandardTimelineMetrics.self) { geometry in
                return .init(size: geometry.containerSize, top: input.topOverlayHeight,
                    nearTop: geometry.contentOffset.y <= -geometry.contentInsets.top + 80,
                    atBottom: PadStandardTimelinePolicy.bottomReached(
                        visibleBottom: geometry.visibleRect.maxY, contentHeight: geometry.contentSize.height),
                    underfilled: geometry.contentSize.height <= geometry.containerSize.height
                        - geometry.contentInsets.top - geometry.contentInsets.bottom + 1)
            } action: { _, value in
                diagnose("geometry-before")
                metrics = value; reader.readingRect = value.readingRect
                var next = policy
                next.observeBottom(value.atBottom, keyboardChanging: input.keyboard.isChanging)
                if next != policy { policy = next }
                if value.atBottom { bindFollowingTail() }
                input.onNearTop(value.nearTop, policy.interacting, value.underfilled)
                publishPresentation()
                diagnose("geometry-after")
            }
            .onScrollPhaseChange { _, phase, context in
                diagnose("phase-\(String(describing: phase))-before")
                if phase == .interacting {
                    pendingRestore = nil
                    policy.beginInteraction(bottom: PadStandardTimelinePolicy.bottomReached(
                        visibleBottom: context.geometry.visibleRect.maxY,
                        contentHeight: context.geometry.contentSize.height))
                    input.onUserInteraction()
                } else if phase == .idle {
                    policy.endInteraction(bottom: PadStandardTimelinePolicy.bottomReached(
                        visibleBottom: context.geometry.visibleRect.maxY,
                        contentHeight: context.geometry.contentSize.height),
                        keyboardChanging: input.keyboard.isChanging)
                    save()
                    bindFollowingTail()
                }
                input.onNearTop(metrics.nearTop, policy.interacting, metrics.underfilled)
                publishPresentation()
                diagnose("phase-\(String(describing: phase))-after")
            }
            // Observe the message scroll view before inserting the composer,
            // which contains its own horizontal quick-message scroll view.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                input.composer.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                    if abs(input.handle.composerHeight - height) > 0.5 { input.handle.composerHeight = height }
                }
            }
            .onPreferenceChange(StandardTimelineFrames.self) { frames in
                reader.frames = frames
                finishRestorationIfRealized(); publishPresentation()
                if input.tracksVisibleFrames { input.onVisibleFrames(frames, metrics.size) }
            }
            .onChange(of: input.ready, initial: true) { _, ready in
                guard ready, !placed else { return }
                placed = true; policy.begin(saved: input.savedPosition)
                pendingRestore = input.savedPosition?.followsLatest == false ? input.savedPosition : nil
                withoutAnimation {
                    if let id = pendingRestore?.entryID { position.scrollTo(id: id, anchor: .top) }
                }
                diagnose("ready")
                bindFollowingTail()
            }
            .onChange(of: contentRevision) {
                policy.contentChanged(); publishPresentation(); diagnose("content", limited: true)
            }
            .onChange(of: input.keyboard) {
                diagnose("keyboard-before")
                policy.observeBottom(metrics.atBottom, keyboardChanging: input.keyboard.isChanging)
                attach(); publishPresentation()
                bindFollowingTail(force: true)
                diagnose("keyboard-after")
                // This is explicitly a next-runloop sample, not proof of layout completion.
                if !input.keyboard.isChanging {
                    reader.awaitingKeyboardLayout = true
                    DispatchQueue.main.async { diagnose("keyboard-next-runloop") }
                }
            }
            .onChange(of: input.ids) { previous, current in
                attach()
                // Rebind a previous explicit ID target when a new tail arrives.
                // Same-ID streaming growth continues using the system size anchor.
                if previous.last != current.last, policy.followsLatest, !policy.interacting,
                   let tail = current.last {
                    withoutAnimation { position.scrollTo(id: tail, anchor: .bottom) }
                }
                diagnose("message-ids-changed", limited: true)
            }
            .onChange(of: policy) { old, _ in
                diagnose("policy-changed", previous: old)
            }
            .onAppear { attach(); diagnose("appear") }
            .onDisappear { diagnose("disappear"); save(); detach() }
        }
    }
    private func publishPresentation() {
        let show = placed && policy.showsJump(hasMessages: input.ids.contains { $0 != "__history__" },
            keyboardVisible: input.keyboard.isVisible, keyboardChanging: input.keyboard.isChanging)
        if input.handle.showsJump != show { input.handle.showsJump = show }
        if input.handle.hasNewMessagesBelow != policy.unreadBelow { input.handle.hasNewMessagesBelow = policy.unreadBelow }
    }
    private func attach() {
        input.handle.owner = owner
        input.handle.jump = {
            diagnose("jump-before")
            pendingRestore = nil; policy.jump()
            // An explicit jump owns the viewport immediately, even during a
            // finger drag or inertia. Stop native motion before ScrollPosition
            // takes over; otherwise the ongoing gesture can discard the request.
            if let scroll = reader.scroll {
                scroll.panGestureRecognizer.isEnabled = false
                scroll.panGestureRecognizer.isEnabled = true
                scroll.setContentOffset(scroll.contentOffset, animated: false)
            }
            withoutAnimation {
                if let tail = input.ids.last { position.scrollTo(id: tail, anchor: .bottom) }
            }
            publishPresentation()
            diagnose("jump-after")
        }
        input.handle.scrollToEntry = { id in
            pendingRestore = nil; policy.restored()
            withoutAnimation { position.scrollTo(id: id, anchor: .top) }
        }
        input.handle.scrollToOffset = { offset in
            pendingRestore = nil; policy.restored()
            withoutAnimation { position.scrollTo(y: offset + (reader.scroll?.adjustedContentInset.top ?? 0)) }
        }
        input.handle.currentPosition = { readingPosition() }
        input.handle.scrollbarInteraction = { active in
            if active { pendingRestore = nil; policy.beginInteraction(); input.onUserInteraction() }
            else { policy.endInteraction(); save() }
        }
    }
    private func detach() {
        guard input.handle.owner == owner else { return }
        input.handle.owner = nil; input.handle.jump = nil; input.handle.scrollToEntry = nil
        input.handle.scrollToOffset = nil
        input.handle.currentPosition = nil; input.handle.scrollbarInteraction = nil
    }
    private func bindFollowingTail(force: Bool = false) {
        guard placed, policy.followsLatest, !policy.interacting, !policy.restoring,
              pendingRestore == nil, let tail = input.ids.last,
              force || position.viewID as? String != tail else { return }
        // Bind the actual last row at its bottom; edge positioning includes
        // safe-area insets differently and overscrolls this transparent layout.
        position.scrollTo(id: tail, anchor: .bottom)
        diagnose("following-tail-bound")
    }
    private func readingPosition() -> PadTimelineReadingPosition? {
        guard placed, !policy.restoring else { return nil }
        if policy.followsLatest { return .init(followsLatest: true, entryID: nil, minY: 0) }
        guard let entry = reader.frames.filter({ $0.key != "__history__" && $0.value.intersects(reader.readingRect) })
            .min(by: { $0.value.minY < $1.value.minY }) else { return nil }
        return .init(followsLatest: false, entryID: entry.key,
            minY: Double(entry.value.minY - reader.readingRect.minY))
    }
    private func save() { if let bookmark = readingPosition() { input.onSave(bookmark) } }
    private func finishRestorationIfRealized() {
        guard let bookmark = pendingRestore, let id = bookmark.entryID, let frame = reader.frames[id],
              metrics.readingRect.height > 0 else { return }
        // One alignment after ID realization, never continuous anchor correction.
        pendingRestore = nil
        if let anchor = PadStandardTimelinePolicy.restorationAnchor(minY: CGFloat(bookmark.minY),
            viewportHeight: metrics.readingRect.height, rowHeight: frame.height) {
            withoutAnimation { position.scrollTo(id: id, anchor: UnitPoint(x: 0.5, y: anchor)) }
        }
        policy.restored()
        diagnose("restoration-completed")
    }
    private func diagnose(_ event: String, limited: Bool = false,
                          previous: PadStandardTimelinePolicy? = nil) {
        #if DEBUG
        let now = ProcessInfo.processInfo.systemUptime
        if limited {
            guard now - reader.lastDiagnosticSample >= 0.5 else { return }
            reader.lastDiagnosticSample = now
        }
        var flags = ["followsLatest": policy.followsLatest, "atBottom": policy.atBottom,
            "interacting": policy.interacting, "restoring": policy.restoring,
            "keyboardVisible": input.keyboard.isVisible, "keyboardChanging": input.keyboard.isChanging,
            "positionedByUser": position.isPositionedByUser, "hasEdge": position.edge != nil,
            "hasPoint": position.point != nil, "hasViewID": position.viewID != nil,
            "pendingRestore": pendingRestore != nil, "placed": placed]
        if let previous {
            flags["previousFollowsLatest"] = previous.followsLatest
            flags["previousAtBottom"] = previous.atBottom
            flags["previousInteracting"] = previous.interacting
            flags["previousRestoring"] = previous.restoring
        }
        var numbers: [String: Double] = ["composerHeight": Double(input.handle.composerHeight),
            "containerHeight": Double(metrics.size.height), "messageCount": Double(input.ids.count)]
        if let scroll = reader.scroll {
            let insets = scroll.adjustedContentInset
            numbers["boundsHeight"] = Double(scroll.bounds.height)
            numbers["offsetY"] = Double(scroll.contentOffset.y)
            numbers["contentHeight"] = Double(scroll.contentSize.height)
            numbers["insetTop"] = Double(insets.top)
            numbers["insetBottom"] = Double(insets.bottom)
            numbers["visibleTop"] = Double(scroll.contentOffset.y + insets.top)
            numbers["visibleBottom"] = Double(scroll.contentOffset.y + scroll.bounds.height - insets.bottom)
            numbers["bottomGap"] = Double(scroll.contentSize.height - scroll.contentOffset.y - scroll.bounds.height + insets.bottom)
            flags["nativeDragging"] = scroll.isDragging
            flags["nativeDecelerating"] = scroll.isDecelerating
        }
        PadTimelineDiagnosticLog.shared.append(.init(event: event, page: owner, flags: flags,
            numbers: numbers.filter { $0.value.isFinite }))
        #endif
    }
    private func withoutAnimation(_ action: () -> Void) {
        var transaction = Transaction(animation: nil); transaction.disablesAnimations = true
        withTransaction(transaction, action)
    }
}
private struct StandardTimelineMetrics: Equatable {
    var size: CGSize = .zero
    var top: CGFloat = 0
    var nearTop = false
    var atBottom = true
    var underfilled = false
    var readingRect: CGRect {
        // ScrollGeometry.containerSize already excludes the scroll insets.
        // Its height must not have the header subtracted a second time.
        CGRect(x: 0, y: top, width: size.width, height: max(0, size.height))
    }
}
@MainActor @Observable private final class StandardTimelineReader {
    @ObservationIgnored var lastDiagnosticSample: TimeInterval = 0
    @ObservationIgnored var awaitingKeyboardLayout = false
    @ObservationIgnored var frames: [String: CGRect] = [:]
    @ObservationIgnored var readingRect = CGRect.zero
    @ObservationIgnored weak var scroll: UIScrollView?
}
private struct StandardTimelineFrames: PreferenceKey {
    static var defaultValue: [String: CGRect] { [:] }
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}
/// Passive read-only attachment for the existing drag-only scrollbar.
private struct StandardTimelineScrollAttachment: UIViewRepresentable {
    let onResolve: (UIScrollView) -> Void
    let onLayout: () -> Void
    func makeUIView(context: Context) -> Attachment {
        let view = Attachment(); view.onResolve = onResolve; view.onLayout = onLayout; return view
    }
    func updateUIView(_ view: Attachment, context: Context) {
        view.onResolve = onResolve; view.onLayout = onLayout
    }
    final class Attachment: UIView {
        var onResolve: ((UIScrollView) -> Void)?
        var onLayout: (() -> Void)?
        private weak var resolved: UIScrollView?
        override func didMoveToWindow() { super.didMoveToWindow(); resolve() }
        override func layoutSubviews() { super.layoutSubviews(); resolve(); onLayout?() }
        private func resolve() {
            guard resolved == nil, window != nil else { return }
            var parent = superview
            while let view = parent {
                if let scroll = view as? UIScrollView, !(scroll is UITextView) {
                    resolved = scroll
                    DispatchQueue.main.async { [weak self, weak scroll] in
                        if let scroll { self?.onResolve?(scroll) }
                    }
                    return
                }
                parent = view.superview
            }
        }
    }
}
