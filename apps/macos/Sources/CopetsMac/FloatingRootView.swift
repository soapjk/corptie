import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct FloatingRootView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @EnvironmentObject private var panelLayoutState: PanelLayoutState
    @EnvironmentObject private var detachedSessionManager: DetachedSessionManager
    @StateObject private var newSessionPanel = NewSessionPanelController()
    @State private var isShowingActionMenu = false
    @State private var draggedSessionId: String?
    @State private var sessionCardFrames: [String: CGRect] = [:]
    @State private var sessionSummaryFrames: [String: CGRect] = [:]
    @State private var reorderStartFirstCardMinY: CGFloat?
    @State private var reorderDragOffsetY: CGFloat = 0
    @State private var reorderTargetSessionId: String?
    @State private var hasResolvedReorderTarget = false
    @State private var hoverPreviewSessionId: String?
    @State private var isHoveringReplyPreviewBubble = false
    @State private var hoverPreviewCloseTask: Task<Void, Never>?
    @State private var detailPreheatTasks: [String: Task<Void, Never>] = [:]
    @State private var detailDisplayCacheBySessionId: [String: DetailDisplayCache] = [:]
    private let panelContentPadding: CGFloat = 14
    private let sessionListHorizontalInset: CGFloat = 4
    private let panelControlLeadingInset: CGFloat = 6
    private let topBarControlTopInset: CGFloat = 6
    private let closeButtonLeadingInset: CGFloat = 12

    var body: some View {
        ZStack {
            LiquidGlassPanelBackground(cornerRadius: 26)
            WindowDragArea()
                .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))

            VStack(alignment: .leading, spacing: 14) {
                if let selectedSession = backendClient.selectedSession {
                    DetailView(
                        sessionId: selectedSession.id,
                        preheatedDisplayCache: detailDisplayCacheBySessionId[selectedSession.id]
                    )
                        .transition(.opacity)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        if backendClient.isOnline {
                            if backendClient.sessions.isEmpty {
                                ReadyEmptyView()
                                    .measureListHeight(.cards)
                            } else {
                                sessionListView
                            }
                        } else {
                            OfflineView(error: backendClient.lastError)
                                .measureListHeight(.cards)
                        }
                    }
                    .onPreferenceChange(ListHeightPreferenceKey.self) { values in
                        updatePreferredListHeight(values)
                    }
                    .transition(.opacity)
                }
            }
            .padding(panelContentPadding)

            if backendClient.selectedSession == nil && !newSessionPanel.isPresented {
                FloatingActionMenu(
                    isExpanded: $isShowingActionMenu,
                    isBusy: backendClient.isCreatingTask,
                    createTask: {
                        withAnimation(.spring(response: 0.28, dampingFraction: 0.88)) {
                            isShowingActionMenu = false
                        }
                        newSessionPanel.show(backendClient: backendClient)
                    }
                )
                .padding(.leading, panelControlLeadingInset)
                .padding(.bottom, panelContentPadding)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                .zIndex(1)
            }

            HoverRevealCloseButton()
                .padding(.top, topBarControlTopInset)
                .padding(.leading, closeButtonLeadingInset)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .zIndex(0)
        }
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .animation(.easeOut(duration: 0.18), value: backendClient.selectedSession?.id)
        .animation(.spring(response: 0.28, dampingFraction: 0.88), value: newSessionPanel.isPresented)
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12 + 0.1 * glassStrength), lineWidth: 1)
        )
        .overlay(alignment: .topTrailing) {
            if CorptieAppEnvironment.isDevelopment {
                EnvironmentModeBadge()
                    .padding(.top, 10)
                    .padding(.trailing, 10)
                    .zIndex(4)
            }
        }
        .frame(minWidth: 360, idealWidth: 420, maxWidth: .infinity, minHeight: 148, idealHeight: 410, maxHeight: .infinity)
        .onChange(of: backendClient.selectedSession?.id) { _, _ in
            isShowingActionMenu = false
            newSessionPanel.close()
        }
    }

    private var glassStrength: Double {
        0.55
    }

    private var sessionListView: some View {
        NativeSessionScrollView {
            LazyVStack(spacing: PanelLayoutState.cardSpacing) {
                ForEach(backendClient.sessions) { session in
                    sessionCard(for: session)
                }
            }
            .frame(minHeight: sessionCardsContentHeight, alignment: .top)
            .fixedSize(horizontal: false, vertical: true)
            .animation(draggedSessionId == nil ? .spring(response: 0.30, dampingFraction: 0.84) : nil, value: backendClient.sessions.map(\.id))
            .padding(.horizontal, sessionListHorizontalInset)
            .padding(.bottom, 4)
            .measureListHeight(.cards)
        }
        .coordinateSpace(name: "session-list")
        .overlay(alignment: .topLeading) {
            sessionHoverPreviewOverlay
        }
        .onPreferenceChange(SessionCardFramePreferenceKey.self) { frames in
            guard draggedSessionId == nil else {
                return
            }
            sessionCardFrames = frames
            updateMeasuredListHeights(cardFrames: frames)
        }
        .onPreferenceChange(SessionSummaryFramePreferenceKey.self) { frames in
            guard draggedSessionId == nil else {
                return
            }
            sessionSummaryFrames = frames
        }
        .onChange(of: backendClient.sessions) { _, _ in
            guard draggedSessionId == nil else {
                return
            }
            updateMeasuredListHeights(cardFrames: sessionCardFrames)
        }
        .onChange(of: backendClient.selectedSession?.id) { _, _ in
            updateMeasuredListHeights(cardFrames: sessionCardFrames)
        }
    }

    private var sessionCardsContentHeight: CGFloat {
        let count = backendClient.sessions.count
        guard count > 0 else {
            return 0
        }
        return CGFloat(count) * PanelLayoutState.cardHeight
            + CGFloat(max(0, count - 1)) * PanelLayoutState.cardSpacing
    }

    @ViewBuilder
    private func sessionCard(for session: TaskSession) -> some View {
        if backendClient.isShowingArchivedSessions {
            TaskCardView(session: session, hoverPreviewChanged: updateHoverPreview, preheatRequested: preheatDetail)
                .fixedSessionCardHeight()
        } else {
            TaskCardView(
                session: session,
                hoverPreviewChanged: { sessionId, isVisible in
                    guard draggedSessionId == nil else {
                        return
                    }
                    updateHoverPreview(sessionId: sessionId, isVisible: isVisible)
                },
                preheatRequested: { session in
                    guard draggedSessionId == nil else {
                        return
                    }
                    preheatDetail(for: session)
                }
            )
                .fixedSessionCardHeight()
                .opacity(draggedSessionId == session.id ? 0.82 : 1)
                .scaleEffect(draggedSessionId == session.id ? 1.015 : 1)
                .measureSessionCardFrame(session.id)
                .offset(y: draggedSessionId == session.id ? reorderDragOffsetY : 0)
                .gesture(reorderGesture(for: session))
                .animation(draggedSessionId == nil ? .spring(response: 0.28, dampingFraction: 0.82) : nil, value: backendClient.sessions.map(\.id))
                .animation(.spring(response: 0.20, dampingFraction: 0.78), value: draggedSessionId)
        }
    }

    @ViewBuilder
    private var sessionHoverPreviewOverlay: some View {
        if let session = backendClient.sessions.first(where: { $0.id == hoverPreviewSessionId }),
           let frame = sessionSummaryFrames[session.id] {
            SessionReplyHoverBubble(text: session.summary, showsArrow: true)
                .frame(width: 248, alignment: .topLeading)
                .frame(maxHeight: 92, alignment: .topLeading)
                .offset(x: clampedHoverBubbleX(for: frame), y: max(0, frame.minY - 96))
                .zIndex(30)
                .onHover { hovering in
                    isHoveringReplyPreviewBubble = hovering
                    if !hovering {
                        hoverPreviewCloseTask?.cancel()
                        hoverPreviewSessionId = nil
                    }
                }
        }
    }

    private func updateHoverPreview(sessionId: String, isVisible: Bool) {
        hoverPreviewCloseTask?.cancel()
        hoverPreviewCloseTask = nil

        if isVisible {
            hoverPreviewSessionId = sessionId
            return
        }

        guard hoverPreviewSessionId == sessionId else {
            return
        }

        hoverPreviewCloseTask = Task {
            try? await Task.sleep(nanoseconds: 180_000_000)
            guard !Task.isCancelled else {
                return
            }
            await MainActor.run {
                if !isHoveringReplyPreviewBubble {
                    hoverPreviewSessionId = nil
                }
            }
        }
    }

    private func preheatDetail(for session: TaskSession) {
        guard detailPreheatTasks[session.id] == nil else {
            return
        }

        if let cachedDetail = backendClient.cachedDetail(for: session.id) {
            detailDisplayCacheBySessionId[session.id] = makeDetailDisplayCache(
                for: cachedDetail,
                sessionId: session.id,
                visibleMessageLimit: DetailView.initialVisibleMessageLimit
            )
            return
        }

        detailPreheatTasks[session.id] = Task {
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard !Task.isCancelled else {
                return
            }
            let detail = await backendClient.fetchDetail(for: session)
            await MainActor.run {
                detailPreheatTasks[session.id] = nil
                guard let detail else {
                    return
                }
                detailDisplayCacheBySessionId[session.id] = makeDetailDisplayCache(
                    for: detail,
                    sessionId: session.id,
                    visibleMessageLimit: DetailView.initialVisibleMessageLimit
                )
            }
        }
    }

    private func clampedHoverBubbleX(for anchorFrame: CGRect) -> CGFloat {
        let bubbleWidth: CGFloat = 248
        let horizontalInset: CGFloat = 8
        let proposed = anchorFrame.midX - bubbleWidth / 2
        let measuredRightEdge = sessionCardFrames.values.map(\.maxX).max() ?? (anchorFrame.maxX + horizontalInset)
        let maxX = max(horizontalInset, measuredRightEdge - bubbleWidth - horizontalInset)
        return min(max(horizontalInset, proposed), maxX)
    }

    private func updatePreferredListHeight(_ values: [ListHeightMetric: CGFloat]) {
        let cardsHeight = values[.cards] ?? 0
        guard cardsHeight > 0 else {
            return
        }

        let outerPadding = panelContentPadding * 2
        let usefulHeight = outerPadding + cardsHeight
            + PanelLayoutState.listBottomPadding
            + PanelLayoutState.bottomBreathingRoom

        DispatchQueue.main.async {
            panelLayoutState.updateMeasuredListHeights(preferred: nil, useful: usefulHeight)
        }
    }

    private func updateMeasuredListHeights(cardFrames: [String: CGRect]) {
        let visibleSessions = Array(backendClient.sessions.prefix(3))
        let visibleHeights = visibleSessions.compactMap { session in
            cardFrames[session.id]?.height
        }
        guard !visibleHeights.isEmpty else {
            return
        }

        let outerPadding = panelContentPadding * 2
        let leadingSessions = Array(backendClient.sessions.prefix(2))
        let leadingHeights = leadingSessions.compactMap { session in
            cardFrames[session.id]?.height
        }
        let shouldFitLeadingCards = leadingSessions.contains { session in
            !(session.suggestedOptions ?? []).isEmpty
        }
        let minimumCardHeights = shouldFitLeadingCards && leadingHeights.count == leadingSessions.count
            ? leadingHeights
            : [visibleHeights.first ?? PanelLayoutState.cardHeight]
        let minimumSpacing = CGFloat(max(0, minimumCardHeights.count - 1)) * PanelLayoutState.cardSpacing
        let listBottomPadding = PanelLayoutState.listBottomPadding + PanelLayoutState.bottomBreathingRoom
        let minimumHeight = outerPadding + minimumCardHeights.reduce(0, +) + minimumSpacing + listBottomPadding
        let visibleSpacing = CGFloat(max(0, visibleHeights.count - 1)) * PanelLayoutState.cardSpacing
        let preferredHeight = outerPadding + visibleHeights.reduce(0, +) + visibleSpacing + listBottomPadding

        DispatchQueue.main.async {
            panelLayoutState.updateMeasuredListHeights(minimum: minimumHeight, preferred: preferredHeight, useful: nil)
        }
    }

    private func reorderGesture(for session: TaskSession) -> some Gesture {
        DragGesture(minimumDistance: 7, coordinateSpace: .named("session-list"))
            .onChanged { value in
                if draggedSessionId != session.id {
                    draggedSessionId = session.id
                    reorderTargetSessionId = nil
                    reorderStartFirstCardMinY = firstVisibleCardMinY(excluding: session.id)
                    hoverPreviewSessionId = nil
                    hasResolvedReorderTarget = false
                    reorderDragOffsetY = 0
                }

                withTransaction(Transaction(animation: nil)) {
                    reorderDragOffsetY = sessionCardFrames[session.id].map { value.location.y - $0.midY }
                        ?? value.translation.height
                }
                guard !sessionCardFrames.isEmpty else {
                    return
                }

                let targetSessionId = insertionTargetSessionId(
                    forDragLocationY: value.location.y,
                    excluding: session.id,
                    using: sessionCardFrames
                )
                guard targetSessionId != reorderTargetSessionId || !hasResolvedReorderTarget else {
                    return
                }

                reorderTargetSessionId = targetSessionId
                hasResolvedReorderTarget = true
                withAnimation(.interactiveSpring(response: 0.22, dampingFraction: 0.88, blendDuration: 0.08)) {
                    backendClient.moveSession(draggedSessionId: session.id, before: targetSessionId)
                }
            }
            .onEnded { _ in
                reorderDragOffsetY = 0
                backendClient.persistSessionOrder()
                withAnimation(.spring(response: 0.24, dampingFraction: 0.86)) {
                    draggedSessionId = nil
                    reorderTargetSessionId = nil
                    reorderStartFirstCardMinY = nil
                    hasResolvedReorderTarget = false
                }
            }
    }

    private func insertionTargetSessionId(forDragLocationY locationY: CGFloat, excluding draggedId: String, using frames: [String: CGRect]) -> String? {
        let orderedIds = backendClient.sessions
            .map(\.id)
            .filter { $0 != draggedId }

        guard let firstId = orderedIds.first,
              let firstFrame = frames[firstId] else {
            return nil
        }

        let firstMinY = reorderStartFirstCardMinY ?? firstFrame.minY
        let rowStride = PanelLayoutState.cardHeight + PanelLayoutState.cardSpacing
        if rowStride > 0 {
            let proposedIndex = Int(((locationY - firstMinY) / rowStride).rounded(.down))
            if proposedIndex <= 0 {
                return firstId
            }
            if proposedIndex >= orderedIds.count {
                return nil
            }
            return orderedIds[proposedIndex]
        }

        if locationY < firstFrame.minY {
            return firstId
        }

        for (index, id) in orderedIds.enumerated() {
            guard let frame = frames[id] else {
                continue
            }
            if locationY <= frame.maxY {
                if locationY < frame.midY {
                    return id
                }
                let nextIndex = index + 1
                return nextIndex < orderedIds.count ? orderedIds[nextIndex] : nil
            }
        }

        return nil
    }

    private func firstVisibleCardMinY(excluding draggedId: String) -> CGFloat? {
        backendClient.sessions
            .map(\.id)
            .filter { $0 != draggedId }
            .compactMap { sessionCardFrames[$0]?.minY }
            .min()
    }

}

private struct HoverRevealCloseButton: View {
    @State private var isHovering = false
    private let hoverProbeSize = CGSize(width: 18, height: 18)

    var body: some View {
        MainPanelCloseButton()
            .opacity(isHovering ? 1 : 0)
            .scaleEffect(isHovering ? 1 : 0.86)
            .animation(.easeOut(duration: 0.12), value: isHovering)
            .frame(width: hoverProbeSize.width, height: hoverProbeSize.height, alignment: .topLeading)
            .contentShape(Rectangle())
            .onHover { hovering in
                isHovering = hovering
            }
    }
}

private struct MainPanelCloseButton: View {
    @State private var isHovering = false

    var body: some View {
        Button {
            NSApp.keyWindow?.orderOut(nil)
        } label: {
            ZStack {
                Circle()
                    .fill(Color(nsColor: NSColor(calibratedRed: 1.0, green: 0.37, blue: 0.32, alpha: 1.0)))
                    .overlay(
                        Circle()
                            .strokeBorder(Color.black.opacity(0.14), lineWidth: 0.5)
                    )

                if isHovering {
                    Image(systemName: "xmark")
                        .font(.system(size: 6.5, weight: .black))
                        .foregroundStyle(Color.black.opacity(0.58))
                }
            }
            .frame(width: 12, height: 12)
        }
        .buttonStyle(.plain)
        .contentShape(Circle())
        .onHover { hovering in
            isHovering = hovering
        }
        .help("Close")
    }
}

private struct EnvironmentModeBadge: View {
    private var modeLabel: String {
        CorptieAppEnvironment.displayName
    }

    private var modeIcon: String {
        CorptieAppEnvironment.isDevelopment ? "hammer.fill" : "sparkles"
    }

    private var modeColor: Color {
        CorptieAppEnvironment.isDevelopment ? CorptiePalette.amber : CorptiePalette.softBlue
    }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: modeIcon)
                .font(.system(size: 10.5, weight: .semibold))
            Text(modeLabel)
                .font(.system(size: 10.5, weight: .semibold, design: .rounded))
        }
        .foregroundStyle(modeColor)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            Capsule()
                .fill(modeColor.opacity(0.16))
                .overlay {
                    Capsule()
                        .stroke(modeColor.opacity(0.42), lineWidth: 0.9)
                }
        )
        .help("Environment: \(modeLabel) (\(CorptieAppEnvironment.backendPort))")
    }
}

private enum ListHeightMetric: Hashable {
    case header
    case cards
}

private struct ListHeightPreferenceKey: PreferenceKey {
    static let defaultValue: [ListHeightMetric: CGFloat] = [:]

    static func reduce(value: inout [ListHeightMetric: CGFloat], nextValue: () -> [ListHeightMetric: CGFloat]) {
        value.merge(nextValue(), uniquingKeysWith: { _, newValue in newValue })
    }
}

private struct SessionCardFramePreferenceKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, newValue in newValue })
    }
}

private struct SessionSummaryFramePreferenceKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, newValue in newValue })
    }
}

private struct LastMessageHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct DetailScrollViewportHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct DetailScrollBottomMaxYPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private extension View {
    func measureListHeight(_ metric: ListHeightMetric) -> some View {
        background(
            GeometryReader { proxy in
                Color.clear.preference(key: ListHeightPreferenceKey.self, value: [metric: proxy.size.height])
            }
        )
    }

    func measureSessionCardFrame(_ id: String) -> some View {
        background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: SessionCardFramePreferenceKey.self,
                    value: [id: proxy.frame(in: .named("session-list"))]
                )
            }
        )
    }

    func measureSessionSummaryFrame(_ id: String) -> some View {
        background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: SessionSummaryFramePreferenceKey.self,
                    value: [id: proxy.frame(in: .named("session-list"))]
                )
            }
        )
    }

    func measureLastMessageHeight(isLast: Bool) -> some View {
        background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: LastMessageHeightPreferenceKey.self,
                    value: isLast ? proxy.size.height : 0
                )
            }
        )
    }

    func fixedSessionCardHeight() -> some View {
        frame(height: PanelLayoutState.cardHeight, alignment: .topLeading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct NativeSessionScrollView<Content: View>: NSViewRepresentable {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = SessionListNSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = false
        scrollView.scrollerStyle = .legacy
        scrollView.verticalScroller?.controlSize = .small
        scrollView.scrollerInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: -2)
        scrollView.borderType = .noBorder
        scrollView.contentView.postsBoundsChangedNotifications = true

        let hostingView = FirstMouseListHostingView(rootView: content)
        hostingView.translatesAutoresizingMaskIntoConstraints = false
        hostingView.wantsLayer = true
        hostingView.layer?.backgroundColor = NSColor.clear.cgColor
        scrollView.documentView = hostingView

        NSLayoutConstraint.activate([
            hostingView.leadingAnchor.constraint(equalTo: scrollView.contentView.leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: scrollView.contentView.trailingAnchor),
            hostingView.topAnchor.constraint(equalTo: scrollView.contentView.topAnchor),
            hostingView.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor)
        ])

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        if let hostingView = scrollView.documentView as? NSHostingView<Content> {
            let nextContent = content
            DispatchQueue.main.async {
                hostingView.rootView = nextContent
            }
        }
        scrollView.hasVerticalScroller = true
        scrollView.scrollerStyle = .legacy
        scrollView.autohidesScrollers = false
        scrollView.verticalScroller?.controlSize = .small
        scrollView.scrollerInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: -2)
        if let sessionScrollView = scrollView as? SessionListNSScrollView {
            sessionScrollView.updateVerticalScrollerVisibility()
        }
    }

    final class SessionListNSScrollView: NSScrollView {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
            true
        }

        override func layout() {
            super.layout()
            updateVerticalScrollerVisibility()
        }

        func updateVerticalScrollerVisibility() {
            let contentHeight = documentView?.fittingSize.height ?? documentView?.bounds.height ?? 0
            let viewportHeight = contentView.bounds.height
            let shouldShowScroller = contentHeight > viewportHeight + 1

            if hasVerticalScroller != shouldShowScroller {
                hasVerticalScroller = shouldShowScroller
            }
            verticalScroller?.isHidden = !shouldShowScroller
        }
    }

    final class FirstMouseListHostingView<HostedContent: View>: NSHostingView<HostedContent> {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
            true
        }
    }
}

private struct LiquidGlassPanelBackground: View {
    @EnvironmentObject private var panelFocusState: PanelFocusState
    let cornerRadius: CGFloat

    var body: some View {
        if #available(macOS 26.0, *) {
            ZStack {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(.clear)
                    .glassEffect(.clear, in: .rect(cornerRadius: cornerRadius))

                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .opacity(isFocused ? 0.34 : 0.14)

                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(isFocused ? CorptiePalette.glassVeilFocused : CorptiePalette.glassVeilIdle)
                    .opacity(isFocused ? 0.38 : 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .animation(.easeInOut(duration: 0.18), value: isFocused)
        } else {
            VisualEffectView(material: .popover, blendingMode: .behindWindow)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
    }

    private var isFocused: Bool {
        panelFocusState.isFocused
    }
}

private struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> DragView {
        DragView()
    }

    func updateNSView(_ nsView: DragView, context: Context) {}

    final class DragView: NSView {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
            true
        }

        override func hitTest(_ point: NSPoint) -> NSView? {
            bounds.contains(point) ? self : nil
        }

        override func mouseDragged(with event: NSEvent) {
            window?.performDrag(with: event)
        }
    }
}

@MainActor
private final class NewSessionPanelController: NSObject, ObservableObject, NSWindowDelegate {
    @Published var isPresented = false
    private var panel: NSPanel?

    func show(backendClient: BackendClient) {
        if let panel {
            panel.makeKeyAndOrderFront(nil)
            panel.orderFrontRegardless()
            NSApp.activate(ignoringOtherApps: true)
            isPresented = true
            return
        }

        let parentFrame = NSApp.keyWindow?.frame ?? NSRect(x: 960, y: 560, width: 420, height: 360)
        let size = NSSize(width: 420, height: 620)
        let origin = NSPoint(
            x: parentFrame.midX - size.width / 2,
            y: max(80, parentFrame.midY - size.height / 2)
        )
        let nextPanel = FloatingPanel(
            contentRect: NSRect(origin: origin, size: size),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        nextPanel.isFloatingPanel = true
        nextPanel.level = .floating
        nextPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        nextPanel.isOpaque = false
        nextPanel.backgroundColor = .clear
        nextPanel.hasShadow = true
        nextPanel.hidesOnDeactivate = false
        nextPanel.isMovableByWindowBackground = false
        nextPanel.delegate = self

        let rootView = NewPtyAgentTaskSheet { [weak self] in
            self?.close()
        }
        .environmentObject(backendClient)
        .padding(18)
        .frame(width: size.width, height: size.height)

        let hostingView = NSHostingView(rootView: rootView)
        hostingView.translatesAutoresizingMaskIntoConstraints = false
        hostingView.wantsLayer = true
        hostingView.layer?.backgroundColor = NSColor.clear.cgColor
        hostingView.layer?.cornerRadius = 26
        hostingView.layer?.cornerCurve = .continuous
        hostingView.layer?.masksToBounds = true
        nextPanel.contentView = hostingView

        panel = nextPanel
        isPresented = true
        nextPanel.makeKeyAndOrderFront(nil)
        nextPanel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() {
        panel?.orderOut(nil)
        panel = nil
        isPresented = false
    }

    nonisolated func windowWillClose(_ notification: Notification) {
        Task { @MainActor in
            self.panel = nil
            self.isPresented = false
        }
    }
}

private struct FloatingActionMenu: View {
    @Binding var isExpanded: Bool
    let isBusy: Bool
    let createTask: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if isExpanded {
                actionButton(
                    title: "New Session",
                    systemImage: "plus.circle.fill",
                    isDisabled: isBusy,
                    help: "Create new agent task",
                    action: createTask
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            toggleButton
        }
        .animation(.spring(response: 0.24, dampingFraction: 0.86), value: isExpanded)
    }

    @ViewBuilder
    private var toggleButton: some View {
        orbLabel
            .background(FloatingActionOrb())
            .contentShape(Circle())
            .opacity(isBusy ? 0.55 : 1)
            .onTapGesture {
                guard !isBusy else { return }
                toggleMenu()
            }
            .help(isExpanded ? "Close actions" : "Open actions")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(isExpanded ? "Close actions" : "Open actions")
            .accessibilityAddTraits(.isButton)
    }

    private var orbLabel: some View {
        ZStack {
            if isBusy {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: isExpanded ? "xmark" : "plus")
                    .font(.system(size: 13, weight: .semibold))
            }
        }
        .frame(width: 32, height: 32)
        .foregroundStyle(CorptiePalette.primaryText)
        .contentShape(Circle())
    }

    private func toggleMenu() {
        withAnimation(.spring(response: 0.24, dampingFraction: 0.84)) {
            isExpanded.toggle()
        }
    }

    private func actionButton(
        title: String,
        systemImage: String,
        isDisabled: Bool,
        help: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.system(size: 13, weight: .bold))
                Text(title)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
            }
            .foregroundStyle(CorptiePalette.primaryText)
            .padding(.horizontal, 11)
            .frame(height: 34)
            .background(FloatingActionSurface(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .help(help)
    }
}

private struct FloatingActionSurface: View {
    let cornerRadius: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(.regularMaterial)
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Color.white.opacity(0.34))
            )
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.42), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.14), radius: 14, y: 7)
    }
}

private struct FloatingActionOrb: View {
    var body: some View {
        if #available(macOS 26.0, *) {
            Circle()
                .fill(.clear)
                .glassEffect(.clear, in: .circle)
        } else {
            Circle()
                .fill(.clear)
                .background(.ultraThinMaterial, in: Circle())
                .opacity(0.42)
        }
    }
}

private struct NewPtyAgentTaskSheet: View {
    @EnvironmentObject private var backendClient: BackendClient
    @AppStorage("newTask.defaultSandboxMode", store: CorptieAppEnvironment.userDefaults) private var defaultSandboxMode = "workspace-write"
    @AppStorage("newTask.defaultApprovalPolicy", store: CorptieAppEnvironment.userDefaults) private var defaultApprovalPolicy = "on-request"
    @State private var title = "Agent"
    @State private var command = "codex"
    @State private var arguments = ""
    @State private var existingSessionId = ""
    @State private var cwd = ""
    @State private var sandboxMode = "workspace-write"
    @State private var approvalPolicy = "on-request"
    @State private var selectedModelId = ""
    @State private var defaultSaveMessage: String?
    @State private var sessionLookupTask: Task<Void, Never>?
    @State private var isLookingUpSession = false
    @State private var sessionLookupMessage: String?
    @State private var isShowingAdvanced = false
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("New Agent Task")
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                Spacer()
                Button {
                    close()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(IconButtonStyle())
                .help("Close")
            }

            VStack(alignment: .leading, spacing: 7) {
                Text("Title")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.black)
                TextField("Agent", text: $title)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                    )
            }

            VStack(alignment: .leading, spacing: 7) {
                Text("Workspace")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.black)
                HStack(spacing: 8) {
                    TextField(backendClient.defaultWorkspacePath, text: $cwd)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .lineLimit(1)
                        .disabled(isBindingExistingSession)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(Color.white.opacity(isBindingExistingSession ? 0.06 : 0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(Color.white.opacity(isBindingExistingSession ? 0.08 : 0.14), lineWidth: 1)
                        )
                        .foregroundStyle(isBindingExistingSession ? CorptiePalette.mutedText : CorptiePalette.primaryText)

                    Button {
                        chooseWorkspace()
                    } label: {
                        Image(systemName: "folder")
                            .font(.system(size: 12, weight: .bold))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(IconButtonStyle())
                    .disabled(isBindingExistingSession)
                    .opacity(isBindingExistingSession ? 0.45 : 1)
                    .help("Choose workspace folder")
                }
                if isBindingExistingSession {
                    HStack(spacing: 6) {
                        if isLookingUpSession {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text(sessionLookupMessage ?? "Workspace is locked to the bound Codex session.")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(sessionLookupMessage?.hasPrefix("Session not found") == true ? .red : CorptiePalette.secondaryText)
                            .lineLimit(2)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 7) {
                Text("Agent")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.black)
                HStack(spacing: 8) {
                    PresetButton(title: "Codex", command: "codex", arguments: "", isSelected: command == "codex", isDisabled: backendClient.isCreatingTask) {
                        selectAgent($0)
                    }
                    PresetButton(title: "Claude", command: "claude", arguments: "", isSelected: command == "claude", isDisabled: backendClient.isCreatingTask) {
                        selectAgent($0)
                    }
                    PresetButton(title: "OpenClacky", command: "openclacky", arguments: "", isSelected: command == "openclacky", isDisabled: backendClient.isCreatingTask) {
                        selectAgent($0)
                    }
                }
            }

            Button {
                withAnimation(.easeInOut(duration: 0.16)) {
                    isShowingAdvanced.toggle()
                }
            } label: {
                Label(isShowingAdvanced ? "Hide Advanced Settings" : "Advanced Settings", systemImage: "slider.horizontal.3")
                    .font(.system(size: 12, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(CorptiePalette.secondaryText)
            .help(isShowingAdvanced ? "Hide advanced settings" : "Show advanced settings")

            if isShowingAdvanced {
                VStack(alignment: .leading, spacing: 12) {
                    modelPicker

                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("Command")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(Color.black)
                            TextField("codex", text: $command)
                                .textFieldStyle(.plain)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                                )
                        }

                        VStack(alignment: .leading, spacing: 7) {
                            Text("Args")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(Color.black)
                            TextField("", text: $arguments)
                                .textFieldStyle(.plain)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                                )
                        }
                        .frame(width: 120)
                    }

                    VStack(alignment: .leading, spacing: 7) {
                        Text("Session ID")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(Color.black)
                        TextField("Bind existing Codex session", text: $existingSessionId)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                            )
                            .help("Enter an existing Codex session id to resume it in Corptie")
                            .onChange(of: existingSessionId) { _, value in
                                scheduleSessionLookup(value)
                            }
                    }

                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("Permission")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(Color.black)
                            Picker("", selection: $sandboxMode) {
                                Text("Workspace Write").tag("workspace-write")
                                Text("Full Access").tag("danger-full-access")
                                Text("Read Only").tag("read-only")
                            }
                            .labelsHidden()
                            .pickerStyle(.menu)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .help("Controls Codex CLI filesystem sandbox mode")
                        }

                        VStack(alignment: .leading, spacing: 7) {
                            Text("Approvals")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(Color.black)
                            Picker("", selection: $approvalPolicy) {
                                Text("Ask").tag("on-request")
                                Text("Ask for Risky Actions").tag("ask-risky")
                                Text("Never Ask").tag("never")
                                Text("On Failure").tag("on-failure")
                            }
                            .labelsHidden()
                            .pickerStyle(.menu)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .help("Controls when Codex asks before running privileged actions")
                        }
                    }
                    if sandboxMode == "danger-full-access" {
                        Label("Full Access lets Codex operate outside the workspace. Use it only for trusted tasks.", systemImage: "exclamationmark.triangle")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(CorptiePalette.amber)
                    }
                    HStack(spacing: 8) {
                        Button {
                            savePermissionDefaults()
                        } label: {
                            Label("Set as Future Default", systemImage: "checkmark.seal")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(CorptiePalette.softBlue)
                        .help("Use the selected permission and approval mode for future new sessions")

                        if let defaultSaveMessage {
                            Text(defaultSaveMessage)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(CorptiePalette.secondaryText)
                                .transition(.opacity)
                        }
                    }

                }
            }

            HStack {
                if let message = backendClient.sendStatusMessage, message.hasPrefix("Create failed") {
                    Text(message)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }

                Spacer()

                Button {
                    startSelectedAgent()
                } label: {
                    if backendClient.isCreatingTask {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: 30, height: 30)
                    } else {
                        Image(systemName: "checkmark")
                            .font(.system(size: 12, weight: .bold))
                            .frame(width: 30, height: 30)
                    }
                }
                .buttonStyle(IconButtonStyle())
                .disabled(isCreateDisabled)
                .help("Create task")
            }
        }
        .padding(18)
        .frame(maxWidth: 380)
        .background(SheetPanelBackground(cornerRadius: 20))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .compositingGroup()
        .onAppear {
            if cwd.isEmpty {
                cwd = backendClient.defaultWorkspacePath
            }
            sandboxMode = validatedSandboxMode(defaultSandboxMode)
            approvalPolicy = validatedApprovalPolicy(defaultApprovalPolicy)
            loadModelsForCurrentAgent()
        }
        .onDisappear {
            sessionLookupTask?.cancel()
        }
        .onChange(of: command) { _, _ in
            selectedModelId = ""
            loadModelsForCurrentAgent()
        }
        .onChange(of: backendClient.codexDefaultModel) { _, value in
            applyDefaultModelIfNeeded(value)
        }
        .onChange(of: backendClient.codexModels) { _, _ in
            applyDefaultModelIfNeeded(backendClient.codexDefaultModel)
        }
    }

    @ViewBuilder
    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Model")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Color.black)

            if !supportsModelSelection {
                Text("Default")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(CorptiePalette.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
                    )
            } else if backendClient.isLoadingCodexModels && backendClient.codexModels.isEmpty {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading models")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                Picker("", selection: $selectedModelId) {
                    Text(defaultModelLabel).tag("")
                    ForEach(backendClient.codexModels) { model in
                        Text(model.name).tag(model.id)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help("Choose the model for this new session")
            }
        }
    }

    private func selectAgent(_ preset: AgentPreset) {
        command = preset.command
        arguments = preset.arguments
    }

    private var trimmedCommand: String {
        command.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var supportsModelSelection: Bool {
        trimmedCommand == "codex" || trimmedCommand == "claude"
    }

    private var modelProviderForCurrentAgent: String {
        trimmedCommand == "claude" ? "claude-sdk" : "codex-pty"
    }

    private var defaultModelLabel: String {
        if let model = backendClient.codexModels.first(where: { $0.id == backendClient.codexDefaultModel }) {
            return "Default (\(model.name))"
        }
        if let defaultModel = backendClient.codexDefaultModel, !defaultModel.isEmpty {
            return "Default (\(defaultModel))"
        }
        return "Default"
    }

    private func loadModelsForCurrentAgent() {
        guard supportsModelSelection else {
            return
        }
        let provider = modelProviderForCurrentAgent
        guard backendClient.loadedModelProvider != provider || backendClient.codexModels.isEmpty else {
            applyDefaultModelIfNeeded(backendClient.codexDefaultModel)
            return
        }
        Task {
            await backendClient.loadModels(for: provider)
            await MainActor.run {
                applyDefaultModelIfNeeded(backendClient.codexDefaultModel)
            }
        }
    }

    private func applyDefaultModelIfNeeded(_ defaultModel: String?) {
        guard supportsModelSelection, selectedModelId.isEmpty else {
            return
        }
        guard let defaultModel, backendClient.codexModels.contains(where: { $0.id == defaultModel }) else {
            return
        }
        selectedModelId = defaultModel
    }

    private func savePermissionDefaults() {
        defaultSandboxMode = validatedSandboxMode(sandboxMode)
        defaultApprovalPolicy = validatedApprovalPolicy(approvalPolicy)
        withAnimation(.easeOut(duration: 0.12)) {
            defaultSaveMessage = "Saved"
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            withAnimation(.easeOut(duration: 0.12)) {
                defaultSaveMessage = nil
            }
        }
    }

    private func validatedSandboxMode(_ value: String) -> String {
        switch value {
        case "workspace-write", "danger-full-access", "read-only":
            return value
        default:
            return "workspace-write"
        }
    }

    private func validatedApprovalPolicy(_ value: String) -> String {
        switch value {
        case "on-request", "ask-risky", "never", "on-failure":
            return value
        default:
            return "on-request"
        }
    }

    private func startSelectedAgent() {
        let finalTitle = title.isEmpty ? "" : title
        let workspace = cwd.isEmpty ? backendClient.defaultWorkspacePath : cwd
        if trimmedCommand == "codex" {
            backendClient.createCodexPtyTask(
                title: finalTitle,
                prompt: "",
                cwd: workspace,
                existingSessionId: existingSessionId,
                sandbox: sandboxMode,
                approvalPolicy: approvalPolicy,
                model: selectedModelId
            ) {
                close()
            }
        } else if trimmedCommand == "claude" {
            backendClient.createClaudeTask(
                title: finalTitle,
                prompt: "",
                cwd: workspace,
                sandbox: sandboxMode,
                approvalPolicy: approvalPolicy,
                model: selectedModelId
            ) {
                close()
            }
        } else {
            backendClient.createPtyTask(
                title: finalTitle,
                command: command,
                arguments: splitArguments(arguments),
                initialInput: "",
                cwd: workspace
            ) {
                close()
            }
        }
    }

    private func splitArguments(_ value: String) -> [String] {
        value
            .split(separator: " ")
            .map(String.init)
    }

    private func chooseWorkspace() {
        if isBindingExistingSession {
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.directoryURL = URL(fileURLWithPath: cwd.isEmpty ? backendClient.defaultWorkspacePath : cwd)

        if panel.runModal() == .OK, let url = panel.url {
            cwd = url.path
        }
    }

    private var isCreateDisabled: Bool {
        let trimmedCommand = command.trimmingCharacters(in: .whitespacesAndNewlines)
        if backendClient.isCreatingTask {
            return true
        }
        if isLookingUpSession {
            return true
        }
        if isBindingExistingSession && sessionLookupMessage?.hasPrefix("Session not found") == true {
            return true
        }
        if isShowingAdvanced && trimmedCommand.isEmpty {
            return true
        }
        return trimmedCommand.isEmpty
    }

    private var isBindingExistingSession: Bool {
        !existingSessionId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func scheduleSessionLookup(_ value: String) {
        sessionLookupTask?.cancel()
        let trimmedSessionId = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedSessionId.isEmpty {
            isLookingUpSession = false
            sessionLookupMessage = nil
            return
        }

        isLookingUpSession = true
        sessionLookupMessage = "Resolving Codex session workspace..."
        sessionLookupTask = Task {
            try? await Task.sleep(for: .milliseconds(450))
            if Task.isCancelled {
                return
            }
            do {
                let result = try await backendClient.lookupCodexSession(trimmedSessionId)
                if Task.isCancelled {
                    return
                }
                await MainActor.run {
                    cwd = result.cwd ?? backendClient.defaultWorkspacePath
                    isLookingUpSession = false
                    sessionLookupMessage = "Workspace loaded from bound Codex session."
                }
            } catch {
                if Task.isCancelled {
                    return
                }
                await MainActor.run {
                    isLookingUpSession = false
                    sessionLookupMessage = "Session not found: \(error.localizedDescription)"
                }
            }
        }
    }
}

private struct AgentPreset {
    let title: String
    let command: String
    let arguments: String
}

private struct PresetButton: View {
    let title: String
    let command: String
    let arguments: String
    let isSelected: Bool
    let isDisabled: Bool
    let action: (AgentPreset) -> Void

    var body: some View {
        Button {
            action(AgentPreset(title: title, command: command, arguments: arguments))
        } label: {
            Text(title)
                .font(.system(size: 11, weight: .bold))
                .frame(height: 26)
                .padding(.horizontal, 10)
        }
        .buttonStyle(.plain)
        .foregroundStyle(isSelected ? Color.black : CorptiePalette.primaryText)
        .background(isSelected ? CorptiePalette.softBlue.opacity(0.72) : Color.white.opacity(isDisabled ? 0.07 : 0.13), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(isSelected ? 0.28 : 0.16), lineWidth: 1))
        .disabled(isDisabled)
    }
}

private struct RenameSessionSheet: View {
    @EnvironmentObject private var backendClient: BackendClient
    @State private var title: String
    let session: TaskSession
    let close: () -> Void

    init(session: TaskSession, close: @escaping () -> Void) {
        self.session = session
        self.close = close
        _title = State(initialValue: session.title)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Rename Task")
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                Spacer()
                Button {
                    close()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(IconButtonStyle())
                .help("Close")
            }

            TextField("Task name", text: $title)
                .textFieldStyle(.plain)
                .font(.system(size: 13, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                )
                .onSubmit {
                    save()
                }

            HStack {
                Spacer()
                Button {
                    save()
                } label: {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(IconButtonStyle())
                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .help("Save name")
            }
        }
        .padding(18)
        .frame(width: 340)
        .background(SheetPanelBackground(cornerRadius: 20))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .compositingGroup()
    }

    private func save() {
        backendClient.rename(session: session, title: title) {
            close()
        }
    }
}

private struct SheetPanelBackground: View {
    let cornerRadius: CGFloat

    var body: some View {
        if #available(macOS 26.0, *) {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(.clear)
                .glassEffect(.clear.tint(Color.white.opacity(0.04)), in: .rect(cornerRadius: cornerRadius))
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(.regularMaterial)
                        .opacity(0.74)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(CorptiePalette.glassVeilFocused)
                        .opacity(0.46)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.22), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        } else {
            VisualEffectView(material: .hudWindow, blendingMode: .behindWindow)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
    }
}

private struct TaskCardView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @EnvironmentObject private var detachedSessionManager: DetachedSessionManager
    @State private var quickReply = ""
    @State private var lastQuickReplyInteractionAt = Date.distantPast
    @State private var isRenaming = false
    @State private var isShowingUnboundHint = false
    @State private var isHoveringSummary = false
    @State private var hoverPreviewTask: Task<Void, Never>?
    @State private var completionSoundId = SessionCompletionSoundManager.defaultSoundId
    @FocusState private var isQuickReplyFocused: Bool

    let session: TaskSession
    var hoverPreviewChanged: (String, Bool) -> Void = { _, _ in }
    var preheatRequested: (TaskSession) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                ZStack(alignment: .topTrailing) {
                    AgentAvatarView(session: session, size: 34)

                    connectionIndicatorButton
                        .offset(x: 6, y: -6)
                        .zIndex(2)
                }
                .frame(width: 42, height: 38, alignment: .topLeading)

                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(1)
                }

                Spacer()

                if session.pinned == true {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(CorptiePalette.amber)
                        .help("Pinned")
                }

                Text(session.status.label)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(session.status.color)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(session.status.color.opacity(0.14), in: Capsule())
            }

            Text(session.summary)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(CorptiePalette.cardPreviewText)
                .lineLimit(1)
                .truncationMode(.tail)
                .measureSessionSummaryFrame(session.id)
                .contentShape(Rectangle())
                .onHover { hovering in
                    handleSummaryHover(hovering)
                }

            HStack(spacing: 10) {
                Text(session.agent)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.secondaryText)
                    .lineLimit(1)

                if let activityStatus = session.activityStatus,
                   !activityStatus.isEmpty,
                   session.status == .running {
                    ActivityStatusText(text: activityStatus, isActive: true)
                        .font(.system(size: 11, weight: .semibold))
                }

                Text(relativeTime(session.updatedAt))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.mutedText)
                    .lineLimit(1)

                if session.status == .running {
                    Spacer()

                    if session.capabilities?.canInterrupt != false {
                        Button {
                            backendClient.interrupt(session: session)
                        } label: {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 9, weight: .bold))
                                .frame(width: 24, height: 24)
                        }
                        .buttonStyle(IconButtonStyle())
                        .help("Stop current run")
                    }
                } else if canQuickReply {
                    Spacer(minLength: 6)

                    QuickReplyField(
                        text: $quickReply,
                        isFocused: $isQuickReplyFocused,
                        isSending: backendClient.isSendingMessage,
                        placeholder: "Reply",
                        onInteract: {
                        lastQuickReplyInteractionAt = Date()
                        },
                        send: {
                            sendQuickReply()
                        }
                    )
                    .frame(width: 132)
                }
            }

            if hasSuggestedOptions {
                suggestedOptionsSummary
            }
        }
        .padding(13)
        .frame(height: PanelLayoutState.cardHeight, alignment: .topLeading)
        .fixedSize(horizontal: false, vertical: true)
        .clipped()
        .background(
            LiquidGlassCardBackground(cornerRadius: 18, fillOpacity: cardFillOpacity)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.white.opacity(cardStrokeOpacity), lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onHover { hovering in
            if hovering {
                preheatRequested(session)
            }
        }
        .onTapGesture {
            if Date().timeIntervalSince(lastQuickReplyInteractionAt) > 0.25 {
                backendClient.select(session: session)
            }
        }
        .contextMenu {
            Button {
                isRenaming = true
            } label: {
                Label("Rename", systemImage: "pencil")
            }

            Divider()

            Button {
                chooseAvatar()
            } label: {
                Label("Set Avatar", systemImage: "person.crop.circle")
            }

            if session.avatarPath?.isEmpty == false {
                Button {
                    backendClient.updateAvatar(session: session, avatarPath: nil)
                } label: {
                    Label("Clear Avatar", systemImage: "xmark.circle")
                }
            }

            Divider()

            Menu {
                ForEach(SessionCompletionSoundManager.options) { option in
                    Button {
                        completionSoundId = option.id
                        SessionCompletionSoundManager.setSelectedSoundId(option.id, for: session.id)
                    } label: {
                        HStack {
                            if completionSoundId == option.id {
                                Image(systemName: "checkmark")
                            }
                            Text(option.label)
                        }
                    }
                }
            } label: {
                Label("Completion Sound", systemImage: "speaker.wave.2")
            }

            Divider()

            if !backendClient.isShowingArchivedSessions {
                Button {
                    detachedSessionManager.float(session: session)
                } label: {
                    Label("Float Session", systemImage: "rectangle.on.rectangle.circle")
                }

                Divider()

                Button {
                    backendClient.setPinned(session.pinned != true, session: session)
                } label: {
                    Label(session.pinned == true ? "Unpin" : "Pin to Top", systemImage: session.pinned == true ? "pin.slash" : "pin")
                }

                Divider()
            }

            if backendClient.isShowingArchivedSessions {
                Button {
                    backendClient.setArchived(false, session: session)
                } label: {
                    Label("Unarchive", systemImage: "tray.and.arrow.up")
                }
            } else {
                Button {
                    backendClient.setArchived(true, session: session)
                } label: {
                    Label("Archive", systemImage: "archivebox")
                }
            }

            Divider()

            Button(role: .destructive) {
                backendClient.delete(session: session)
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .sheet(isPresented: $isRenaming) {
            RenameSessionSheet(session: session) {
                isRenaming = false
            }
            .environmentObject(backendClient)
            .presentationBackground(.clear)
        }
        .onAppear {
            completionSoundId = SessionCompletionSoundManager.selectedSoundId(for: session.id)
        }
        .onChange(of: session.id) { _, sessionId in
            completionSoundId = SessionCompletionSoundManager.selectedSoundId(for: sessionId)
        }
    }

    private var glassStrength: Double {
        0.55
    }

    private var cardFillOpacity: Double {
        0.12 + glassStrength * 0.12
    }

    private var cardStrokeOpacity: Double {
        0.18 + glassStrength * 0.14
    }

    private var hasSuggestedOptions: Bool {
        !(session.suggestedOptions ?? []).isEmpty
    }

    private var canQuickReply: Bool {
        session.capabilities?.canSend == true
    }

    private var visibleSuggestedOptions: [CodexApprovalOption] {
        Array((session.suggestedOptions ?? []).prefix(5))
    }

    private var suggestedOptionsSummary: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.turn.down.right")
                .font(.system(size: 9, weight: .bold))
            Text(visibleSuggestedOptions.first?.label ?? "Choice available")
                .font(.system(size: 10.5, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.tail)
            if visibleSuggestedOptions.count > 1 {
                Text("+\(visibleSuggestedOptions.count - 1)")
                    .font(.system(size: 10, weight: .bold))
            }
        }
        .foregroundStyle(CorptiePalette.amber)
        .frame(maxWidth: .infinity, alignment: .leading)
        .help(visibleSuggestedOptions.map(\.label).joined(separator: "\n"))
    }

    private var replyPreviewText: String? {
        let trimmed = session.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private var connectionIndicatorHelp: String {
        if session.isUnboundCodexSession {
            return "Session is not bound yet"
        }
        if session.capabilities?.canReconnect == true && !session.isConnected {
            return "Reconnect session"
        }
        if session.external?.provider != "codex-pty" {
            return "Session is available"
        }
        if session.isConnecting || backendClient.connectionTransitionSessionIds.contains(session.id) {
            return "Switching PTY connection"
        }
        return session.isConnected ? "Disconnect PTY" : "Reconnect PTY"
    }

    private var connectionIndicatorPopoverText: String {
        if session.isUnboundCodexSession {
            return "尚未发送消息的会话，无法切换状态。"
        }
        if session.capabilities?.canReconnect == true && !session.isConnected {
            return "点击重新连接这个会话。"
        }
        if session.external?.provider != "codex-pty" {
            return "这个会话无需手动连接，当前可用。"
        }
        return "正在切换连接状态。"
    }

    private var connectionIndicatorButton: some View {
        Button {
            lastQuickReplyInteractionAt = Date()
            guard !backendClient.connectionTransitionSessionIds.contains(session.id) else {
                return
            }
            if session.isUnboundCodexSession {
                isShowingUnboundHint = true
            } else if session.capabilities?.canReconnect == true && !session.isConnected {
                backendClient.reconnect(session: session)
            } else if session.external?.provider == "codex-pty" {
                backendClient.togglePtyConnection(for: session)
            } else {
                isShowingUnboundHint = true
            }
        } label: {
            let isTransitioning = session.isConnecting || backendClient.connectionTransitionSessionIds.contains(session.id)
            let lightColor = (session.isConnecting || (!session.isConnected && isTransitioning))
                ? CorptiePalette.disconnected
                : session.connectionColor
            ConnectionIndicatorLight(
                color: lightColor,
                size: 9,
                glowSize: 20,
                isBreathing: isTransitioning
            )
        }
        .buttonStyle(.plain)
        .contentShape(Circle())
        .help(connectionIndicatorHelp)
        .popover(isPresented: $isShowingUnboundHint, arrowEdge: .top) {
            Text(connectionIndicatorPopoverText)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.black)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .frame(width: 220)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private func chooseAvatar() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.gif, .png, .jpeg, .heic, .tiff, .image]
        if panel.runModal() == .OK, let url = panel.url {
            backendClient.updateAvatar(session: session, avatarPath: url.path)
        }
    }

    private func sendQuickReply() {
        let text = quickReply
        backendClient.sendMessage(text, to: session) {
            quickReply = ""
        }
    }

    private func handleSummaryHover(_ hovering: Bool) {
        hoverPreviewTask?.cancel()
        hoverPreviewTask = nil

        if hovering {
            hoverPreviewTask = Task {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else {
                    return
                }
                await MainActor.run {
                    isHoveringSummary = true
                    if replyPreviewText != nil {
                        hoverPreviewChanged(session.id, true)
                    }
                }
            }
        } else {
            hideHoverPreviewImmediately()
        }
    }

    private func hideHoverPreviewImmediately() {
        hoverPreviewTask?.cancel()
        hoverPreviewTask = nil
        isHoveringSummary = false
        hoverPreviewChanged(session.id, false)
    }

    private func relativeTime(_ value: String) -> String {
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: value) else {
            return ""
        }

        let seconds = max(0, Int(Date().timeIntervalSince(date)))
        if seconds < 60 {
            return "\(seconds)s ago"
        }
        let minutes = seconds / 60
        if minutes < 60 {
            return "\(minutes)m ago"
        }
        return "\(minutes / 60)h ago"
    }
}

private struct SessionReplyHoverBubble: View {
    let text: String
    var showsArrow = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.vertical, showsIndicators: true) {
                Text(text)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(CorptiePalette.primaryText)
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            }
            .frame(width: 248)
            .frame(maxHeight: 82)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(.regularMaterial)
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(CorptiePalette.glassVeilFocused.opacity(0.52))
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.24), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.16), radius: 10, y: 5)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

            if showsArrow {
                Triangle()
                    .fill(.regularMaterial)
                    .overlay(Triangle().stroke(Color.white.opacity(0.20), lineWidth: 1))
                    .frame(width: 14, height: 8)
                    .rotationEffect(.degrees(180))
                    .offset(x: -86, y: -1)
            }
        }
    }
}

private struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

private struct LiquidGlassCardBackground: View {
    let cornerRadius: CGFloat
    let fillOpacity: Double

    var body: some View {
        if #available(macOS 26.0, *) {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(.clear)
                .glassEffect(.clear.tint(Color.white.opacity(0.025)), in: .rect(cornerRadius: cornerRadius))
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(.regularMaterial)
                        .opacity(0.68)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(Color.white.opacity(fillOpacity))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(
                            LinearGradient(
                                colors: [
                                    Color.white.opacity(0.34),
                                    Color.white.opacity(0.14),
                                    Color.black.opacity(0.20)
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            lineWidth: 1
                        )
                )
                .shadow(color: Color.black.opacity(0.10), radius: 10, y: 5)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color.white.opacity(fillOpacity))
        }
    }
}

struct AgentAvatarView: View {
    let session: TaskSession
    let size: CGFloat
    var showsChrome = true

    var body: some View {
        Group {
            if let avatarPath = session.avatarPath, !avatarPath.isEmpty {
                AnimatedAvatarImage(path: avatarPath)
                    .background(Color.white.opacity(0.16))
            } else {
                ZStack {
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [session.accent.color.opacity(0.92), CorptiePalette.softBlue.opacity(0.72)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                    Text(initials)
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.black)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay {
            if showsChrome {
                Circle().strokeBorder(Color.white.opacity(0.26), lineWidth: 1)
            }
        }
        .shadow(color: Color.black.opacity(showsChrome ? 0.08 : 0), radius: showsChrome ? 6 : 0, y: showsChrome ? 3 : 0)
    }

    private var initials: String {
        let words = session.agent
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .prefix(2)
            .compactMap { $0.first }
        let value = String(words).uppercased()
        return value.isEmpty ? "A" : value
    }
}

private struct AnimatedAvatarImage: NSViewRepresentable {
    let path: String

    func makeNSView(context: Context) -> AspectFillAnimatedImageView {
        AspectFillAnimatedImageView()
    }

    func updateNSView(_ imageView: AspectFillAnimatedImageView, context: Context) {
        imageView.image = NSImage(contentsOfFile: path)
    }

    final class AspectFillAnimatedImageView: NSView {
        private let imageView = NSImageView()
        private var imageSize: CGSize = .zero

        var image: NSImage? {
            didSet {
                imageView.image = image
                imageView.animates = true
                imageSize = image?.size ?? .zero
                needsLayout = true
            }
        }

        override init(frame frameRect: NSRect) {
            super.init(frame: frameRect)
            wantsLayer = true
            layer?.masksToBounds = true
            imageView.imageAlignment = .alignCenter
            imageView.imageScaling = .scaleAxesIndependently
            imageView.animates = true
            addSubview(imageView)
        }

        required init?(coder: NSCoder) {
            nil
        }

        override func layout() {
            super.layout()
            guard bounds.width > 0, bounds.height > 0, imageSize.width > 0, imageSize.height > 0 else {
                imageView.frame = bounds
                return
            }

            let scale = max(bounds.width / imageSize.width, bounds.height / imageSize.height)
            let scaledSize = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
            imageView.frame = CGRect(
                x: (bounds.width - scaledSize.width) / 2,
                y: (bounds.height - scaledSize.height) / 2,
                width: scaledSize.width,
                height: scaledSize.height
            )
        }
    }
}

private struct DetailView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @EnvironmentObject private var panelLayoutState: PanelLayoutState
    static let initialVisibleMessageLimit = 7
    @State private var message = ""
    @State private var didInitialScroll = false
    @State private var visibleMessageLimit = initialVisibleMessageLimit
    @State private var cachedDisplayItems: [CodexThreadItem] = []
    @State private var cachedDisplayEntries: [ChatDisplayEntry] = []
    @State private var cachedTotalDisplayEntryCount = 0
    @State private var cachedItemsSignature = ""
    @State private var cachedDetailSourceSignature = ""
    @State private var cachedSessionId = ""
    @State private var displayCacheBySessionId: [String: DetailDisplayCache] = [:]
    @State private var detailScrollViewportHeight: CGFloat = 0
    @State private var detailScrollBottomMaxY: CGFloat = 0
    @State private var isDetailScrolledNearBottom = true
    let sessionId: String
    let preheatedDisplayCache: DetailDisplayCache?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            DetailHeaderView()

            if backendClient.isLoadingDetail && backendClient.selectedDetail == nil {
                VStack(spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading Codex thread")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let detail = backendClient.selectedDetail {
                ThreadMetaView(detail: detail)

                Group {
                    if shouldRenderDetailMessages(for: detail) {
                        detailMessages(detail)
                    } else {
                        DetailMessagesPlaceholder()
                    }
                }
                .transaction { transaction in
                    transaction.animation = nil
                }
                .onAppear {
                    updateCachedDisplayEntries(for: detail)
                }
                .onChange(of: detail.items.count) { _, _ in
                    updateCachedDisplayEntries(for: detail)
                }
                .onChange(of: detail.items.last?.id) { _, _ in
                    updateCachedDisplayEntries(for: detail)
                }
                .onChange(of: detailSourceSignature(for: detail)) { _, _ in
                    updateCachedDisplayEntries(for: detail)
                }
            } else if backendClient.selectedDetail == nil,
                      backendClient.isLoadingDetail == false,
                      backendClient.lastError != nil {
                OfflineView(error: backendClient.lastError ?? "No detail is available for this task.")
            } else {
                VStack(spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                    DetailMessagesPlaceholder()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            if let sendStatusMessage = backendClient.sendStatusMessage,
               sendStatusMessage.hasPrefix("Send failed") || sendStatusMessage.contains("read-only") {
                Text(sendStatusMessage)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }

            if backendClient.selectedDetail?.canSend == false
                && backendClient.selectedDetail?.capabilities?.canInterrupt != true {
                ReadOnlyComposer(reason: backendClient.selectedDetail?.sendUnavailableReason)
            } else {
                MessageComposer(message: $message)
            }
        }
        .padding(1)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.white.opacity(0.001))
        )
        .onDisappear {
            panelLayoutState.updateDetailLastMessageHeight(nil)
        }
        .onAppear {
            restorePreheatedDisplayCacheIfNeeded()
        }
        .onChange(of: preheatedDisplayCache?.signature) { _, _ in
            restorePreheatedDisplayCacheIfNeeded()
        }
        .onChange(of: sessionId) { _, _ in
            didInitialScroll = false
            isDetailScrolledNearBottom = true
            detailScrollViewportHeight = 0
            detailScrollBottomMaxY = 0
            visibleMessageLimit = Self.initialVisibleMessageLimit
            restoreDisplayCacheForCurrentSession()
        }
    }

    @ViewBuilder
    private func detailMessages(_ detail: CodexThreadDetail) -> some View {
        let preparedDisplay = preparedDisplayEntries(for: detail)
        let displayEntries = preparedDisplay.visibleEntries
        let hiddenCount = max(0, preparedDisplay.totalCount - displayEntries.count)

        ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 8) {
                    if hiddenCount > 0 {
                        Button {
                            visibleMessageLimit += 100
                            updateCachedDisplayEntries(for: detail)
                        } label: {
                            Label("Load \(min(100, hiddenCount)) earlier messages", systemImage: "arrow.up.circle")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(CorptiePalette.secondaryText)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                        }
                        .buttonStyle(.plain)
                        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }

                    ForEach(displayEntries) { entry in
                        switch entry.kind {
                        case .message(let item):
                            ThreadItemView(item: item)
                                .id(entry.id)
                                .measureLastMessageHeight(isLast: entry.id == displayEntries.last?.id)
                        case .process(let items):
                            ThreadProcessGroupView(items: items)
                                .id(entry.id)
                                .measureLastMessageHeight(isLast: entry.id == displayEntries.last?.id)
                        }
                    }

                    Color.clear
                        .frame(height: 1)
                        .id(bottomScrollAnchorId)
                        .background(
                            GeometryReader { proxy in
                                Color.clear.preference(
                                    key: DetailScrollBottomMaxYPreferenceKey.self,
                                    value: proxy.frame(in: .named(detailScrollCoordinateSpaceName)).maxY
                                )
                            }
                        )
                }
                .padding(.bottom, 4)
            }
            .coordinateSpace(name: detailScrollCoordinateSpaceName)
            .background(
                GeometryReader { proxy in
                    Color.clear.preference(key: DetailScrollViewportHeightPreferenceKey.self, value: proxy.size.height)
                }
            )
            .defaultScrollAnchor(.bottom)
            .onAppear {
                updateCachedDisplayEntries(for: detail)
                scrollToLatestAfterLayout(detail: detail, proxy: proxy, force: true)
                if detail.items.isEmpty {
                    panelLayoutState.updateDetailLastMessageHeight(nil)
                }
            }
            .onChange(of: detail.items.last?.id) { _, _ in
                updateCachedDisplayEntries(for: detail)
                scrollToLatestAfterLayout(detail: detail, proxy: proxy)
                if detail.items.isEmpty {
                    panelLayoutState.updateDetailLastMessageHeight(nil)
                }
            }
            .onChange(of: detailSourceSignature(for: detail)) { _, _ in
                updateCachedDisplayEntries(for: detail)
                scrollToLatestAfterLayout(detail: detail, proxy: proxy)
            }
            .onPreferenceChange(LastMessageHeightPreferenceKey.self) { height in
                panelLayoutState.updateDetailLastMessageHeight(height > 0 ? height : nil)
            }
            .onPreferenceChange(DetailScrollViewportHeightPreferenceKey.self) { height in
                detailScrollViewportHeight = height
                updateDetailScrollBottomProximity()
            }
            .onPreferenceChange(DetailScrollBottomMaxYPreferenceKey.self) { maxY in
                detailScrollBottomMaxY = maxY
                updateDetailScrollBottomProximity()
            }
        }
    }

    private func updateCachedDisplayEntries(for detail: CodexThreadDetail) {
        let sourceSignature = detailSourceSignature(for: detail)
        guard cachedSessionId != sessionId || sourceSignature != cachedDetailSourceSignature else {
            return
        }
        let preparedDisplay = makeVisibleDetailDisplay(for: detail, visibleMessageLimit: visibleMessageLimit)
        cachedDetailSourceSignature = sourceSignature
        cachedItemsSignature = preparedDisplay.signature
        cachedSessionId = sessionId
        cachedDisplayItems = preparedDisplay.displayItems
        cachedTotalDisplayEntryCount = preparedDisplay.totalCount
        cachedDisplayEntries = preparedDisplay.visibleEntries
        displayCacheBySessionId[sessionId] = DetailDisplayCache(
            sessionId: sessionId,
            displayItems: preparedDisplay.displayItems,
            displayEntries: preparedDisplay.visibleEntries,
            totalDisplayEntryCount: preparedDisplay.totalCount,
            signature: preparedDisplay.signature,
            sourceSignature: sourceSignature
        )
    }

    private func shouldRenderDetailMessages(for detail: CodexThreadDetail) -> Bool {
        if hasPreparedDisplayCacheForCurrentSession || hasPreheatedDisplayCacheForCurrentSession {
            return true
        }
        return panelLayoutState.canRenderDetailMessages
    }

    private func preparedDisplayEntries(for detail: CodexThreadDetail) -> (visibleEntries: [ChatDisplayEntry], totalCount: Int) {
        if hasPreparedDisplayCacheForCurrentSession && cachedDetailSourceSignature == detailSourceSignature(for: detail) {
            return (cachedDisplayEntries, cachedTotalDisplayEntryCount)
        }
        if let preheatedDisplayCache, preheatedDisplayCache.sessionId == sessionId {
            return (preheatedDisplayCache.displayEntries, preheatedDisplayCache.totalDisplayEntryCount)
        }
        let preparedDisplay = makeVisibleDetailDisplay(for: detail, visibleMessageLimit: visibleMessageLimit)
        return (preparedDisplay.visibleEntries, preparedDisplay.totalCount)
    }

    private var hasPreparedDisplayCacheForCurrentSession: Bool {
        cachedSessionId == sessionId && !cachedDisplayEntries.isEmpty
    }

    private var hasPreheatedDisplayCacheForCurrentSession: Bool {
        preheatedDisplayCache?.sessionId == sessionId && preheatedDisplayCache?.displayEntries.isEmpty == false
    }

    private func restorePreheatedDisplayCacheIfNeeded() {
        guard let preheatedDisplayCache,
              preheatedDisplayCache.sessionId == sessionId,
              !hasPreparedDisplayCacheForCurrentSession else {
            return
        }
        cachedSessionId = sessionId
        cachedDisplayItems = preheatedDisplayCache.displayItems
        cachedDisplayEntries = preheatedDisplayCache.displayEntries
        cachedTotalDisplayEntryCount = preheatedDisplayCache.totalDisplayEntryCount
        cachedItemsSignature = preheatedDisplayCache.signature
        cachedDetailSourceSignature = preheatedDisplayCache.sourceSignature
        displayCacheBySessionId[sessionId] = preheatedDisplayCache
    }

    private func restoreDisplayCacheForCurrentSession() {
        if let cache = displayCacheBySessionId[sessionId] {
            cachedSessionId = sessionId
            cachedDisplayItems = cache.displayItems
            cachedDisplayEntries = cache.displayEntries
            cachedTotalDisplayEntryCount = cache.totalDisplayEntryCount
            cachedItemsSignature = cache.signature
            cachedDetailSourceSignature = cache.sourceSignature
            return
        }
        cachedSessionId = ""
        cachedDisplayItems = []
        cachedDisplayEntries = []
        cachedTotalDisplayEntryCount = 0
        cachedItemsSignature = ""
        cachedDetailSourceSignature = ""
    }

    private func detailSourceSignature(for detail: CodexThreadDetail) -> String {
        makeDetailSourceSignature(for: detail, visibleMessageLimit: visibleMessageLimit)
    }

    private func displaySignature(for visibleEntries: [ChatDisplayEntry]) -> String {
        let entrySignatures = visibleEntries.map { entry in
            switch entry.kind {
            case .message(let item):
                return itemSignature(item)
            case .process(let items):
                return items.map(itemSignature).joined(separator: ",")
            }
        }.joined(separator: "|")
        return "\(visibleMessageLimit)|\(entrySignatures)"
    }

    private func itemSignature(_ item: CodexThreadItem) -> String {
        let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return [
            item.id,
            item.type,
            item.status ?? "",
            item.turnStatus,
            "\(text.count)",
            String(text.suffix(96))
        ].joined(separator: ":")
    }

    private func scrollToLatestAfterLayout(detail: CodexThreadDetail, proxy: ScrollViewProxy, force: Bool = false) {
        guard !cachedDisplayEntries.isEmpty || !detail.items.isEmpty else {
            return
        }
        guard force || isDetailScrolledNearBottom else {
            return
        }

        let delay: TimeInterval = didInitialScroll ? 0.0 : 0.02
        didInitialScroll = true

        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            guard backendClient.selectedSession?.id == sessionId else {
                return
            }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                proxy.scrollTo(bottomScrollAnchorId, anchor: .bottom)
            }
        }
    }

    private var bottomScrollAnchorId: String {
        "\(sessionId)-bottom-anchor"
    }

    private var detailScrollCoordinateSpaceName: String {
        "\(sessionId)-detail-scroll"
    }

    private func updateDetailScrollBottomProximity() {
        guard detailScrollViewportHeight > 0, detailScrollBottomMaxY > 0 else {
            return
        }
        let bottomDistance = detailScrollBottomMaxY - detailScrollViewportHeight
        isDetailScrolledNearBottom = bottomDistance <= 36
    }

    private func visibleEntries(from displayEntries: [ChatDisplayEntry]) -> [ChatDisplayEntry] {
        guard displayEntries.count > visibleMessageLimit else {
            return displayEntries
        }
        var entries = Array(displayEntries.suffix(visibleMessageLimit))
        while entries.first?.isProcessGroup == true && entries.count > 1 {
            entries.removeFirst()
        }
        return entries
    }

    private func displayItems(for detail: CodexThreadDetail) -> [CodexThreadItem] {
        detail.items.filter { !isLowSignalProcessItem($0) }
    }

    private func isLowSignalProcessItem(_ item: CodexThreadItem) -> Bool {
        if item.type == "taskComplete" || item.title.localizedCaseInsensitiveContains("turn completed") {
            return true
        }
        if item.type == "agentMessage" && item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return true
        }
        return false
    }

    private func chatDisplayEntries(from items: [CodexThreadItem]) -> [ChatDisplayEntry] {
        var entries: [ChatDisplayEntry] = []
        var turnIds: [String] = []
        var itemsByTurnId: [String: [CodexThreadItem]] = [:]

        for item in items {
            if itemsByTurnId[item.turnId] == nil {
                turnIds.append(item.turnId)
                itemsByTurnId[item.turnId] = []
            }
            itemsByTurnId[item.turnId]?.append(item)
        }

        for turnId in turnIds {
            if let turnItems = itemsByTurnId[turnId] {
                entries.append(contentsOf: chatDisplayEntriesForTurn(turnItems))
            }
        }
        return entries
    }

    private func chatDisplayEntriesForTurn(_ items: [CodexThreadItem]) -> [ChatDisplayEntry] {
        let userMessages = items.filter { $0.type == "userMessage" }
        let agentMessages = items.filter {
            $0.type == "agentMessage" && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        let finalAgentMessage = agentMessages.last
        let progressAgentMessages = agentMessages.dropLast()
        let processItems = items.filter(isProcessItem) + progressAgentMessages
        let trailingItems = items.filter { item in
            item.type != "userMessage" && item.type != "agentMessage" && !isProcessItem(item)
        }

        var entries = userMessages.map { ChatDisplayEntry(kind: .message($0)) }
        if !processItems.isEmpty {
            entries.append(ChatDisplayEntry(kind: .process(processItems)))
        }
        if let finalAgentMessage {
            entries.append(ChatDisplayEntry(kind: .message(finalAgentMessage)))
        }
        entries.append(contentsOf: trailingItems.map { ChatDisplayEntry(kind: .message($0)) })
        return entries
    }

    private func isProcessItem(_ item: CodexThreadItem) -> Bool {
        switch item.type {
        case "reasoning", "plan", "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "warning":
            return true
        default:
            return false
        }
    }
}

private struct ChatDisplayEntry: Identifiable {
    enum Kind {
        case message(CodexThreadItem)
        case process([CodexThreadItem])
    }

    let kind: Kind

    var id: String {
        switch kind {
        case .message(let item):
            return "message:\(item.id)"
        case .process(let items):
            return "process:\(items.first?.id ?? UUID().uuidString)"
        }
    }

    var isProcessGroup: Bool {
        switch kind {
        case .message:
            return false
        case .process:
            return true
        }
    }
}

private struct DetailDisplayCache {
    let sessionId: String
    let displayItems: [CodexThreadItem]
    let displayEntries: [ChatDisplayEntry]
    let totalDisplayEntryCount: Int
    let signature: String
    let sourceSignature: String
}

private func makeDetailDisplayCache(
    for detail: CodexThreadDetail,
    sessionId: String,
    visibleMessageLimit: Int
) -> DetailDisplayCache {
    let preparedDisplay = makeVisibleDetailDisplay(for: detail, visibleMessageLimit: visibleMessageLimit)
    return DetailDisplayCache(
        sessionId: sessionId,
        displayItems: preparedDisplay.displayItems,
        displayEntries: preparedDisplay.visibleEntries,
        totalDisplayEntryCount: preparedDisplay.totalCount,
        signature: preparedDisplay.signature,
        sourceSignature: preparedDisplay.sourceSignature
    )
}

private func makeVisibleDetailDisplay(
    for detail: CodexThreadDetail,
    visibleMessageLimit: Int
) -> (displayItems: [CodexThreadItem], visibleEntries: [ChatDisplayEntry], totalCount: Int, signature: String, sourceSignature: String) {
    let windowSize = min(detail.items.count, max(visibleMessageLimit * 5, visibleMessageLimit + 24))
    let displayItems = detail.items
        .suffix(windowSize)
        .filter { !isLowSignalDetailProcessItem($0) }
    let displayEntries = makeChatDisplayEntries(from: displayItems)
    let visibleEntries = visibleDetailEntries(from: displayEntries, limit: visibleMessageLimit)
    return (
        displayItems: displayItems,
        visibleEntries: visibleEntries,
        totalCount: max(detail.items.count, visibleEntries.count),
        signature: detailDisplaySignature(for: visibleEntries, visibleMessageLimit: visibleMessageLimit),
        sourceSignature: makeDetailSourceSignature(for: detail, visibleMessageLimit: visibleMessageLimit)
    )
}

private func makeDetailSourceSignature(for detail: CodexThreadDetail, visibleMessageLimit: Int) -> String {
    let items = detail.items.suffix(max(visibleMessageLimit * 4, visibleMessageLimit + 8))
    let itemSignatures = items.map { item in
        [
            item.id,
            item.type,
            item.status ?? "",
            item.turnStatus,
            "\(item.text.count)"
        ].joined(separator: ":")
    }.joined(separator: "|")
    return "\(visibleMessageLimit)|\(detail.items.count)|\(detail.updatedAt)|\(itemSignatures)"
}

private func visibleDetailEntries(from displayEntries: [ChatDisplayEntry], limit: Int) -> [ChatDisplayEntry] {
    guard displayEntries.count > limit else {
        return displayEntries
    }
    var entries = Array(displayEntries.suffix(limit))
    while entries.first?.isProcessGroup == true && entries.count > 1 {
        entries.removeFirst()
    }
    return entries
}

private func makeChatDisplayEntries(from items: [CodexThreadItem]) -> [ChatDisplayEntry] {
    var entries: [ChatDisplayEntry] = []
    var turnIds: [String] = []
    var itemsByTurnId: [String: [CodexThreadItem]] = [:]

    for item in items {
        if itemsByTurnId[item.turnId] == nil {
            turnIds.append(item.turnId)
            itemsByTurnId[item.turnId] = []
        }
        itemsByTurnId[item.turnId]?.append(item)
    }

    for turnId in turnIds {
        if let turnItems = itemsByTurnId[turnId] {
            entries.append(contentsOf: makeChatDisplayEntriesForTurn(turnItems))
        }
    }
    return entries
}

private func makeChatDisplayEntriesForTurn(_ items: [CodexThreadItem]) -> [ChatDisplayEntry] {
    let userMessages = items.filter { $0.type == "userMessage" }
    let agentMessages = items.filter {
        $0.type == "agentMessage" && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    let finalAgentMessage = agentMessages.last
    let progressAgentMessages = agentMessages.dropLast()
    let processItems = items.filter(isDetailProcessItem) + progressAgentMessages
    let trailingItems = items.filter { item in
        item.type != "userMessage" && item.type != "agentMessage" && !isDetailProcessItem(item)
    }

    var entries = userMessages.map { ChatDisplayEntry(kind: .message($0)) }
    if !processItems.isEmpty {
        entries.append(ChatDisplayEntry(kind: .process(processItems)))
    }
    if let finalAgentMessage {
        entries.append(ChatDisplayEntry(kind: .message(finalAgentMessage)))
    }
    entries.append(contentsOf: trailingItems.map { ChatDisplayEntry(kind: .message($0)) })
    return entries
}

private func isLowSignalDetailProcessItem(_ item: CodexThreadItem) -> Bool {
    if item.type == "taskComplete" || item.title.localizedCaseInsensitiveContains("turn completed") {
        return true
    }
    if item.type == "agentMessage" && item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return true
    }
    return false
}

private func isDetailProcessItem(_ item: CodexThreadItem) -> Bool {
    switch item.type {
    case "reasoning", "plan", "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "warning":
        return true
    default:
        return false
    }
}

private func detailDisplaySignature(for visibleEntries: [ChatDisplayEntry], visibleMessageLimit: Int) -> String {
    let entrySignatures = visibleEntries.map { entry in
        switch entry.kind {
        case .message(let item):
            return detailItemSignature(item)
        case .process(let items):
            return items.map(detailItemSignature).joined(separator: ",")
        }
    }.joined(separator: "|")
    return "\(visibleMessageLimit)|\(entrySignatures)"
}

private func detailItemSignature(_ item: CodexThreadItem) -> String {
    let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
    return [
        item.id,
        item.type,
        item.status ?? "",
        item.turnStatus,
        "\(text.count)",
        String(text.suffix(96))
    ].joined(separator: ":")
}

private struct DetailHeaderView: View {
    @EnvironmentObject private var backendClient: BackendClient

    var body: some View {
        HStack(spacing: 10) {
            Button {
                withAnimation(.easeOut(duration: 0.16)) {
                    backendClient.closeDetail()
                }
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 13, weight: .bold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(IconButtonStyle())
            .help("Back to task list")

            if let selectedSession = backendClient.selectedSession {
                AgentAvatarView(session: selectedSession, size: 32)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(backendClient.selectedSession?.title ?? "Codex thread")
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                if let cwd = backendClient.selectedDetail?.cwd, !cwd.isEmpty {
                    Button {
                        NSWorkspace.shared.open(URL(fileURLWithPath: cwd, isDirectory: true))
                    } label: {
                        Text(cwd)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                            .lineLimit(1)
                    }
                    .buttonStyle(.plain)
                    .help("Open folder in Finder")
                } else {
                    Text(backendClient.selectedSession?.summary ?? "")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .lineLimit(1)
                }
            }

            Spacer()

            if backendClient.selectedSession?.capabilities?.canReconnect == true
                && backendClient.selectedSession?.isConnected == false {
                Button {
                    backendClient.reconnectSelectedSession()
                } label: {
                    Image(systemName: "link")
                        .font(.system(size: 11, weight: .bold))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(IconButtonStyle())
                .help("Reconnect session")
            } else if canInterruptCurrentRun {
                Button {
                    backendClient.interruptSelectedSession()
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(IconButtonStyle())
                .help("Stop current run")
            }
        }
    }

    private var canInterruptCurrentRun: Bool {
        backendClient.selectedDetail?.status == .running
            && backendClient.selectedDetail?.capabilities?.canInterrupt == true
    }
}

private struct DetailMessagesPlaceholder: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(0..<2, id: \.self) { index in
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(CorptiePalette.primaryText.opacity(index == 1 ? 0.08 : 0.12))
                    .frame(height: index == 1 ? 42 : 26)
                    .frame(maxWidth: index == 1 ? 260 : .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .redacted(reason: .placeholder)
        .allowsHitTesting(false)
    }
}

private struct ThreadMetaView: View {
    let detail: CodexThreadDetail

    var body: some View {
        HStack(spacing: 8) {
            ConnectionIndicatorLight(
                color: detail.isConnecting ? CorptiePalette.disconnected : detail.connectionColor,
                size: 8,
                glowSize: 20,
                isBreathing: detail.isConnecting
            )
            Text(detail.status.label)
                .foregroundStyle(detail.status.color)
            if let activityStatus = detail.activityStatus, !activityStatus.isEmpty {
                ActivityStatusText(text: activityStatus, isActive: detail.status == .running)
            }
        }
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(CorptiePalette.secondaryText)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Color.white.opacity(0.1), in: Capsule())
    }
}

struct ConnectionIndicatorLight: View {
    let color: Color
    let size: CGFloat
    let glowSize: CGFloat
    let isBreathing: Bool
    @State private var breathPhase = false

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            color.opacity(0.42),
                            color.opacity(0.22),
                            color.opacity(0.0)
                        ],
                        center: .center,
                        startRadius: 0,
                        endRadius: glowSize / 2
                    )
                )
                .frame(width: glowSize, height: glowSize)

            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            color,
                            color.opacity(0.88)
                        ],
                        center: .center,
                        startRadius: 0,
                        endRadius: size / 2
                    )
                )
                .frame(width: size, height: size)
        }
        .frame(width: glowSize, height: glowSize)
        .opacity(isBreathing ? (breathPhase ? 0.28 : 1.0) : 1.0)
        .animation(.easeInOut(duration: 1.25).repeatForever(autoreverses: true), value: breathPhase)
        .onAppear {
            breathPhase = false
            if isBreathing {
                DispatchQueue.main.async {
                    breathPhase = true
                }
            }
        }
        .onChange(of: isBreathing) { _, nextValue in
            breathPhase = false
            if nextValue {
                DispatchQueue.main.async {
                    breathPhase = true
                }
            }
        }
    }
}

private struct ActivityStatusText: View {
    let text: String
    let isActive: Bool
    @State private var shimmerPhase = false

    var body: some View {
        baseText
            .foregroundStyle(isActive ? AnyShapeStyle(activeGradient) : AnyShapeStyle(idleColor))
            .overlay(shimmerOverlay)
            .onAppear {
                if isActive {
                    withAnimation(.linear(duration: 1.45).repeatForever(autoreverses: false)) {
                        shimmerPhase = true
                    }
                }
            }
            .onChange(of: isActive) { _, value in
                shimmerPhase = false
                if value {
                    withAnimation(.linear(duration: 1.45).repeatForever(autoreverses: false)) {
                        shimmerPhase = true
                    }
                }
            }
    }

    private var baseText: some View {
        Text(text)
            .lineLimit(1)
            .truncationMode(.tail)
    }

    @ViewBuilder
    private var shimmerOverlay: some View {
        if isActive {
            GeometryReader { proxy in
                LinearGradient(
                    colors: [
                        .clear,
                        .white.opacity(0.85),
                        .clear
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .frame(width: max(42, proxy.size.width * 0.38))
                .offset(x: shimmerPhase ? proxy.size.width + 28 : -proxy.size.width * 0.55)
                .blendMode(.screen)
                .allowsHitTesting(false)
            }
            .mask(baseText)
        }
    }

    private var activeGradient: LinearGradient {
        LinearGradient(
            colors: [
                CorptiePalette.connected,
                CorptiePalette.softBlue,
                CorptiePalette.periwinkle
            ],
            startPoint: .leading,
            endPoint: .trailing
        )
    }

    private var idleColor: Color {
        .secondary
    }
}

struct CopyTextButton: View {
    let text: String
    let isVisible: Bool

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        } label: {
            Image(systemName: "doc.on.doc")
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 22, height: 22)
                .foregroundStyle(CorptiePalette.secondaryText)
        }
        .buttonStyle(.plain)
        .background(copyButtonBackground, in: Circle())
        .overlay(
            Circle()
                .strokeBorder(Color.black.opacity(0.06), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.10), radius: 4, y: 2)
        .opacity(isVisible ? 1 : 0)
        .scaleEffect(isVisible ? 1 : 0.88)
        .animation(.easeOut(duration: 0.12), value: isVisible)
        .help("Copy")
        .accessibilityLabel("Copy message")
        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private var copyButtonBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.16, alpha: 0.92)
                : NSColor(calibratedWhite: 1.0, alpha: 0.92)
        })
    }
}

private struct ThreadProcessGroupView: View {
    @State private var isExpanded = false
    let items: [CodexThreadItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeOut(duration: 0.14)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .frame(width: 12, height: 12)
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(CorptiePalette.mutedText.opacity(0.72))
                    Text("已处理")
                        .font(.system(size: 10.5, weight: .semibold))
                    if let durationText {
                        Text(durationText)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(CorptiePalette.mutedText)
                    }
                    Text("\(items.count)")
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(CorptiePalette.mutedText)
                        .padding(.horizontal, 5)
                        .frame(height: 16)
                        .background(Color.black.opacity(0.04), in: Capsule())
                    Spacer(minLength: 0)
                }
                .foregroundStyle(CorptiePalette.secondaryText)
                .padding(.horizontal, 9)
                .frame(height: 26)
                .background(Color.white.opacity(0.42), in: Capsule())
                .overlay(
                    Capsule()
                        .strokeBorder(Color.black.opacity(0.045), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)

            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(items) { item in
                        ProcessMiniCard(item: item)
                    }
                }
                .padding(.leading, 22)
                .padding(.top, 2)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.vertical, 1)
    }

    private var durationText: String? {
        let timestamps = items.compactMap { item -> Date? in
            guard let createdAt = item.createdAt else {
                return nil
            }
            return ISO8601DateFormatter.corptieThreadItemDate(from: createdAt)
        }
        guard let start = timestamps.min(), let end = timestamps.max() else {
            return nil
        }
        let duration = max(0, end.timeIntervalSince(start))
        if duration < 0.95 {
            return "· <1s"
        }
        if duration < 10 {
            return String(format: "· %.1fs", duration)
        }
        return "· \(Int(duration.rounded()))s"
    }
}

private struct ProcessMiniCard: View {
    let item: CodexThreadItem

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 6, height: 6)
                Text(item.title)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(CorptiePalette.secondaryText)
                    .lineLimit(1)
                Spacer(minLength: 6)
                Text(processTypeLabel)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(CorptiePalette.mutedText.opacity(0.78))
            }

            if !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(item.text)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(CorptiePalette.mutedText)
                    .lineSpacing(2)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.34), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.black.opacity(0.045), lineWidth: 1)
        )
    }

    private var dotColor: Color {
        switch item.type {
        case "commandExecution":
            return CorptiePalette.amber
        case "fileChange":
            return CorptiePalette.periwinkle
        case "webSearch":
            return CorptiePalette.softBlue
        case "reasoning", "plan":
            return CorptiePalette.mutedText
        default:
            return CorptiePalette.connected
        }
    }

    private var processTypeLabel: String {
        item.type == "agentMessage" ? "commentary" : item.type
    }
}

private extension ISO8601DateFormatter {
    static func corptieThreadItemDate(from value: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: value) {
            return date
        }
        let withoutFraction = ISO8601DateFormatter()
        withoutFraction.formatOptions = [.withInternetDateTime]
        return withoutFraction.date(from: value)
    }
}

private struct ThreadItemView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @State private var isActivityExpanded = false
    @State private var isHovering = false
    let item: CodexThreadItem

    var body: some View {
        if isHandledPermissionItem {
            handledPermissionView
        } else {
            fullItemView
        }
    }

    private var fullItemView: some View {
        ZStack(alignment: .bottomTrailing) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(item.title)
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(itemColor)
                    Spacer()
                    Text(itemMetadataLabel)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(CorptiePalette.mutedText)
                }

                if !item.text.isEmpty {
                    if item.type == "agentMessage" {
                        agentMessageTextView
                    } else {
                        messageTextView(text: item.text, allowsSelection: true)
                    }
                }

                if shouldShowOptions {
                    optionButtonStack {
                        ForEach(approvalOptions) { option in
                            Button {
                                if item.type == "approval" {
                                    backendClient.respondToCodexApproval(option: option)
                                } else if item.type == "choice" {
                                    backendClient.respondToPtyChoice(option: option, choiceId: item.id)
                                } else {
                                    backendClient.sendMessage(option.label)
                                }
                            } label: {
                                Label(option.label, systemImage: iconName(for: option))
                                    .font(.system(size: 11, weight: .bold))
                                    .padding(.horizontal, 10)
                                    .frame(maxWidth: item.type == "agentMessage" ? .infinity : nil, minHeight: 28, alignment: .leading)
                                    .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .background(optionBackground(for: option), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .strokeBorder(optionBorder(for: option), lineWidth: 1)
                            )
                            .help(option.label)
                        }
                    }
                    .padding(.top, 2)
                    .disabled(backendClient.isSendingMessage)
                    .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .topLeading)))
                }
            }

            CopyTextButton(text: item.text, isVisible: isHovering && !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .padding(4)
        }
        .padding(10)
        .background(itemBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(itemBorder, lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.04), radius: 8, y: 3)
        .onHover { hovering in
            isHovering = hovering
        }
        .animation(.easeInOut(duration: 0.18), value: shouldShowOptions)
    }

    private var itemMetadataLabel: String {
        [itemRoleLabel, itemTimeLabel].compactMap { value in
            guard let value, !value.isEmpty else {
                return nil
            }
            return value
        }.joined(separator: " ")
    }

    private var itemRoleLabel: String {
        switch item.type {
        case "userMessage":
            return "User"
        case "agentMessage":
            return "Agent"
        default:
            return "System"
        }
    }

    private var itemTimeLabel: String? {
        guard let createdAt = item.createdAt,
              let date = ISO8601DateFormatter.corptieThreadItemDate(from: createdAt) else {
            return nil
        }
        return Self.metadataDateFormatter.string(from: date)
    }

    private static let metadataDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MM/dd HH:mm"
        return formatter
    }()

    private var handledPermissionView: some View {
        DisclosureGroup(isExpanded: $isActivityExpanded) {
            VStack(alignment: .leading, spacing: 8) {
                if !item.text.isEmpty {
                    messageTextView(text: item.text, allowsSelection: true)
                }
                if let selected = item.options?.first(where: { $0.selected == true }) {
                    Label("Selected: \(selected.label)", systemImage: "checkmark.circle.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(CorptiePalette.connected)
                }
            }
            .padding(.top, 6)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.shield.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(CorptiePalette.connected)
                Text("已处理的权限请求")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(CorptiePalette.secondaryText)
                if let selected = item.options?.first(where: { $0.selected == true }) {
                    Text(selected.label)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(CorptiePalette.connected)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(CorptiePalette.connected.opacity(0.10), in: Capsule())
                }
            }
        }
        .font(.system(size: 11, weight: .medium))
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.black.opacity(0.025), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.black.opacity(0.06), lineWidth: 1)
        )
        .animation(.easeInOut(duration: 0.18), value: isActivityExpanded)
    }

    private var isHandledPermissionItem: Bool {
        item.type == "choice"
            && item.status == "selected"
            && item.title == "Claude tool approval"
            && approvalOptions.contains { option in
                option.role?.localizedCaseInsensitiveContains("approve") == true
                    || option.role?.localizedCaseInsensitiveContains("deny") == true
            }
    }

    private var itemBackground: Color {
        item.type == "approval" || item.type == "choice" ? Color(nsColor: NSColor(calibratedRed: 1.0, green: 0.98, blue: 0.91, alpha: 1)) : Color.white
    }

    private var itemBorder: Color {
        item.type == "approval" || item.type == "choice" ? CorptiePalette.amber.opacity(0.32) : Color.black.opacity(0.08)
    }

    private var itemColor: Color {
        switch item.type {
        case "userMessage": CorptiePalette.userText
        case "approval", "choice": CorptiePalette.amber
        case "agentMessage": CorptiePalette.agentText
        case "commandExecution": CorptiePalette.amber
        case "fileChange": CorptiePalette.periwinkle
        default: .secondary
        }
    }

    @ViewBuilder
    private var agentMessageTextView: some View {
        let parsed = AgentMessageParts.parse(item.text)
        if !parsed.activity.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    withAnimation(.easeOut(duration: 0.12)) {
                        isActivityExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: isActivityExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .bold))
                        Text(parsed.activitySummary)
                            .font(.system(size: 10.5, weight: .semibold))
                            .lineLimit(1)
                        Spacer(minLength: 6)
                    }
                    .foregroundStyle(CorptiePalette.mutedText)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(Color.black.opacity(0.035), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)

                if isActivityExpanded {
                    Text(parsed.activity)
                        .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(CorptiePalette.mutedText)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 7)
                        .background(Color.black.opacity(0.025), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
        }

        if !parsed.body.isEmpty {
            messageTextView(text: parsed.body, allowsSelection: true)
        }
    }

    private func markdownText(for text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }

    @ViewBuilder
    private func messageTextView(text: String, allowsSelection: Bool) -> some View {
        if shouldUsePlainTextRendering(text) {
            Text(text)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(CorptiePalette.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            if allowsSelection {
                Text(markdownText(for: text))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            } else {
                Text(markdownText(for: text))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func shouldUsePlainTextRendering(_ text: String) -> Bool {
        text.count > 4_000 || text.filter(\.isNewline).count > 80
    }

    private var approvalOptions: [CodexApprovalOption] {
        if let options = item.options, !options.isEmpty {
            return options
        }
        return [
            CodexApprovalOption(id: "approve", label: "Approve", role: "approve", index: 0, selected: true),
            CodexApprovalOption(id: "deny", label: "Deny", role: "deny", index: 1, selected: false)
        ]
    }

    private var shouldShowOptions: Bool {
        guard item.status != "selected" else {
            return false
        }
        guard let options = item.options, !options.isEmpty else {
            return item.type == "approval" || item.type == "choice"
        }
        return item.type == "approval" || item.type == "choice" || item.type == "agentMessage"
    }

    @ViewBuilder
    private func optionButtonStack<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        if item.type == "agentMessage" {
            VStack(alignment: .leading, spacing: 7) {
                content()
            }
        } else {
            HStack(spacing: 8) {
                content()
                Spacer()
            }
        }
    }

    private func iconName(for option: CodexApprovalOption) -> String {
        if option.role == "message-choice" {
            return "arrow.turn.down.right"
        }
        return option.role?.localizedCaseInsensitiveContains("deny") == true ? "xmark" : "checkmark"
    }

    private func optionBackground(for option: CodexApprovalOption) -> Color {
        option.role?.localizedCaseInsensitiveContains("deny") == true
            ? Color.red.opacity(0.08)
            : CorptiePalette.connected.opacity(0.14)
    }

    private func optionBorder(for option: CodexApprovalOption) -> Color {
        option.role?.localizedCaseInsensitiveContains("deny") == true
            ? Color.red.opacity(0.24)
            : CorptiePalette.connected.opacity(0.34)
    }
}

private struct AgentMessageParts {
    let activity: String
    let body: String

    var activitySummary: String {
        let lines = activity
            .split(separator: "\n")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let toolLines = lines.filter { line in
            line.localizedCaseInsensitiveContains("searching")
                || line.localizedCaseInsensitiveContains("searched")
                || line.localizedCaseInsensitiveContains("running")
                || line.localizedCaseInsensitiveContains("using")
                || line.localizedCaseInsensitiveContains("reading")
                || line.localizedCaseInsensitiveContains("tool")
        }
        if toolLines.isEmpty {
            return "过程记录 · 展开"
        }
        return "过程记录 · \(toolLines.count) 步 · 展开"
    }

    static func parse(_ rawText: String) -> AgentMessageParts {
        let cleaned = rawText
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
            .filter { !isNoiseLine($0) }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard let dividerRange = dividerRange(in: cleaned) else {
            return AgentMessageParts(activity: "", body: cleaned)
        }

        let activity = String(cleaned[..<dividerRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        let body = String(cleaned[dividerRange.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else {
            return AgentMessageParts(activity: "", body: cleaned)
        }
        return AgentMessageParts(activity: normalizeActivity(activity), body: body)
    }

    private static func dividerRange(in text: String) -> Range<String.Index>? {
        var cursor = text.startIndex
        while cursor < text.endIndex {
            let lineEnd = text[cursor...].firstIndex(of: "\n") ?? text.endIndex
            let line = String(text[cursor..<lineEnd]).trimmingCharacters(in: .whitespacesAndNewlines)
            if isDividerLine(line) {
                return cursor..<lineEnd
            }
            cursor = lineEnd == text.endIndex ? text.endIndex : text.index(after: lineEnd)
        }
        return nil
    }

    private static func isDividerLine(_ line: String) -> Bool {
        guard line.count >= 12 else {
            return false
        }
        return line.allSatisfy { character in
            character == "-" || character == "─" || character == "—" || character == "━"
        }
    }

    private static func isNoiseLine(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.hasPrefix("⚠ Skill descriptions were shortened")
            || trimmed.localizedCaseInsensitiveContains("skills context budget")
    }

    private static func normalizeActivity(_ text: String) -> String {
        text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line in
                String(line)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .replacingOccurrences(of: #"^•\s*"#, with: "", options: .regularExpression)
            }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
    }
}

private struct MessageComposer: View {
    @EnvironmentObject private var backendClient: BackendClient
    @Binding var message: String
    @FocusState private var isFocused: Bool
    @State private var composerWidth: CGFloat = 0

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                ChatInputTextView(
                    text: $message,
                    placeholder: "Send a instruction",
                    font: .systemFont(ofSize: 12, weight: .medium),
                    isEditable: true,
                    onFocusChange: { isFocused = $0 },
                    onSubmit: send
                )
                    .frame(height: 32)
                    .padding(.leading, 10)
                    .padding(.trailing, 2)
                    .onTapGesture {
                        isFocused = true
                    }
                    .disabled(false)

                Button {
                    if isRunningTurn {
                        backendClient.interruptSelectedSession()
                    } else {
                        send()
                    }
                } label: {
                    if backendClient.isSendingMessage {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: 28, height: 28)
                    } else if isRunningTurn {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 10, weight: .bold))
                            .frame(width: 28, height: 28)
                    } else {
                        Image(systemName: "paperplane.fill")
                            .font(.system(size: 11, weight: .bold))
                            .frame(width: 28, height: 28)
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(CorptiePalette.softBlue)
                .disabled(isSendDisabled)
                .help(isRunningTurn ? "Stop current run" : "Send instruction")
                .padding(.trailing, 6)
            }
            .background(Color.white, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .strokeBorder(Color.black.opacity(isFocused ? 0.16 : 0.08), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.04), radius: 8, y: 3)

            if canSwitchModel {
                CodexModelMenu(maxWidth: modelMenuMaxWidth)
            }
        }
        .background(
            GeometryReader { proxy in
                Color.clear.preference(key: ComposerWidthPreferenceKey.self, value: proxy.size.width)
            }
        )
        .onPreferenceChange(ComposerWidthPreferenceKey.self) { width in
            composerWidth = width
        }
        .opacity(backendClient.selectedDetail?.canSend == false && !isRunningTurn ? 0.55 : 1)
        .task {
            let provider = backendClient.selectedSession?.external?.provider ?? "codex-pty"
            if backendClient.codexModels.isEmpty || backendClient.loadedModelProvider != provider {
                await backendClient.loadModelsForSelectedSession()
            }
        }
    }

    private func send() {
        guard backendClient.selectedDetail?.canSend != false else {
            return
        }
        let text = message
        backendClient.sendMessage(text) {
            message = ""
        }
    }

    private var isRunningTurn: Bool {
        backendClient.selectedDetail?.canSend == false
            && backendClient.selectedDetail?.capabilities?.canInterrupt == true
    }

    private var isSendDisabled: Bool {
        if isRunningTurn {
            return backendClient.isSendingMessage
        }
        return message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || backendClient.isSendingMessage
            || backendClient.selectedDetail?.canSend == false
    }

    private var canSwitchModel: Bool {
        backendClient.selectedDetail?.capabilities?.canSwitchModel
            ?? backendClient.selectedSession?.capabilities?.canSwitchModel
            ?? (backendClient.selectedSession?.agent == "Codex" ? true : false)
    }

    private var modelMenuMaxWidth: CGFloat {
        guard composerWidth > 0 else {
            return 74
        }
        return max(54, min(74, composerWidth / 6))
    }
}

private struct ComposerWidthPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct CodexModelMenu: View {
    @EnvironmentObject private var backendClient: BackendClient
    let maxWidth: CGFloat

    var body: some View {
        Menu {
            if backendClient.isLoadingCodexModels {
                Text("Loading models")
            } else if backendClient.codexModels.isEmpty {
                Button {
                    Task {
                        await backendClient.loadModelsForSelectedSession(forceRefresh: true)
                    }
                } label: {
                    Label("Reload models", systemImage: "arrow.clockwise")
                }
            } else {
                ForEach(backendClient.codexModels) { model in
                    Button {
                        backendClient.switchSelectedCodexModel(to: model)
                    } label: {
                        HStack {
                            Text(model.name)
                            if model.id == currentModelId {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                    .help(model.description ?? model.id)
                }

                Divider()

                if supportsReasoningSwitch {
                    Divider()

                    Menu {
                        if currentReasoningLevels.isEmpty {
                            Text("No reasoning options")
                        } else {
                            ForEach(currentReasoningLevels, id: \.self) { reasoningLevel in
                                Button {
                                    backendClient.switchSelectedCodexReasoning(to: reasoningLevel)
                                } label: {
                                    HStack {
                                        Text(reasoningLabel(reasoningLevel))
                                        if reasoningLevel == currentReasoningLevel {
                                            Image(systemName: "checkmark")
                                        }
                                    }
                                }
                                .help(reasoningDescription(reasoningLevel))
                            }
                        }
                    } label: {
                        Label("Reasoning: \(reasoningLabel(currentReasoningLevel))", systemImage: "brain")
                    }
                    .disabled(currentReasoningLevels.isEmpty || backendClient.isSwitchingReasoning)
                }

                Button {
                    Task {
                        await backendClient.loadModelsForSelectedSession(forceRefresh: true)
                    }
                } label: {
                    Label("Reload models", systemImage: "arrow.clockwise")
                }
            }
        } label: {
            HStack(spacing: 4) {
                if backendClient.isSwitchingModel || backendClient.isSwitchingReasoning || backendClient.isLoadingCodexModels {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 16, height: 16)
                }
                Text(currentModelLabel)
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(reasoningShortLabel(currentReasoningLevel))
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundStyle(CorptiePalette.secondaryText)
                    .lineLimit(1)
            }
            .foregroundStyle(CorptiePalette.primaryText)
            .frame(maxWidth: maxWidth)
            .padding(.horizontal, 8)
            .frame(height: 30)
            .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
            )
        }
        .menuStyle(.borderlessButton)
        .disabled(backendClient.selectedDetail?.canSend == false || backendClient.isSwitchingModel || backendClient.isSwitchingReasoning)
        .help(currentModelHelp)
    }

    private var currentModelId: String {
        backendClient.selectedDetail?.currentModel
            ?? backendClient.selectedSession?.external?.currentModel
            ?? backendClient.codexDefaultModel
            ?? ""
    }

    private var currentModelLabel: String {
        guard !currentModelId.isEmpty else {
            return "Model"
        }
        return backendClient.codexModels.first(where: { $0.id == currentModelId })?.name ?? currentModelId
    }

    private var currentModelHelp: String {
        let action = supportsReasoningSwitch ? "Switch model or reasoning" : "Switch model"
        guard currentModelLabel != "Model" else {
            return action
        }
        return "\(action): \(currentModelLabel)"
    }

    private var currentModel: CodexModel? {
        backendClient.codexModels.first(where: { $0.id == currentModelId })
    }

    private var currentReasoningLevel: String {
        backendClient.selectedDetail?.currentReasoningLevel
            ?? backendClient.selectedSession?.external?.currentReasoningLevel
            ?? currentModel?.defaultReasoningLevel
            ?? backendClient.codexDefaultReasoningLevel
            ?? "medium"
    }

    private var currentReasoningLevels: [String] {
        guard supportsReasoningSwitch else {
            return []
        }
        return currentModel?.reasoningLevels ?? []
    }

    private var supportsReasoningSwitch: Bool {
        backendClient.selectedDetail?.capabilities?.canSwitchReasoning
            ?? backendClient.selectedSession?.capabilities?.canSwitchReasoning
            ?? false
    }

    private var currentProvider: String {
        backendClient.selectedSession?.external?.provider ?? "codex-pty"
    }

    private func reasoningLabel(_ value: String) -> String {
        switch value.lowercased() {
        case "low": "Low"
        case "medium": "Medium"
        case "high": "High"
        case "xhigh": "Extra High"
        default: value
        }
    }

    private func reasoningShortLabel(_ value: String) -> String {
        switch value.lowercased() {
        case "low": "L"
        case "medium": "M"
        case "high": "H"
        case "xhigh": "XH"
        default: value.uppercased()
        }
    }

    private func reasoningDescription(_ value: String) -> String {
        switch value.lowercased() {
        case "low": "Fast responses with lighter reasoning"
        case "medium": "Balanced speed and reasoning"
        case "high": "Greater reasoning depth"
        case "xhigh": "Extra high reasoning depth"
        default: value
        }
    }
}

struct ChatInputTextView: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let font: NSFont
    var isEditable = true
    var autoFocus = false
    var textInsetHeight: CGFloat = 6
    var onFocusChange: (Bool) -> Void = { _ in }
    let onSubmit: () -> Void

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.borderType = .noBorder
        scrollView.automaticallyAdjustsContentInsets = false
        scrollView.contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)

        let textView = SubmitTextView()
        textView.delegate = context.coordinator
        textView.onSubmit = onSubmit
        textView.onFocusChange = onFocusChange
        textView.placeholder = placeholder
        textView.font = font
        textView.drawsBackground = false
        textView.isRichText = false
        textView.isEditable = isEditable
        textView.isSelectable = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainerInset = NSSize(width: 0, height: textInsetHeight)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.autoresizingMask = [.width]
        textView.string = text

        scrollView.documentView = textView
        context.coordinator.textView = textView

        if autoFocus {
            DispatchQueue.main.async {
                textView.window?.makeFirstResponder(textView)
            }
        }

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? SubmitTextView else {
            return
        }
        textView.onSubmit = onSubmit
        textView.onFocusChange = onFocusChange
        textView.placeholder = placeholder
        textView.font = font
        textView.isEditable = isEditable
        textView.textContainerInset = NSSize(width: 0, height: textInsetHeight)
        if !textView.hasMarkedText(), textView.string != text {
            textView.string = text
        }
        if autoFocus, textView.window?.firstResponder !== textView {
            DispatchQueue.main.async {
                textView.window?.makeFirstResponder(textView)
            }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        weak var textView: SubmitTextView?

        init(text: Binding<String>) {
            _text = text
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else {
                return
            }
            text = textView.string
        }
    }

    final class SubmitTextView: NSTextView {
        var onSubmit: (() -> Void)?
        var onFocusChange: ((Bool) -> Void)?
        var placeholder = "" {
            didSet {
                needsDisplay = true
            }
        }

        override func keyDown(with event: NSEvent) {
            let isReturn = event.keyCode == 36 || event.keyCode == 76
            let wantsNewline = event.modifierFlags.contains(.shift)
            if isReturn, hasMarkedText() {
                super.keyDown(with: event)
                return
            }
            if isReturn && !wantsNewline {
                onSubmit?()
                return
            }
            super.keyDown(with: event)
        }

        override func becomeFirstResponder() -> Bool {
            let result = super.becomeFirstResponder()
            if result {
                onFocusChange?(true)
            }
            return result
        }

        override func resignFirstResponder() -> Bool {
            let result = super.resignFirstResponder()
            if result {
                onFocusChange?(false)
            }
            return result
        }

        override func draw(_ dirtyRect: NSRect) {
            super.draw(dirtyRect)
            guard string.isEmpty, !placeholder.isEmpty else {
                return
            }
            let attributes: [NSAttributedString.Key: Any] = [
                .font: font ?? NSFont.systemFont(ofSize: 12),
                .foregroundColor: NSColor.secondaryLabelColor
            ]
            let textSize = placeholder.size(withAttributes: attributes)
            let centeredY = max(0, (bounds.height - textSize.height) / 2)
            let origin = NSPoint(x: textContainerInset.width, y: centeredY)
            placeholder.draw(at: origin, withAttributes: attributes)
        }
    }
}

private struct QuickReplyField: View {
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    let isSending: Bool
    let placeholder: String
    let onInteract: () -> Void
    let send: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            ChatInputTextView(
                text: $text,
                placeholder: placeholder,
                font: .systemFont(ofSize: 10.5, weight: .medium),
                textInsetHeight: 2,
                onFocusChange: { focused in
                    isFocused.wrappedValue = focused
                    if focused {
                        onInteract()
                    }
                },
                onSubmit: sendIfPossible
            )
                .frame(height: 20)
                .padding(.leading, 7)
                .padding(.trailing, 3)
                .padding(.vertical, 2)

            Button {
                sendIfPossible()
            } label: {
                if isSending {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 20, height: 20)
                } else {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 9.5, weight: .bold))
                        .frame(width: 20, height: 20)
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? CorptiePalette.disabledText : CorptiePalette.softBlue)
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
            .help("Send reply")
        }
        .frame(height: 26)
        .simultaneousGesture(TapGesture().onEnded(onInteract))
        .background(isFocused.wrappedValue ? CorptiePalette.inputFillFocused : CorptiePalette.inputFill, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(isFocused.wrappedValue ? CorptiePalette.inputBorderFocused : CorptiePalette.inputBorder, lineWidth: isFocused.wrappedValue ? 1.25 : 1)
        )
    }

    private func sendIfPossible() {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending {
            return
        }
        send()
    }
}

private struct ReadOnlyComposer: View {
    let reason: String?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "lock.fill")
                .font(.system(size: 11, weight: .bold))
                .frame(width: 28, height: 28)
                .foregroundStyle(CorptiePalette.secondaryText)

            Text(reason ?? "This session is read-only in Corptie.")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CorptiePalette.secondaryText)
                .lineLimit(2)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
        )
    }
}

private struct OfflineView: View {
    let error: String?

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "bolt.horizontal.circle")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.orange)
            Text("Backend offline")
                .font(.system(size: 15, weight: .semibold))
            Text(error ?? "Start the Node.js runtime to see agent tasks.")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(CorptiePalette.secondaryText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct ReadyEmptyView: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(CorptiePalette.connected)
            Text("Backend ready")
                .font(.system(size: 15, weight: .semibold))
            Text("Click the + button in the lower-left corner to create a session.")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(CorptiePalette.secondaryText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct IconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.primary)
            .background(Color.white.opacity(configuration.isPressed ? 0.24 : 0.13), in: Circle())
            .overlay(Circle().strokeBorder(Color.white.opacity(0.16), lineWidth: 1))
            .contentShape(Circle())
    }
}
