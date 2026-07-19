import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct FloatingRootView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var appLanguage = AppLanguageController.shared
    @EnvironmentObject private var panelLayoutState: PanelLayoutState
    @EnvironmentObject private var panelFocusState: PanelFocusState
    @EnvironmentObject private var detachedSessionManager: DetachedSessionManager
    @StateObject private var newSessionPanel = NewSessionPanelController()
    @StateObject private var externalMenuPanel = ExternalMenuPanelController()
    @State private var isShowingActionMenu = false
    @State private var isShowingLayoutMenu = false
    @State private var isHoveringExternalControls = false
    @State private var isShowingDetailSessionRail = false
    @State private var detailSessionRailCloseTask: Task<Void, Never>?
    @State private var actionMenuAnchor = CGRect.zero
    @State private var layoutMenuAnchor = CGRect.zero
    @State private var externalControlsWindow: NSWindow?
    @State private var draggedSessionId: String?
    @State private var sessionCardFrames: [String: CGRect] = [:]
    @State private var sessionCardFramesLayoutKey: String?
    @State private var sessionSummaryFrames: [String: CGRect] = [:]
    @State private var reorderDragOffsetY: CGFloat = 0
    @State private var reorderTargetSessionId: String?
    @State private var hasResolvedReorderTarget = false
    @State private var hoverPreviewSessionId: String?
    @State private var isHoveringReplyPreviewBubble = false
    @State private var hoverPreviewCloseTask: Task<Void, Never>?
    @State private var detailPreheatTasks: [String: Task<Void, Never>] = [:]
    @State private var detailDisplayCacheBySessionId: [String: DetailDisplayCache] = [:]
    @State private var listHeightMeasurements: [ListHeightMetric: CGFloat] = [:]
    @State private var isSearching = false
    @State private var searchText = ""
    @FocusState private var isSearchFieldFocused: Bool
    @AppStorage("sessionDisplayMode") private var sessionDisplayModeRawValue = SessionDisplayMode.cards.rawValue
    @AppStorage("groupsSessionsByProject") private var groupsSessionsByProject = false
    private let panelContentPadding: CGFloat = 14
    private let detailSessionRailGutter: CGFloat = 78
    private let listContentFrameKey = "__corptie_list_content__"
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
                            sessionListView
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

            HoverRevealCloseButton()
                .padding(.top, topBarControlTopInset)
                .padding(.leading, closeButtonLeadingInset)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .zIndex(0)
        }
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .animation(.spring(response: 0.28, dampingFraction: 0.88), value: newSessionPanel.isPresented)
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12 + 0.1 * glassStrength), lineWidth: 1)
        )
        .overlay(alignment: .bottomTrailing) {
            if CorptieAppEnvironment.isDevelopment {
                EnvironmentModeBadge()
                    .allowsHitTesting(false)
                    .padding(.bottom, 10)
                    .padding(.trailing, 10)
                    .zIndex(4)
            }
        }
        .padding(.leading, leadingPanelGutter)
        .overlay {
            if isShowingActionMenu || isShowingLayoutMenu {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { dismissExternalMenus() }
            }
        }
        .overlay(alignment: .bottomLeading) {
            GeometryReader { proxy in
                if backendClient.selectedSession == nil && !newSessionPanel.isPresented {
                    externalSessionControls
                    .padding(.leading, 4)
                    .padding(.bottom, panelContentPadding)
                    .opacity(showsExternalSessionControls ? 1 : 0)
                    .scaleEffect(showsExternalSessionControls ? 1 : 0.94, anchor: .bottomLeading)
                    .allowsHitTesting(showsExternalSessionControls)
                    .onHover { isHoveringExternalControls = $0 }
                    .animation(.easeOut(duration: 0.16), value: showsExternalSessionControls)
                    .frame(
                        maxWidth: .infinity,
                        maxHeight: .infinity,
                        alignment: .bottomLeading
                    )
                }
            }
        }
        .overlay(alignment: .leading) {
            detailSessionRailOverlay
        }
        .overlay(alignment: .bottom) {
            BottomEdgeResizeHandle()
                .frame(maxWidth: .infinity)
                .frame(height: 5)
                .zIndex(20)
        }
        .frame(minWidth: 360, idealWidth: 420, maxWidth: .infinity, minHeight: 92, idealHeight: 410, maxHeight: .infinity)
        .onChange(of: backendClient.selectedSession?.id) { _, _ in
            dismissExternalMenus()
            newSessionPanel.close()
        }
        .onChange(of: panelFocusState.isFocused) { _, isFocused in
            if !isFocused { dismissExternalMenus() }
        }
        .environment(\.locale, appLanguage.locale)
    }

    private var glassStrength: Double {
        0.55
    }

    private func dismissExternalMenus() {
        withAnimation(.spring(response: 0.22, dampingFraction: 0.88)) {
            isShowingActionMenu = false
            isShowingLayoutMenu = false
        }
        externalMenuPanel.close()
    }

    private var showsExternalSessionControls: Bool {
        panelFocusState.isFocused || isHoveringExternalControls || isShowingActionMenu || isShowingLayoutMenu
    }

    private var externalSessionControls: some View {
        VStack(alignment: .leading, spacing: 7) {
            FloatingActionMenu(
                isExpanded: $isShowingActionMenu,
                anchorChanged: updateActionMenuAnchor,
                openMenu: showActionMenu,
                closeMenu: dismissExternalMenus
            )

            FloatingLayoutMenu(
                isExpanded: $isShowingLayoutMenu,
                displayModeRawValue: $sessionDisplayModeRawValue,
                groupsByProject: $groupsSessionsByProject,
                anchorChanged: updateLayoutMenuAnchor,
                openMenu: showLayoutMenu,
                closeMenu: dismissExternalMenus
            )
        }
    }

    private func updateActionMenuAnchor(_ rect: CGRect, window: NSWindow?) {
        actionMenuAnchor = rect
        externalControlsWindow = window
        if isShowingActionMenu {
            externalMenuPanel.reposition(anchor: rect)
        }
    }

    private func updateLayoutMenuAnchor(_ rect: CGRect, window: NSWindow?) {
        layoutMenuAnchor = rect
        externalControlsWindow = window
        if isShowingLayoutMenu {
            externalMenuPanel.reposition(anchor: rect)
        }
    }

    private func showActionMenu() {
        guard let externalControlsWindow, actionMenuAnchor != .zero else { return }
        isShowingLayoutMenu = false
        isShowingActionMenu = true
        externalMenuPanel.show(
            parent: externalControlsWindow,
            anchor: actionMenuAnchor,
            contentSize: NSSize(width: 170, height: 120)
        ) {
            ExternalActionPanelContent(
                isBusy: backendClient.isCreatingTask,
                createTask: {
                    dismissExternalMenus()
                    newSessionPanel.show(backendClient: backendClient)
                },
                search: {
                    dismissExternalMenus()
                    withAnimation(.spring(response: 0.30, dampingFraction: 0.86)) {
                        isSearching = true
                    }
                    DispatchQueue.main.async { isSearchFieldFocused = true }
                }
            )
        }
    }

    private func showLayoutMenu() {
        guard let externalControlsWindow, layoutMenuAnchor != .zero else { return }
        isShowingActionMenu = false
        isShowingLayoutMenu = true
        externalMenuPanel.show(
            parent: externalControlsWindow,
            anchor: layoutMenuAnchor,
            contentSize: NSSize(width: 196, height: 142)
        ) {
            ExternalLayoutPanelContent(
                displayMode: displayMode,
                groupsByProject: groupsSessionsByProject,
                selectDisplayMode: { mode in
                    sessionDisplayModeRawValue = mode.rawValue
                    dismissExternalMenus()
                },
                toggleGrouping: {
                    groupsSessionsByProject.toggle()
                    dismissExternalMenus()
                }
            )
        }
    }

    private var sessionListView: some View {
        VStack(alignment: .leading, spacing: 10) {
            if isSearching {
                sessionSearchBar
                    .transition(.move(edge: .top).combined(with: .opacity))
            }

            if backendClient.sessions.isEmpty {
                ReadyEmptyView()
                    .measureListHeight(.cards)
            } else if filteredSessions.isEmpty {
                ContentUnavailableView.search(text: searchText)
                    .frame(maxWidth: .infinity, minHeight: 150)
                    .measureListHeight(.cards)
            } else {
                NativeSessionScrollView {
                    LazyVStack(alignment: .leading, spacing: displayMode == .cards ? PanelLayoutState.cardSpacing : 4) {
                        ForEach(sessionGroups) { group in
                            if groupsSessionsByProject {
                                ProjectGroupHeader(path: group.path, count: group.sessions.count)
                                    .padding(.top, group.id == sessionGroups.first?.id ? 0 : 8)
                            }
                            ForEach(group.sessions) { session in
                                sessionItem(for: session)
                            }
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .animation(.spring(response: 0.30, dampingFraction: 0.84), value: filteredSessions.map(\.id))
                    .measureSessionCardFrame(listContentFrameKey)
                    .measureListHeight(.cards)
                }
                .id(listLayoutKey)
                .measureListGlobalMinY(.scrollTop)
                .coordinateSpace(name: "session-list")
                .overlay(alignment: .topLeading) {
                    if displayMode == .cards { sessionHoverPreviewOverlay }
                }
            }
        }
        .animation(.spring(response: 0.30, dampingFraction: 0.86), value: isSearching)
        .measureListGlobalMinY(.browserTop)
        .onPreferenceChange(SessionCardFramePreferenceKey.self) { frames in
            guard draggedSessionId == nil else {
                return
            }
            sessionCardFrames = frames
            sessionCardFramesLayoutKey = listLayoutKey
            logListGeometry(trigger: "card-frames", frames: frames)
            updatePreferredListHeight(listHeightMeasurements)
        }
        .onPreferenceChange(SessionSummaryFramePreferenceKey.self) { frames in
            guard draggedSessionId == nil else {
                return
            }
            sessionSummaryFrames = frames
        }
        .onChange(of: sessionDisplayModeRawValue) { _, _ in
            sessionCardFrames = [:]
            sessionCardFramesLayoutKey = nil
            logListGeometry(trigger: "display-mode")
        }
        .onChange(of: groupsSessionsByProject) { _, _ in
            sessionCardFrames = [:]
            sessionCardFramesLayoutKey = nil
        }
    }

    private var displayMode: SessionDisplayMode {
        get { SessionDisplayMode(rawValue: sessionDisplayModeRawValue) ?? .cards }
        nonmutating set { sessionDisplayModeRawValue = newValue.rawValue }
    }

    private var leadingPanelGutter: CGFloat {
        backendClient.selectedSession != nil && backendClient.sessions.count > 1
            ? detailSessionRailGutter
            : PanelLayoutState.externalControlsGutter
    }

    private func detailSessionRail(height: CGFloat) -> some View {
        ScrollView(.vertical, showsIndicators: false) {
            LazyVStack(spacing: 6) {
                ForEach(backendClient.sessions) { session in
                    let isSelected = backendClient.selectedSession?.id == session.id
                    Button {
                        guard !isSelected else { return }
                        preheatDetail(for: session)
                        backendClient.select(session: session)
                    } label: {
                        detailSessionRailButtonLabel(session: session, isSelected: isSelected)
                    }
                    .buttonStyle(.plain)
                    .help("\(session.title)\n\(session.status.label)")
                    .onHover { hovering in
                        if hovering {
                            preheatDetail(for: session)
                        }
                    }
                }
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 2)
        }
        .frame(width: detailSessionRailGutter - 8, height: height)
        .background {
            LiquidGlassControlBackground(cornerRadius: 26)
        }
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(Color.white.opacity(0.18), lineWidth: 1)
        }
    }

    @ViewBuilder
    private func detailSessionRailButtonLabel(session: TaskSession, isSelected: Bool) -> some View {
        VStack(spacing: 2) {
            SessionAvatarView(session: session, avatarSize: isSelected ? 38 : 34)
                .frame(width: 58, height: 58)
                .background {
                    detailSessionSelectionBackground(isSelected)
                }

            Text(session.title)
                .font(.system(size: 10, weight: isSelected ? .semibold : .medium, design: .rounded))
                .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(width: 64)
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var detailSessionRailOverlay: some View {
        if backendClient.selectedSession != nil && backendClient.sessions.count > 1 {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Color.black.opacity(0.001)
                        .contentShape(Rectangle())
                        .frame(width: detailSessionRailGutter + 10)
                        .frame(maxHeight: .infinity)

                    if isShowingDetailSessionRail {
                        detailSessionRail(height: proxy.size.height)
                            .padding(.leading, 4)
                            .transition(.opacity.combined(with: .move(edge: .trailing)))
                    }
                }
                .frame(width: detailSessionRailGutter + 10)
                .frame(maxHeight: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .onHover(perform: updateDetailSessionRailHover)
            }
        }
    }

    @ViewBuilder
    private func detailSessionSelectionBackground(_ isSelected: Bool) -> some View {
        if isSelected {
            Circle()
                .fill(Color.white.opacity(0.22))
            Circle()
                .strokeBorder(Color.white.opacity(0.48), lineWidth: 1)
        }
    }

    private func updateDetailSessionRailHover(_ hovering: Bool) {
        detailSessionRailCloseTask?.cancel()
        detailSessionRailCloseTask = nil
        if hovering {
            withAnimation(.easeOut(duration: 0.16)) {
                isShowingDetailSessionRail = true
            }
            return
        }
        detailSessionRailCloseTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.16)) {
                isShowingDetailSessionRail = false
            }
        }
    }

    private var filteredSessions: [TaskSession] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return backendClient.sessions }
        return backendClient.sessions.filter { session in
            [session.title, session.summary, session.agent, session.external?.cwd ?? ""]
                .contains { $0.localizedCaseInsensitiveContains(query) }
        }
    }

    private var sessionGroups: [SessionProjectGroup] {
        guard groupsSessionsByProject else {
            return [SessionProjectGroup(path: "", sessions: filteredSessions)]
        }
        var order: [String] = []
        var grouped: [String: [TaskSession]] = [:]
        for session in filteredSessions {
            let path = session.external?.cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = (path?.isEmpty == false ? path! : "No Project")
            if grouped[key] == nil { order.append(key) }
            grouped[key, default: []].append(session)
        }
        return order.map { SessionProjectGroup(path: $0, sessions: grouped[$0] ?? []) }
    }

    private var sessionSearchBar: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(CorptiePalette.secondaryText)
            TextField(L10n("Search sessions"), text: $searchText)
                .textFieldStyle(.plain)
                .focused($isSearchFieldFocused)
            Button {
                searchText = ""
                withAnimation(.spring(response: 0.25, dampingFraction: 0.86)) {
                    isSearching = false
                }
            } label: {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.plain)
            .foregroundStyle(CorptiePalette.mutedText)
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background { LiquidGlassControlBackground(cornerRadius: 15) }
    }

    @ViewBuilder
    private func sessionItem(for session: TaskSession) -> some View {
        if displayMode == .compact {
            CompactSessionRow(session: session, preheatRequested: preheatDetail)
                .environmentObject(backendClient)
                .environmentObject(detachedSessionManager)
                .measureSessionCardFrame(session.id)
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
        listHeightMeasurements = values
        let cardsHeight = values[.cards] ?? 0
        guard cardsHeight > 0 else {
            return
        }

        let browserTop = values[.browserTop] ?? 0
        let scrollTop = values[.scrollTop] ?? browserTop
        let listTopOffset = max(0, scrollTop - browserTop)
        let outerPadding = panelContentPadding * 2
        let listBottomPadding = PanelLayoutState.listBottomPadding + PanelLayoutState.bottomBreathingRoom
        guard sessionCardFramesLayoutKey == listLayoutKey else { return }
        guard let contentFrame = sessionCardFrames[listContentFrameKey] else { return }
        let orderedFrames = filteredSessions.compactMap { sessionCardFrames[$0.id] }
        guard !orderedFrames.isEmpty else {
            return
        }

        let minimumItemCount: Int = {
            guard displayMode == .cards else { return 1 }
            let leading = Array(filteredSessions.prefix(2))
            return leading.contains { !($0.suggestedOptions ?? []).isEmpty } ? min(2, leading.count) : 1
        }()
        let itemHeights = orderedFrames.map { frame in
            outerPadding
                + listTopOffset
                + max(0, frame.maxY - contentFrame.minY)
                + listBottomPadding
        }
        let minimumHeight = itemHeights[min(max(1, minimumItemCount), itemHeights.count) - 1]
        let preferredHeight = itemHeights[min(3, itemHeights.count) - 1]
        let usefulHeight = itemHeights.last ?? (outerPadding + listTopOffset + cardsHeight)

        if CorptieAppEnvironment.isDevelopment {
            print("[layout-debug] metrics key=\(listLayoutKey) content=\(debugRect(contentFrame)) cardsHeight=\(debugNumber(cardsHeight)) listTop=\(debugNumber(listTopOffset)) itemHeights=\(itemHeights.map(debugNumber).joined(separator: ",")) min=\(debugNumber(minimumHeight)) preferred=\(debugNumber(preferredHeight)) useful=\(debugNumber(usefulHeight))")
        }

        DispatchQueue.main.async {
            panelLayoutState.updateMeasuredListHeights(
                layoutKey: listLayoutKey,
                minimum: minimumHeight,
                preferred: preferredHeight,
                useful: usefulHeight,
                itemHeights: itemHeights
            )
        }
    }

    private var listLayoutKey: String {
        "\(displayMode.rawValue).\(groupsSessionsByProject ? "grouped" : "flat")"
    }

    private func logListGeometry(trigger: String, frames: [String: CGRect]? = nil) {
        guard CorptieAppEnvironment.isDevelopment else { return }
        let values = frames ?? sessionCardFrames
        let content = values[listContentFrameKey].map(debugRect) ?? "nil"
        let cards = filteredSessions.compactMap { session in
            values[session.id].map { "\(session.id.prefix(6)):\(debugRect($0))" }
        }.joined(separator: " ")
        print("[layout-debug] view trigger=\(trigger) key=\(listLayoutKey) content=\(content) cards=[\(cards)]")
    }

    private func debugNumber(_ value: CGFloat) -> String {
        String(format: "%.1f", value)
    }

    private func debugRect(_ rect: CGRect) -> String {
        "x\(debugNumber(rect.minX)) y\(debugNumber(rect.minY)) w\(debugNumber(rect.width)) h\(debugNumber(rect.height))"
    }

    private func reorderGesture(for session: TaskSession) -> some Gesture {
        DragGesture(minimumDistance: 7, coordinateSpace: .named("session-list"))
            .onChanged { value in
                if draggedSessionId != session.id {
                    draggedSessionId = session.id
                    reorderTargetSessionId = nil
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

}

private enum SessionDisplayMode: String {
    case cards
    case compact
}

private struct SessionProjectGroup: Identifiable {
    let path: String
    let sessions: [TaskSession]
    var id: String { path }
}

private struct ProjectGroupHeader: View {
    let path: String
    let count: Int

    private var name: String {
        guard path != "No Project" else { return L10n("No Project") }
        return URL(fileURLWithPath: path).standardizedFileURL.lastPathComponent
    }

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: path == "No Project" ? "folder.badge.questionmark" : "folder.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CorptiePalette.amber)
            Text(name)
                .font(.system(size: 11.5, weight: .semibold))
                .lineLimit(1)
            Text("\(count)")
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .foregroundStyle(CorptiePalette.mutedText)
            Spacer()
        }
        .foregroundStyle(CorptiePalette.secondaryText)
        .padding(.horizontal, 9)
        .help(path)
    }
}

private struct CompactSessionRow: View {
    @EnvironmentObject private var backendClient: BackendClient
    @EnvironmentObject private var detachedSessionManager: DetachedSessionManager
    @State private var isRenaming = false
    let session: TaskSession
    var preheatRequested: (TaskSession) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 10) {
            SessionAvatarView(session: session, avatarSize: 28)
            Text(session.title)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1)
                .layoutPriority(1)
            if let projectPath {
                Text(URL(fileURLWithPath: projectPath).standardizedFileURL.lastPathComponent)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(CorptiePalette.mutedText)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(projectPath)
            }
            Spacer(minLength: 4)
        }
        .padding(.horizontal, 10)
        .frame(height: 42)
        .standardSessionCardSurface()
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onHover { if $0 { preheatRequested(session) } }
        .onTapGesture { backendClient.select(session: session) }
        .contextMenu {
            Button(L10n("Rename"), systemImage: "pencil") { isRenaming = true }
            Button(L10n("Float Session"), systemImage: "rectangle.on.rectangle.circle") {
                detachedSessionManager.float(session: session)
            }
            Button(session.pinned == true ? L10n("Unpin") : L10n("Pin to Top"), systemImage: "pin") {
                backendClient.setPinned(session.pinned != true, session: session)
            }
            Divider()
            Button(L10n("Archive"), systemImage: "archivebox") {
                backendClient.setArchived(true, session: session)
            }
            Button(L10n("Delete"), systemImage: "trash", role: .destructive) {
                backendClient.delete(session: session)
            }
        }
        .sheet(isPresented: $isRenaming) {
            RenameSessionSheet(session: session) { isRenaming = false }
                .environmentObject(backendClient)
                .presentationBackground(.clear)
        }
    }

    private var projectPath: String? {
        let path = session.external?.cwd?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return path.isEmpty ? nil : path
    }
}

private struct LiquidGlassControlBackground: View {
    let cornerRadius: CGFloat

    var body: some View {
        if #available(macOS 26.0, *) {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(.clear)
                .glassEffect(.clear.tint(Color.white.opacity(0.035)), in: .rect(cornerRadius: cornerRadius))
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 0.8)
                }
        } else {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.8)
                }
        }
    }
}

private struct GlassIconButtonStyle: ButtonStyle {
    let isSelected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isSelected ? CorptiePalette.amber : CorptiePalette.primaryText)
            .background { LiquidGlassControlBackground(cornerRadius: 15) }
            .opacity(configuration.isPressed ? 0.68 : 1)
            .scaleEffect(configuration.isPressed ? 0.95 : 1)
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
    @EnvironmentObject private var backendClient: BackendClient
    @EnvironmentObject private var detachedSessionManager: DetachedSessionManager
    @State private var isHovering = false

    var body: some View {
        Button {
            let mainWindow = NSApp.keyWindow
            if let selectedSession = backendClient.selectedSession {
                detachedSessionManager.float(session: selectedSession)
            }
            mainWindow?.orderOut(nil)
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
        .help(L10n("Close"))
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
    case browserTop
    case scrollTop
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

    func measureListGlobalMinY(_ metric: ListHeightMetric) -> some View {
        background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: ListHeightPreferenceKey.self,
                    value: [metric: proxy.frame(in: .global).minY]
                )
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

private struct BottomEdgeResizeHandle: NSViewRepresentable {
    func makeNSView(context: Context) -> ResizeView {
        ResizeView()
    }

    func updateNSView(_ nsView: ResizeView, context: Context) {}

    final class ResizeView: NSView {
        private var startingMouseLocation: NSPoint?
        private var startingFrame: NSRect?

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
            true
        }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            trackingAreas.forEach(removeTrackingArea)
            addTrackingArea(NSTrackingArea(
                rect: bounds,
                options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
                owner: self
            ))
        }

        override func mouseEntered(with event: NSEvent) {
            NSCursor.resizeUpDown.push()
        }

        override func mouseExited(with event: NSEvent) {
            NSCursor.pop()
        }

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            startingMouseLocation = NSEvent.mouseLocation
            startingFrame = window.frame
            (window as? FloatingPanel)?.isPerformingCustomLiveResize = true
        }

        override func mouseDragged(with event: NSEvent) {
            guard let window, let startingMouseLocation, let startingFrame else { return }
            let deltaY = NSEvent.mouseLocation.y - startingMouseLocation.y
            let proposedHeight = startingFrame.height - deltaY
            let height = min(window.maxSize.height, max(window.minSize.height, proposedHeight))
            var frame = startingFrame
            frame.size.height = height
            frame.origin.y = startingFrame.maxY - height
            window.setFrame(frame, display: true)
        }

        override func mouseUp(with event: NSEvent) {
            if let panel = window as? FloatingPanel {
                panel.isPerformingCustomLiveResize = false
                panel.customResizeDidEnd?()
            }
            startingMouseLocation = nil
            startingFrame = nil
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
    let anchorChanged: (CGRect, NSWindow?) -> Void
    let openMenu: () -> Void
    let closeMenu: () -> Void

    var body: some View {
        toggleButton
    }

    @ViewBuilder
    private var toggleButton: some View {
        orbLabel
            .contentShape(Circle())
            .onTapGesture {
                toggleMenu()
            }
            .help(isExpanded ? L10n("Close actions") : L10n("Open actions"))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(isExpanded ? L10n("Close actions") : L10n("Open actions"))
            .accessibilityAddTraits(.isButton)
    }

    private var orbLabel: some View {
        ExternalControlOrbLabel(systemImage: isExpanded ? "xmark" : "plus")
            .background(ExternalControlAnchorReader(anchorChanged: anchorChanged))
    }

    private func toggleMenu() {
        isExpanded ? closeMenu() : openMenu()
    }
}

private struct FloatingLayoutMenu: View {
    @Binding var isExpanded: Bool
    @Binding var displayModeRawValue: String
    @Binding var groupsByProject: Bool
    let anchorChanged: (CGRect, NSWindow?) -> Void
    let openMenu: () -> Void
    let closeMenu: () -> Void

    private var displayMode: SessionDisplayMode {
        SessionDisplayMode(rawValue: displayModeRawValue) ?? .cards
    }

    var body: some View {
        ExternalControlOrbLabel(
            systemImage: isExpanded ? "xmark" : (displayMode == .cards ? "rectangle.grid.1x2" : "list.bullet")
        )
            .background(ExternalControlAnchorReader(anchorChanged: anchorChanged))
            .onTapGesture { toggle() }
            .help(isExpanded ? L10n("Close layout options") : L10n("Layout and grouping"))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(isExpanded ? L10n("Close layout options") : L10n("Layout and grouping"))
            .accessibilityAddTraits(.isButton)
    }

    private func toggle() {
        isExpanded ? closeMenu() : openMenu()
    }
}

private struct ExternalActionPanelContent: View {
    let isBusy: Bool
    let createTask: () -> Void
    let search: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            actionButton(L10n("New Session"), systemImage: "plus.circle.fill", disabled: isBusy, action: createTask)
            actionButton(L10n("Search"), systemImage: "magnifyingglass", disabled: false, action: search)
        }
        .padding(6)
        .background(FloatingActionSurface(cornerRadius: 16))
    }

    private func actionButton(
        _ title: String,
        systemImage: String,
        disabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.system(size: 13, weight: .bold))
                    .frame(width: 16)
                Text(title)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                Spacer(minLength: 4)
            }
            .foregroundStyle(CorptiePalette.primaryText)
            .padding(.horizontal, 8)
            .frame(width: 130, height: 34)
            .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }
}

private struct ExternalLayoutPanelContent: View {
    let displayMode: SessionDisplayMode
    let groupsByProject: Bool
    let selectDisplayMode: (SessionDisplayMode) -> Void
    let toggleGrouping: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            optionButton(L10n("Cards"), systemImage: "rectangle.grid.1x2", selected: displayMode == .cards) {
                selectDisplayMode(.cards)
            }
            optionButton(L10n("Compact List"), systemImage: "list.bullet", selected: displayMode == .compact) {
                selectDisplayMode(.compact)
            }
            optionButton(L10n("Group by Project"), systemImage: "folder.fill", selected: groupsByProject) {
                toggleGrouping()
            }
        }
        .padding(6)
        .background(FloatingActionSurface(cornerRadius: 16))
    }

    private func optionButton(
        _ title: String,
        systemImage: String,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 15)
                Text(title)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                Spacer(minLength: 8)
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .bold))
                    .opacity(selected ? 1 : 0)
            }
            .foregroundStyle(CorptiePalette.primaryText)
            .padding(.horizontal, 8)
            .frame(width: 154, height: 29)
            .background(
                selected ? Color.white.opacity(0.18) : Color.clear,
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
        }
        .buttonStyle(.plain)
    }
}

@MainActor
private final class ExternalMenuPanelController: ObservableObject {
    private var panel: ExternalMenuPanel?
    private weak var parent: NSWindow?
    private var anchor = CGRect.zero

    func show<Content: View>(
        parent: NSWindow,
        anchor: CGRect,
        contentSize: NSSize,
        @ViewBuilder content: () -> Content
    ) {
        close()
        self.parent = parent
        self.anchor = anchor

        let nextPanel = ExternalMenuPanel(
            contentRect: NSRect(origin: .zero, size: contentSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        nextPanel.isOpaque = false
        nextPanel.backgroundColor = .clear
        nextPanel.hasShadow = true
        nextPanel.level = parent.level
        nextPanel.hidesOnDeactivate = true
        nextPanel.collectionBehavior = [.transient, .fullScreenAuxiliary, .stationary]
        nextPanel.isMovable = false
        nextPanel.becomesKeyOnlyIfNeeded = true

        let hostingView = ExternalMenuHostingView(rootView: AnyView(content().padding(12)))
        hostingView.frame = NSRect(origin: .zero, size: contentSize)
        hostingView.autoresizingMask = [.width, .height]
        hostingView.wantsLayer = true
        hostingView.layer?.backgroundColor = NSColor.clear.cgColor
        nextPanel.contentView = hostingView
        // NSPanel may replace the hosting view's frame when assigning contentView.
        // Bind it again to the panel's bounds so the complete menu is rendered and
        // receives clicks across its entire independent window.
        hostingView.frame = nextPanel.contentView?.bounds ?? NSRect(origin: .zero, size: contentSize)
        hostingView.autoresizingMask = [.width, .height]
        panel = nextPanel
        position(nextPanel, parent: parent, anchor: anchor)
        parent.addChildWindow(nextPanel, ordered: .above)
        nextPanel.alphaValue = 0
        nextPanel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.14
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            nextPanel.animator().alphaValue = 1
        }
    }

    func reposition(anchor: CGRect) {
        self.anchor = anchor
        guard let panel, let parent else { return }
        position(panel, parent: parent, anchor: anchor)
    }

    func close() {
        guard let panel else { return }
        parent?.removeChildWindow(panel)
        panel.orderOut(nil)
        self.panel = nil
        parent = nil
    }

    private func position(_ panel: NSPanel, parent: NSWindow, anchor: CGRect) {
        let visibleFrame = parent.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? parent.frame
        let gap: CGFloat = 7
        var origin = NSPoint(
            x: anchor.maxX + gap,
            y: anchor.midY - panel.frame.height / 2
        )
        if origin.x + panel.frame.width > visibleFrame.maxX - 8 {
            origin.x = anchor.minX - gap - panel.frame.width
        }
        origin.x = min(max(origin.x, visibleFrame.minX + 8), visibleFrame.maxX - panel.frame.width - 8)
        origin.y = min(max(origin.y, visibleFrame.minY + 8), visibleFrame.maxY - panel.frame.height - 8)
        panel.setFrameOrigin(origin)
    }
}

private final class ExternalMenuPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class ExternalMenuHostingView: NSHostingView<AnyView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

private struct ExternalControlAnchorReader: NSViewRepresentable {
    let anchorChanged: (CGRect, NSWindow?) -> Void

    func makeNSView(context: Context) -> AnchorProbeView {
        AnchorProbeView(anchorChanged: anchorChanged)
    }

    func updateNSView(_ nsView: AnchorProbeView, context: Context) {
        nsView.anchorChanged = anchorChanged
        nsView.reportAnchor()
    }

    final class AnchorProbeView: NSView {
        var anchorChanged: (CGRect, NSWindow?) -> Void

        init(anchorChanged: @escaping (CGRect, NSWindow?) -> Void) {
            self.anchorChanged = anchorChanged
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            reportAnchor()
        }

        override func layout() {
            super.layout()
            reportAnchor()
        }

        func reportAnchor() {
            guard let window else { return }
            let rectInWindow = convert(bounds, to: nil)
            let rectOnScreen = window.convertToScreen(rectInWindow)
            DispatchQueue.main.async { [weak self, weak window] in
                self?.anchorChanged(rectOnScreen, window)
            }
        }
    }
}

private struct ExternalControlOrbLabel: View {
    let systemImage: String

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 13, weight: .semibold))
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(Color.white)
            .blendMode(.difference)
            .frame(width: 32, height: 32)
            .background(FloatingActionOrb())
            .contentShape(Circle())
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
    @State private var title = ""
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
    @State private var suggestedSessionTitle: String?
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(L10n("New Agent Task"))
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
                .help(L10n("Close"))
            }

            VStack(alignment: .leading, spacing: 7) {
                Text(L10n("Title"))
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.black)
                TextField(defaultSessionTitle, text: $title)
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
                Text(L10n("Workspace"))
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
                    .help(L10n("Choose workspace folder"))
                }
                if isBindingExistingSession {
                    HStack(spacing: 6) {
                        if isLookingUpSession {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text(sessionLookupMessage ?? L10n("Workspace is locked to the bound Codex session."))
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(sessionLookupMessage?.hasPrefix("Session not found") == true ? .red : CorptiePalette.secondaryText)
                            .lineLimit(2)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 7) {
                Text(L10n("Agent"))
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
                Label(isShowingAdvanced ? L10n("Hide Advanced Settings") : L10n("Advanced Settings"), systemImage: "slider.horizontal.3")
                    .font(.system(size: 12, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(CorptiePalette.secondaryText)
            .help(isShowingAdvanced ? L10n("Hide advanced settings") : L10n("Show advanced settings"))

            if isShowingAdvanced {
                VStack(alignment: .leading, spacing: 12) {
                    modelPicker

                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(L10n("Command"))
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(Color.black)
                            TextField(L10n("codex"), text: $command)
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
                            Text(L10n("Args"))
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(Color.black)
                            TextField(L10n(""), text: $arguments)
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
                        Text(L10n("Session ID"))
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(Color.black)
                        TextField(L10n("Bind existing Codex session"), text: $existingSessionId)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                            )
                            .help(L10n("Enter an existing Codex session id to resume it in Corptie"))
                            .onChange(of: existingSessionId) { _, value in
                                scheduleSessionLookup(value)
                            }
                    }

                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(L10n("Permission"))
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(Color.black)
                            Picker(L10n(""), selection: $sandboxMode) {
                                Text(L10n("Workspace Write")).tag("workspace-write")
                                Text(L10n("Full Access")).tag("danger-full-access")
                                Text(L10n("Read Only")).tag("read-only")
                            }
                            .labelsHidden()
                            .pickerStyle(.menu)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .help(L10n("Controls Codex CLI filesystem sandbox mode"))
                        }

                        VStack(alignment: .leading, spacing: 7) {
                            Text(L10n("Approvals"))
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(Color.black)
                            Picker(L10n(""), selection: $approvalPolicy) {
                                Text(L10n("Ask")).tag("on-request")
                                Text(L10n("Ask for Risky Actions")).tag("ask-risky")
                                Text(L10n("Never Ask")).tag("never")
                                Text(L10n("On Failure")).tag("on-failure")
                            }
                            .labelsHidden()
                            .pickerStyle(.menu)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .help(L10n("Controls when Codex asks before running privileged actions"))
                        }
                    }
                    if sandboxMode == "danger-full-access" {
                        Label(L10n("Full Access lets Codex operate outside the workspace. Use it only for trusted tasks."), systemImage: "exclamationmark.triangle")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(CorptiePalette.amber)
                    }
                    HStack(spacing: 8) {
                        Button {
                            savePermissionDefaults()
                        } label: {
                            Label(L10n("Set as Future Default"), systemImage: "checkmark.seal")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(CorptiePalette.softBlue)
                        .help(L10n("Use the selected permission and approval mode for future new sessions"))

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
                .help(L10n("Create task"))
            }
        }
        .padding(18)
        .frame(maxWidth: 380)
        .background(SheetPanelBackground(cornerRadius: 20))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .compositingGroup()
        .alert(
            L10n("A session with this name already exists."),
            isPresented: Binding(
                get: { suggestedSessionTitle != nil },
                set: { if !$0 { suggestedSessionTitle = nil } }
            )
        ) {
            if let suggestedSessionTitle {
                Button(L10nFormat("Create as “%@”", suggestedSessionTitle)) {
                    title = suggestedSessionTitle
                    self.suggestedSessionTitle = nil
                    startSelectedAgent(titleOverride: suggestedSessionTitle)
                }
            }
            Button(L10n("Cancel"), role: .cancel) {
                suggestedSessionTitle = nil
            }
        } message: {
            if let suggestedSessionTitle {
                Text(L10nFormat("Create the new session with the available name “%@”?", suggestedSessionTitle))
            }
        }
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
            Text(L10n("Model"))
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Color.black)

            if !supportsModelSelection {
                Text(L10n("Default"))
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
                    Text(L10n("Loading models"))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                Picker(L10n(""), selection: $selectedModelId) {
                    Text(defaultModelLabel).tag("")
                    ForEach(backendClient.codexModels) { model in
                        Text(model.name).tag(model.id)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(L10n("Choose the model for this new session"))
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
            return L10nFormat("Default (%@)", model.name)
        }
        if let defaultModel = backendClient.codexDefaultModel, !defaultModel.isEmpty {
            return L10nFormat("Default (%@)", defaultModel)
        }
        return L10n("Default")
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
            defaultSaveMessage = L10n("Saved")
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

    private func startSelectedAgent(titleOverride: String? = nil) {
        let workspace = cwd.isEmpty ? backendClient.defaultWorkspacePath : cwd
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalTitle = titleOverride ?? (trimmedTitle.isEmpty ? workspaceFolderName(workspace) : trimmedTitle)
        if trimmedCommand == "codex" {
            backendClient.createCodexPtyTask(
                title: finalTitle,
                prompt: "",
                cwd: workspace,
                existingSessionId: existingSessionId,
                sandbox: sandboxMode,
                approvalPolicy: approvalPolicy,
                model: selectedModelId,
                onNameConflict: { suggestedSessionTitle = $0 }
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
                model: selectedModelId,
                onNameConflict: { suggestedSessionTitle = $0 }
            ) {
                close()
            }
        } else {
            backendClient.createPtyTask(
                title: finalTitle,
                command: command,
                arguments: splitArguments(arguments),
                initialInput: "",
                cwd: workspace,
                onNameConflict: { suggestedSessionTitle = $0 }
            ) {
                close()
            }
        }
    }

    private var defaultSessionTitle: String {
        let workspace = cwd.isEmpty ? backendClient.defaultWorkspacePath : cwd
        return workspaceFolderName(workspace)
    }

    private func workspaceFolderName(_ path: String) -> String {
        let folderName = URL(fileURLWithPath: path).standardizedFileURL.lastPathComponent
        return folderName.isEmpty ? "Agent" : folderName
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
        sessionLookupMessage = L10n("Resolving Codex session workspace...")
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
                    sessionLookupMessage = L10n("Workspace loaded from bound Codex session.")
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
                Text(L10n("Rename Task"))
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
                .help(L10n("Close"))
            }

            TextField(L10n("Task name"), text: $title)
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
                .help(L10n("Save name"))
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
                SessionAvatarView(session: session, avatarSize: 34)
                    .overlay {
                        connectionIndicatorButton
                            .opacity(0.001)
                            .offset(x: 14, y: -14)
                    }
                    .frame(width: 47, height: 47)

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
                        .help(L10n("Pinned"))
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
                        .help(L10n("Stop current run"))
                    }
                } else if canQuickReply {
                    Spacer(minLength: 6)

                    QuickReplyField(
                        text: $quickReply,
                        isFocused: $isQuickReplyFocused,
                        isSending: backendClient.isSendingMessage,
                        placeholder: L10n("Reply"),
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
        .fixedSize(horizontal: false, vertical: true)
        .standardSessionCardSurface()
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
                Label(L10n("Rename"), systemImage: "pencil")
            }

            Divider()

            Button {
                chooseAvatar()
            } label: {
                Label(L10n("Set Avatar"), systemImage: "person.crop.circle")
            }

            if session.avatarPath?.isEmpty == false {
                Button {
                    backendClient.updateAvatar(session: session, avatarPath: nil)
                } label: {
                    Label(L10n("Clear Avatar"), systemImage: "xmark.circle")
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
                Label(L10n("Completion Sound"), systemImage: "speaker.wave.2")
            }

            Divider()

            Button {
                detachedSessionManager.float(session: session)
            } label: {
                Label(L10n("Float Session"), systemImage: "rectangle.on.rectangle.circle")
            }

            Divider()

            Button {
                backendClient.setPinned(session.pinned != true, session: session)
            } label: {
                Label(session.pinned == true ? L10n("Unpin") : L10n("Pin to Top"), systemImage: session.pinned == true ? "pin.slash" : "pin")
            }

            Divider()

            Button {
                backendClient.setArchived(true, session: session)
            } label: {
                Label(L10n("Archive"), systemImage: "archivebox")
            }

            Divider()

            Button(role: .destructive) {
                backendClient.delete(session: session)
            } label: {
                Label(L10n("Delete"), systemImage: "trash")
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
            Text(visibleSuggestedOptions.first?.label ?? L10n("Choice available"))
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
            return L10n("Session is not bound yet")
        }
        if session.capabilities?.canReconnect == true && !session.isConnected {
            return L10n("Reconnect session")
        }
        if session.external?.provider != "codex-pty" {
            return L10n("Session is available")
        }
        if session.isConnecting || backendClient.connectionTransitionSessionIds.contains(session.id) {
            return L10n("Switching PTY connection")
        }
        return session.isConnected ? L10n("Disconnect PTY") : L10n("Reconnect PTY")
    }

    private var connectionIndicatorPopoverText: String {
        if session.isUnboundCodexSession {
            return L10n("尚未发送消息的会话，无法切换状态。")
        }
        if session.capabilities?.canReconnect == true && !session.isConnected {
            return L10n("点击重新连接这个会话。")
        }
        if session.external?.provider != "codex-pty" {
            return L10n("这个会话无需手动连接，当前可用。")
        }
        return L10n("正在切换连接状态。")
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
            return L10nFormat("%llds ago", seconds)
        }
        let minutes = seconds / 60
        if minutes < 60 {
            return L10nFormat("%lldm ago", minutes)
        }
        return L10nFormat("%lldh ago", minutes / 60)
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

private struct StandardSessionCardSurface: ViewModifier {
    private let cornerRadius: CGFloat = 18
    private let glassStrength: Double = 0.55

    private var fillOpacity: Double {
        0.12 + glassStrength * 0.12
    }

    private var strokeOpacity: Double {
        0.18 + glassStrength * 0.14
    }

    func body(content: Content) -> some View {
        content
            .background(
                LiquidGlassCardBackground(cornerRadius: cornerRadius, fillOpacity: fillOpacity)
            )
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(Color.white.opacity(strokeOpacity), lineWidth: 1)
            )
    }
}

private extension View {
    func standardSessionCardSurface() -> some View {
        modifier(StandardSessionCardSurface())
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
        if let titleInitial = session.title.first(where: { $0.isLetter || $0.isNumber }) {
            return String(titleInitial).uppercased()
        }
        let words = session.agent
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .prefix(2)
            .compactMap { $0.first }
        let value = String(words).uppercased()
        return value.isEmpty ? "A" : value
    }
}

struct SessionAvatarView: View {
    let session: TaskSession
    let avatarSize: CGFloat

    private var scale: CGFloat {
        avatarSize / 52
    }

    private var renderSize: CGFloat {
        72 * scale
    }

    var body: some View {
        ZStack {
            StatusHalo(status: session.status)
                .frame(width: 72, height: 72)
                .scaleEffect(scale)

            AgentAvatarView(session: session, size: avatarSize, showsChrome: false)

            ConnectionIndicatorLight(
                color: session.connectionColor,
                size: 8 * scale,
                glowSize: 17 * scale,
                isBreathing: session.isConnecting
            )
            .offset(x: 21 * scale, y: -21 * scale)
        }
        .frame(width: renderSize, height: renderSize)
        .transaction { transaction in
            transaction.animation = nil
        }
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
    @State private var collaborationExpansionByItemKey: [String: Bool] = [:]
    @State private var collaborationConfirmationExpansionByItemKey: [String: Bool] = [:]
    @State private var detailScrollViewportHeight: CGFloat = 0
    @State private var detailScrollBottomMaxY: CGFloat = 0
    @State private var isDetailScrolledNearBottom = true
    @State private var hasNewMessagesBelow = false
    let sessionId: String
    let preheatedDisplayCache: DetailDisplayCache?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            DetailHeaderView()

            if backendClient.isLoadingDetail && backendClient.selectedDetail == nil {
                VStack(spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                    Text(L10n("Loading Codex thread"))
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
                OfflineView(error: backendClient.lastError ?? L10n("No detail is available for this task."))
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
            hasNewMessagesBelow = false
            detailScrollViewportHeight = 0
            detailScrollBottomMaxY = 0
            visibleMessageLimit = Self.initialVisibleMessageLimit
            collaborationExpansionByItemKey.removeAll()
            collaborationConfirmationExpansionByItemKey.removeAll()
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
                            Label(L10nFormat("Load %lld earlier messages", min(100, hiddenCount)), systemImage: "arrow.up.circle")
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
                            ThreadItemView(
                                item: item,
                                isCollaborationExpanded: collaborationExpansionBinding(for: item),
                                isCollaborationConfirmationExpanded: collaborationConfirmationExpansionBinding(for: item)
                            )
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
            .overlay(alignment: .bottomTrailing) {
                if hasNewMessagesBelow && !isDetailScrolledNearBottom {
                    Button {
                        scrollToLatestAfterLayout(detail: detail, proxy: proxy, force: true)
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 12, weight: .bold))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(IconButtonStyle())
                    .help(L10n("Jump to latest message"))
                    .padding(.trailing, 10)
                    .padding(.bottom, 8)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            .animation(.easeOut(duration: 0.16), value: hasNewMessagesBelow)
        }
    }

    private func collaborationExpansionBinding(for item: CodexThreadItem) -> Binding<Bool> {
        let key = collaborationExpansionKey(for: item)
        return Binding(
            get: { collaborationExpansionByItemKey[key] ?? false },
            set: { collaborationExpansionByItemKey[key] = $0 }
        )
    }

    private func collaborationConfirmationExpansionBinding(for item: CodexThreadItem) -> Binding<Bool> {
        let key = collaborationExpansionKey(for: item)
        let status = (item.collaborationConfirmationStatus ?? item.status ?? "pending").lowercased()
        return Binding(
            get: { collaborationConfirmationExpansionByItemKey[key] ?? (status == "pending") },
            set: { collaborationConfirmationExpansionByItemKey[key] = $0 }
        )
    }

    private func collaborationExpansionKey(for item: CodexThreadItem) -> String {
        "\(sessionId)::\(item.id)"
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
        let presentationText = item.presentationText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return [
            item.id,
            item.type,
            item.status ?? "",
            item.turnStatus,
            item.presentationRole ?? "",
            item.collaborationProcessingStatus ?? "",
            item.collaborationSenderName ?? "",
            "\(text.count)",
            String(text.suffix(96)),
            "\(presentationText.count)",
            String(presentationText.suffix(96)),
            fileChangesSignature(item)
        ].joined(separator: ":")
    }

    private func scrollToLatestAfterLayout(detail: CodexThreadDetail, proxy: ScrollViewProxy, force: Bool = false) {
        guard !cachedDisplayEntries.isEmpty || !detail.items.isEmpty else {
            return
        }
        guard force || isDetailScrolledNearBottom else {
            hasNewMessagesBelow = true
            return
        }

        let delay: TimeInterval = didInitialScroll ? 0.0 : 0.02
        didInitialScroll = true
        hasNewMessagesBelow = false

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
        let isNearBottom = bottomDistance <= 36
        isDetailScrolledNearBottom = isNearBottom
        if isNearBottom {
            hasNewMessagesBelow = false
        }
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
        if let confirmation = items.last(where: { $0.type == "collaborationConfirmation" }) {
            return userMessages.map { ChatDisplayEntry(kind: .message($0)) }
                + [ChatDisplayEntry(kind: .message(confirmation))]
        }
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

private struct ChatUsageBar: View {
    let usage: SessionUsageResponse?

    var body: some View {
        if let usage, usage.account.provider == "codex" {
            VStack(alignment: .leading, spacing: 2) {
                if let context = usage.context,
                   let remaining = context.remainingTokens,
                   let window = context.contextWindow {
                    let used = context.usedTokens ?? max(0, window - remaining)
                    let usedPercent = context.usedPercent ?? max(0, min(100, used / window * 100))
                    usageItem(
                        icon: "text.alignleft",
                        value: "\(compactTokens(used))/\(compactTokens(window))",
                        progress: usedPercent / 100,
                        color: contextColor(usedPercent: usedPercent),
                        help: "\(L10n("Context")): \(compactTokens(used)) / \(compactTokens(window)) · \(formatPercent(usedPercent))% used"
                    )
                }
                if let window = preferredRateLimitWindow(usage.account) {
                    let remainingPercent = max(0, 100 - (window.usedPercent ?? 0))
                    usageItem(
                        icon: "bolt.fill",
                        value: "\(formatPercent(remainingPercent))%",
                        progress: remainingPercent / 100,
                        color: quotaColor(remainingPercent: remainingPercent),
                        help: "\(L10n("Codex quota")): \(formatPercent(remainingPercent))% remaining"
                    )
                }
            }
            .font(.system(size: 9, weight: .semibold))
            .fixedSize(horizontal: true, vertical: false)
        }
    }

    private func usageItem(icon: String, value: String, progress: Double, color: Color, help: String) -> some View {
        HStack(spacing: 4) {
            UsageProgressRing(icon: icon, progress: progress, color: color)
            Text(value)
                .foregroundStyle(color)
                .monospacedDigit()
        }
        .help(help)
    }

    private func quotaColor(remainingPercent: Double) -> Color {
        if remainingPercent < 30 { return .red }
        if remainingPercent <= 50 { return .yellow }
        return CorptiePalette.secondaryText
    }

    private func contextColor(usedPercent: Double) -> Color {
        if usedPercent > 70 { return .red }
        if usedPercent > 50 { return .yellow }
        return CorptiePalette.secondaryText
    }

    private func preferredRateLimitWindow(_ account: CodexAccountUsage) -> CodexRateLimitWindow? {
        let snapshots = account.rateLimitsByLimitId?.sorted { $0.key < $1.key }.map(\.value)
            ?? [account.rateLimits].compactMap { $0 }
        return snapshots.compactMap(\.primary).first
    }

    private func compactTokens(_ value: Double) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
        if value >= 1_000 { return String(format: "%.0fK", value / 1_000) }
        return String(format: "%.0f", value)
    }

    private func formatPercent(_ value: Double) -> String {
        value.rounded() == value ? String(format: "%.0f", value) : String(format: "%.1f", value)
    }
}

private struct UsageProgressRing: View {
    let icon: String
    let progress: Double
    let color: Color

    var body: some View {
        ZStack {
            Circle()
                .stroke(color.opacity(0.18), lineWidth: 1.5)
            Circle()
                .trim(from: 0, to: max(0, min(1, progress)))
                .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Image(systemName: icon)
                .font(.system(size: 4.5, weight: .bold))
                .foregroundStyle(color)
        }
        .frame(width: 10, height: 10)
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
            item.presentationRole ?? "",
            item.collaborationProcessingStatus ?? "",
            item.collaborationSenderName ?? "",
            "\(item.text.count)",
            "\(item.presentationText?.count ?? 0)",
            fileChangesSignature(item)
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
    if let confirmation = items.last(where: { $0.type == "collaborationConfirmation" }) {
        return userMessages.map { ChatDisplayEntry(kind: .message($0)) }
            + [ChatDisplayEntry(kind: .message(confirmation))]
    }
    let agentMessages = items.filter {
        $0.type == "agentMessage" && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    let finalAgentMessage = agentMessages.last.flatMap { item in
        isTerminalTurnStatus(item.turnStatus) ? item : nil
    }
    let progressAgentMessages = finalAgentMessage == nil ? agentMessages[...] : agentMessages.dropLast()
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

private func isTerminalTurnStatus(_ status: String) -> Bool {
    switch status.lowercased() {
    case "completed", "complete", "failed", "cancelled", "canceled", "interrupted":
        return true
    default:
        return false
    }
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
    let presentationText = item.presentationText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return [
        item.id,
        item.type,
        item.status ?? "",
        item.turnStatus,
        item.presentationRole ?? "",
        item.collaborationProcessingStatus ?? "",
        item.collaborationSenderName ?? "",
        "\(text.count)",
        String(text.suffix(96)),
        "\(presentationText.count)",
        String(presentationText.suffix(96)),
        fileChangesSignature(item)
    ].joined(separator: ":")
}

private func fileChangesSignature(_ item: CodexThreadItem) -> String {
    (item.fileChanges ?? []).map { "\($0.kind):\($0.path)" }.joined(separator: ",")
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
            .help(L10n("Back to task list"))

            if let selectedSession = backendClient.selectedSession {
                SessionAvatarView(session: selectedSession, avatarSize: 32)
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
                    .help(L10n("Open folder in Finder"))
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
                .help(L10n("Reconnect session"))
            } else if canInterruptCurrentRun {
                Button {
                    backendClient.interruptSelectedSession()
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(IconButtonStyle())
                .help(L10n("Stop current run"))
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
    @EnvironmentObject private var backendClient: BackendClient
    let detail: CodexThreadDetail

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 5) {
                ConnectionIndicatorLight(
                    color: detail.isConnecting ? CorptiePalette.disconnected : detail.connectionColor,
                    size: 5,
                    glowSize: 10,
                    isBreathing: detail.isConnecting
                )
                Text(detail.status.label)
                    .foregroundStyle(detail.status.color)
                if let activityStatus = detail.activityStatus, !activityStatus.isEmpty {
                    ActivityStatusText(text: activityStatus, isActive: detail.status == .running)
                }
            }

            Spacer(minLength: 8)

            ChatUsageBar(usage: backendClient.selectedSessionUsage)
        }
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(CorptiePalette.secondaryText)
        .frame(maxWidth: .infinity)
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
        .help(L10n("Copy"))
        .accessibilityLabel(L10n("Copy message"))
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
                    Text(L10n("已处理"))
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
    @State private var isCollaborationDetailsExpanded = false
    @State private var isHovering = false
    @State private var isConfirmingUndo = false
    @State private var isDiffActionRunning = false
    @State private var diffActionError: String?
    let item: CodexThreadItem
    @Binding private var isCollaborationExpanded: Bool
    @Binding private var isCollaborationConfirmationExpanded: Bool

    init(
        item: CodexThreadItem,
        isCollaborationExpanded: Binding<Bool>,
        isCollaborationConfirmationExpanded: Binding<Bool>
    ) {
        self.item = item
        _isCollaborationExpanded = isCollaborationExpanded
        _isCollaborationConfirmationExpanded = isCollaborationConfirmationExpanded
    }

    var body: some View {
        if isCollaborationConfirmationItem {
            collaborationConfirmationView
        } else if isCollaborationItem {
            collaborationItemView
        } else if isHandledPermissionItem {
            handledPermissionView
        } else {
            fullItemView
        }
    }

    private var collaborationConfirmationView: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.16)) {
                    isCollaborationConfirmationExpanded.toggle()
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: isCollaborationConfirmationExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8.5, weight: .bold))
                        .frame(width: 10)
                        .foregroundStyle(CorptiePalette.secondaryText)
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(CorptiePalette.softBlue)
                    Text(L10n("确认发送协作任务"))
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(CorptiePalette.primaryText)
                    Text("· \(collaborationRecipientName)")
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(collaborationConfirmationStatusLabel)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(collaborationConfirmationStatusColor)
                }
                .padding(.horizontal, 9)
                .frame(maxWidth: .infinity)
                .frame(height: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .help(isCollaborationConfirmationExpanded ? "收起发送详情" : "展开发送详情")

            if isCollaborationConfirmationExpanded {
                Divider()
                    .overlay(CorptiePalette.collaborationBorder.opacity(0.42))

                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 7) {
                        collaborationConfirmationField(
                            icon: "person.crop.circle.badge.checkmark",
                            label: "目标 Agent",
                            value: collaborationRecipientName
                        )
                        if let recipientId = nonEmpty(item.collaborationRecipientAgentId) {
                            collaborationConfirmationField(icon: "number", label: "Agent ID", value: recipientId, monospaced: true)
                        }
                        if let title = nonEmpty(item.collaborationTaskTitle) {
                            collaborationConfirmationField(icon: "checklist", label: "任务", value: title)
                        }
                        collaborationConfirmationField(icon: "text.alignleft", label: "指令", value: collaborationPresentationText)
                    }

                    if let criteria = item.collaborationAcceptanceCriteria, !criteria.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(L10n("验收标准"))
                                .font(.system(size: 9.5, weight: .bold))
                                .foregroundStyle(CorptiePalette.secondaryText)
                            ForEach(criteria, id: \.self) { criterion in
                                Label(criterion, systemImage: "checkmark.circle")
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(CorptiePalette.primaryText)
                            }
                        }
                    }

                    if collaborationConfirmationStatus == "pending",
                       let confirmationId = item.collaborationConfirmationId {
                        HStack(spacing: 8) {
                            Button {
                                backendClient.respondToCollaborationConfirmation(confirmationId: confirmationId, approve: true)
                            } label: {
                                Label(L10n("确认发送"), systemImage: "paperplane.fill")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(CorptiePalette.softBlue)

                            Button {
                                backendClient.respondToCollaborationConfirmation(confirmationId: confirmationId, approve: false)
                            } label: {
                                Text(L10n("取消"))
                                    .frame(minWidth: 52)
                            }
                            .buttonStyle(.bordered)
                        }
                        .controlSize(.small)
                        .disabled(backendClient.isSendingMessage)

                        Text(L10n("也可以直接回复“确认”或“取消”"))
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.top, 9)
                .padding(.bottom, 10)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CorptiePalette.collaborationSurface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(CorptiePalette.collaborationBorder.opacity(0.62), lineWidth: 1)
                .allowsHitTesting(false)
        )
        .animation(.easeInOut(duration: 0.16), value: isCollaborationConfirmationExpanded)
        .onChange(of: collaborationConfirmationStatus) { _, status in
            if status != "pending" {
                withAnimation(.easeOut(duration: 0.16)) {
                    isCollaborationConfirmationExpanded = false
                }
            }
        }
    }

    private func collaborationConfirmationField(icon: String, label: String, value: String, monospaced: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: icon)
                .frame(width: 13)
                .foregroundStyle(CorptiePalette.softBlue)
            Text(label)
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundStyle(CorptiePalette.secondaryText)
                .frame(width: 58, alignment: .leading)
            Text(value)
                .font(.system(size: 10.5, weight: .semibold, design: monospaced ? .monospaced : .default))
                .foregroundStyle(CorptiePalette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private var isCollaborationConfirmationItem: Bool {
        item.presentationRole == "collaboration_confirmation" || item.type == "collaborationConfirmation"
    }

    private var collaborationConfirmationStatus: String {
        (item.collaborationConfirmationStatus ?? item.status ?? "pending").lowercased()
    }

    private var collaborationConfirmationStatusLabel: String {
        switch collaborationConfirmationStatus {
        case "confirmed": "已发送"
        case "rejected": "已取消"
        default: "等待确认"
        }
    }

    private var collaborationConfirmationStatusColor: Color {
        switch collaborationConfirmationStatus {
        case "confirmed": CorptiePalette.connected
        case "rejected": CorptiePalette.mutedText
        default: CorptiePalette.amber
        }
    }

    private var collaborationItemView: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.spring(response: 0.30, dampingFraction: 0.86, blendDuration: 0.08)) {
                    isCollaborationExpanded.toggle()
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8.5, weight: .bold))
                        .frame(width: 10)
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .rotationEffect(.degrees(isCollaborationExpanded ? 90 : 0))
                    Image(systemName: "person.2.wave.2.fill")
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(CorptiePalette.softBlue)
                    Text(L10n("Agent 协作"))
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(CorptiePalette.primaryText)
                    Text(collaborationKindLabel)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(CorptiePalette.primaryText)
                        .padding(.horizontal, 5)
                        .frame(height: 16)
                        .background(Color.white.opacity(0.24), in: Capsule())
                    Text("· \(collaborationSenderName)")
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    Label(collaborationStatusLabel, systemImage: collaborationStatusIcon)
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(collaborationStatusColor)
                }
                .padding(.horizontal, 9)
                .frame(maxWidth: .infinity)
                .frame(height: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .help(isCollaborationExpanded ? "收起协作消息" : "展开来自 \(collaborationSenderName) 的协作消息")

            if isCollaborationExpanded {
                Divider()
                    .overlay(CorptiePalette.collaborationBorder.opacity(0.42))

                ZStack(alignment: .bottomTrailing) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .top, spacing: 7) {
                            collaborationAvatar(name: collaborationSenderName)
                            VStack(alignment: .leading, spacing: 3) {
                                collaborationPartyRow(label: "来自", name: collaborationSenderName)
                                collaborationPartyRow(label: "发送至", name: collaborationRecipientName)
                            }
                            Spacer(minLength: 0)
                            if let itemTimeLabel {
                                Text(itemTimeLabel)
                                    .font(.system(size: 9.5, weight: .medium))
                                    .foregroundStyle(CorptiePalette.secondaryText)
                            }
                        }

                        if let taskTitle = nonEmpty(item.collaborationTaskTitle) {
                            Label(taskTitle, systemImage: "checklist")
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(CorptiePalette.secondaryText)
                                .lineLimit(2)
                        }

                        messageTextView(text: collaborationPresentationText, allowsSelection: true)

                        if hasCollaborationTechnicalDetails {
                            DisclosureGroup(isExpanded: $isCollaborationDetailsExpanded) {
                                VStack(alignment: .leading, spacing: 5) {
                                    collaborationDetailRow(label: "Task ID", value: item.collaborationTaskId)
                                    collaborationDetailRow(label: "Sender ID", value: item.collaborationSenderAgentId)
                                    collaborationDetailRow(label: "Recipient ID", value: item.collaborationRecipientAgentId)
                                }
                                .padding(.top, 5)
                            } label: {
                                Text(L10n("任务详情"))
                                    .font(.system(size: 9.5, weight: .semibold))
                                    .foregroundStyle(CorptiePalette.secondaryText)
                            }
                        }
                    }

                    CopyTextButton(
                        text: collaborationPresentationText,
                        isVisible: isHovering && !collaborationPresentationText.isEmpty
                    )
                    .padding(2)
                }
                .padding(.horizontal, 10)
                .padding(.top, 9)
                .padding(.bottom, 10)
                .transition(.asymmetric(
                    insertion: .opacity
                        .combined(with: .move(edge: .top))
                        .combined(with: .scale(scale: 0.985, anchor: .top)),
                    removal: .opacity
                        .combined(with: .move(edge: .top))
                        .combined(with: .scale(scale: 0.99, anchor: .top))
                ))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CorptiePalette.collaborationSurface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(CorptiePalette.collaborationBorder.opacity(0.62), lineWidth: 1)
                .allowsHitTesting(false)
        )
        .onHover { isHovering = $0 }
        .animation(.spring(response: 0.30, dampingFraction: 0.86, blendDuration: 0.08), value: isCollaborationExpanded)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10nFormat("Agent collaboration message from %@", collaborationSenderName))
    }

    private func collaborationPartyRow(label: String, name: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(label)
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(CorptiePalette.secondaryText)
                .frame(width: 34, alignment: .leading)
            Text(name)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(CorptiePalette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func collaborationAvatar(name: String) -> some View {
        Text(String(name.prefix(1)).uppercased())
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(CorptiePalette.softBlue)
            .frame(width: 20, height: 20)
            .background(Color.white.opacity(0.24), in: Circle())
    }

    @ViewBuilder
    private func collaborationDetailRow(label: String, value: String?) -> some View {
        if let value = nonEmpty(value) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(label)
                    .frame(width: 68, alignment: .leading)
                    .foregroundStyle(CorptiePalette.secondaryText)
                Text(value)
                    .foregroundStyle(CorptiePalette.primaryText)
                    .textSelection(.enabled)
            }
            .font(.system(size: 9.5, weight: .medium, design: .monospaced))
        }
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }

    private var isCollaborationItem: Bool {
        item.type == "userMessage"
            && (item.presentationRole == "collaboration" || item.sourceType == "collaboration")
    }

    private var collaborationPresentationText: String {
        nonEmpty(item.presentationText) ?? "协作消息正文不可用"
    }

    private var collaborationSenderName: String {
        nonEmpty(item.collaborationSenderName) ?? "其他 Agent"
    }

    private var collaborationRecipientName: String {
        nonEmpty(item.collaborationRecipientName)
            ?? nonEmpty(backendClient.selectedSession?.title)
            ?? "当前 Agent"
    }

    private var collaborationKindLabel: String {
        switch item.collaborationMessageKind?.lowercased() {
        case "change_request": "修改请求"
        case "needs_information": "澄清请求"
        case "update_ready": "结果"
        case "verification_result": "验收结果"
        case "question": "请求"
        default: "协作消息"
        }
    }

    private var collaborationProcessingStatus: String {
        (item.collaborationProcessingStatus ?? item.status ?? "queued").lowercased()
    }

    private var collaborationStatusLabel: String {
        switch collaborationProcessingStatus {
        case "running", "processing": "处理中"
        case "completed", "complete": "已处理"
        case "failed": "处理失败"
        case "cancelled", "canceled": "已取消"
        default: "等待处理"
        }
    }

    private var collaborationStatusIcon: String {
        switch collaborationProcessingStatus {
        case "running", "processing": "clock.arrow.circlepath"
        case "completed", "complete": "checkmark.circle.fill"
        case "failed": "exclamationmark.circle.fill"
        case "cancelled", "canceled": "xmark.circle.fill"
        default: "clock.fill"
        }
    }

    private var collaborationStatusColor: Color {
        switch collaborationProcessingStatus {
        case "running", "processing": CorptiePalette.running
        case "completed", "complete": CorptiePalette.connected
        case "failed", "cancelled", "canceled": .red
        default: CorptiePalette.amber
        }
    }

    private var hasCollaborationTechnicalDetails: Bool {
        [item.collaborationTaskId, item.collaborationSenderAgentId, item.collaborationRecipientAgentId]
            .contains { nonEmpty($0) != nil }
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

                if hasFileChanges {
                    codeChangeSummary
                        .padding(.top, 4)
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
        .confirmationDialog(
            "Undo changes from this reply?",
            isPresented: $isConfirmingUndo,
            titleVisibility: .visible
        ) {
            Button(L10n("Undo Changes"), role: .destructive) {
                undoChanges()
            }
            Button(L10n("Cancel"), role: .cancel) {}
        } message: {
            Text(L10n("This reverses only the recorded patch. It will stop if newer edits conflict."))
        }
        .alert(L10n("Code Diff"), isPresented: Binding(
            get: { diffActionError != nil },
            set: { if !$0 { diffActionError = nil } }
        )) {
            Button(L10n("OK"), role: .cancel) {}
        } message: {
            Text(diffActionError ?? "Unknown error")
        }
    }

    private var hasFileChanges: Bool {
        item.type == "agentMessage" && !(item.fileChanges ?? []).isEmpty
    }

    private var codeChangeSummary: some View {
        VStack(alignment: .leading, spacing: 7) {
            Divider()
            HStack(spacing: 6) {
                Image(systemName: "doc.text.magnifyingglass")
                Text(L10n("Changed Files"))
                Text("\(item.fileChanges?.count ?? 0)")
                    .foregroundStyle(CorptiePalette.mutedText)
                Spacer()
            }
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(CorptiePalette.secondaryText)

            VStack(alignment: .leading, spacing: 4) {
                ForEach(item.fileChanges ?? [], id: \.path) { change in
                    HStack(spacing: 7) {
                        Image(systemName: fileChangeIcon(change.kind))
                            .frame(width: 12)
                            .foregroundStyle(fileChangeColor(change.kind))
                        Text(change.path)
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                }
            }

            HStack(spacing: 8) {
                Button {
                    reviewChanges()
                } label: {
                    Label(L10n("Review"), systemImage: "arrow.up.forward.app")
                }
                .help(L10n("Open this turn's diff in the selected external tool"))

                Button(role: .destructive) {
                    isConfirmingUndo = true
                } label: {
                    Label(isTurnUndone ? L10n("Undone") : L10n("Undo"), systemImage: "arrow.uturn.backward")
                }
                .help(L10n("Reverse only the changes recorded for this reply"))
                .disabled(isTurnUndone)

                if isDiffActionRunning {
                    ProgressView()
                        .controlSize(.small)
                }
                Spacer()
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(isDiffActionRunning)
        }
    }

    private var isTurnUndone: Bool {
        backendClient.undoneCodexTurnIds.contains(item.turnId)
    }

    private func reviewChanges() {
        guard let threadId = backendClient.selectedDetail?.id else { return }
        isDiffActionRunning = true
        Task {
            defer { isDiffActionRunning = false }
            if case .failure(let error) = await backendClient.reviewCodexChanges(threadId: threadId, turnId: item.turnId) {
                diffActionError = error.localizedDescription
            }
        }
    }

    private func undoChanges() {
        guard let threadId = backendClient.selectedDetail?.id else { return }
        isDiffActionRunning = true
        Task {
            defer { isDiffActionRunning = false }
            if case .failure(let error) = await backendClient.undoCodexChanges(threadId: threadId, turnId: item.turnId) {
                diffActionError = error.localizedDescription
            }
        }
    }

    private func fileChangeIcon(_ kind: String) -> String {
        switch kind {
        case "add": "plus.circle.fill"
        case "delete": "minus.circle.fill"
        default: "pencil.circle.fill"
        }
    }

    private func fileChangeColor(_ kind: String) -> Color {
        switch kind {
        case "add": CorptiePalette.connected
        case "delete": .red
        default: itemColor
        }
    }

    private var itemMetadataLabel: String {
        [itemRoleLabel, item.status == "queued" ? L10n("排队中") : nil, itemTimeLabel].compactMap { value in
            guard let value, !value.isEmpty else {
                return nil
            }
            return value
        }.joined(separator: " ")
    }

    private var itemRoleLabel: String {
        if item.sourceType == "collaboration" {
            return L10n("协作任务")
        }
        switch item.type {
        case "userMessage":
            return L10n("User")
        case "agentMessage":
            return L10n("Agent")
        default:
            return L10n("System")
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
                    Label(L10nFormat("Selected: %@", selected.label), systemImage: "checkmark.circle.fill")
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
                Text(L10n("已处理的权限请求"))
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
        if isCollaborationItem {
            return CorptiePalette.collaborationSurface
        }
        return item.type == "approval" || item.type == "choice" ? Color(nsColor: NSColor(calibratedRed: 1.0, green: 0.98, blue: 0.91, alpha: 1)) : Color.white
    }

    private var itemBorder: Color {
        if isCollaborationItem {
            return CorptiePalette.collaborationBorder.opacity(0.62)
        }
        return item.type == "approval" || item.type == "choice" ? CorptiePalette.amber.opacity(0.32) : Color.black.opacity(0.08)
    }

    private var itemColor: Color {
        if item.status == "queued" {
            return CorptiePalette.amber
        }
        if isCollaborationItem {
            return CorptiePalette.periwinkle
        }
        return switch item.type {
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

    @ViewBuilder
    private func messageTextView(text: String, allowsSelection: Bool) -> some View {
        MarkdownMessageView(text: text, allowsSelection: allowsSelection)
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
                .help(isRunningTurn ? L10n("Stop current run") : L10n("Send instruction"))
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
                Text(L10n("Loading models"))
            } else if backendClient.codexModels.isEmpty {
                Button {
                    Task {
                        await backendClient.loadModelsForSelectedSession(forceRefresh: true)
                    }
                } label: {
                    Label(L10n("Reload models"), systemImage: "arrow.clockwise")
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
                            Text(L10n("No reasoning options"))
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
                        Label(L10nFormat("Reasoning: %@", reasoningLabel(currentReasoningLevel)), systemImage: "brain")
                    }
                    .disabled(currentReasoningLevels.isEmpty || backendClient.isSwitchingReasoning)
                }

                Button {
                    Task {
                        await backendClient.loadModelsForSelectedSession(forceRefresh: true)
                    }
                } label: {
                    Label(L10n("Reload models"), systemImage: "arrow.clockwise")
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
            return L10n("Model")
        }
        return backendClient.codexModels.first(where: { $0.id == currentModelId })?.name ?? currentModelId
    }

    private var currentModelHelp: String {
        let action = supportsReasoningSwitch ? L10n("Switch model or reasoning") : L10n("Switch model")
        guard !currentModelId.isEmpty else {
            return action
        }
        return L10nFormat("%@: %@", action, currentModelLabel)
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
        case "low": L10n("Low")
        case "medium": L10n("Medium")
        case "high": L10n("High")
        case "xhigh": L10n("Extra High")
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
        case "low": L10n("Fast responses with lighter reasoning")
        case "medium": L10n("Balanced speed and reasoning")
        case "high": L10n("Greater reasoning depth")
        case "xhigh": L10n("Extra high reasoning depth")
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
            .help(L10n("Send reply"))
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
            Text(L10n("Backend offline"))
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
            Text(L10n("Backend ready"))
                .font(.system(size: 15, weight: .semibold))
            Text(L10n("Click the + button in the lower-left corner to create a session."))
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
