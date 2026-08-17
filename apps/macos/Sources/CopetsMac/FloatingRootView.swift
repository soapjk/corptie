import AppKit
import SwiftUI
import UniformTypeIdentifiers

// 液态玻璃环境开关：Sessions Tab 里设为 false，让复用的会话 UI 降级成系统原生风格；
// 悬浮窗不注入（默认 true）保持液态玻璃。避免两套 UI 混在一起割裂。
struct IsLiquidGlassEnvironmentKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    var isLiquidGlass: Bool {
        get { self[IsLiquidGlassEnvironmentKey.self] }
        set { self[IsLiquidGlassEnvironmentKey.self] = newValue }
    }
}

struct FloatingRootView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @EnvironmentObject private var sessionListStore: SessionListStore
    @ObservedObject private var appLanguage = AppLanguageController.shared
    @EnvironmentObject private var panelLayoutState: PanelLayoutState
    @EnvironmentObject private var panelFocusState: PanelFocusState
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
    @State private var reorderSessionFrames: [String: CGRect] = [:]
    @State private var reorderDragStartMouseScreenY: CGFloat = 0
    @State private var reorderDragScreenDeltaY: CGFloat = 0
    @State private var reorderDragFrame: CGRect?
    @State private var reorderTargetSessionId: String?
    @State private var hasResolvedReorderTarget = false
    @State private var hoverPreviewSessionId: String?
    @State private var isHoveringReplyPreviewBubble = false
    @State private var hoverPreviewCloseTask: Task<Void, Never>?
    @State private var detailPreheatTasks: [String: Task<Void, Never>] = [:]
    @State private var detailDisplayCacheBySessionId: [String: DetailDisplayCache] = [:]
    @State private var composerDraftRepository = ComposerDraftRepository()
    @State private var listHeightMeasurements: [ListHeightMetric: CGFloat] = [:]
    @State private var isSearching = false
    @State private var searchText = ""
    @FocusState private var isSearchFieldFocused: Bool
    @AppStorage("sessionDisplayMode") private var sessionDisplayModeRawValue = SessionDisplayMode.cards.rawValue
    @AppStorage("groupsSessionsByProject") private var groupsSessionsByProject = false
    private let panelContentPadding: CGFloat = 14
    private let detailSessionRailGutter: CGFloat = 78
    private let detailSessionRailTriggerWidth: CGFloat = 8
    private let listContentFrameKey = "__corptie_list_content__"
    private let listViewportFrameKey = "__corptie_list_viewport__"
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
                        preheatedDisplayCache: detailDisplayCacheBySessionId[selectedSession.id],
                        composerDraftRepository: composerDraftRepository
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
        .overlay(alignment: .leading) {
            collapsedDetailSessionRailTrigger
        }
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

            if sessionListStore.orderedIDs.isEmpty {
                ReadyEmptyView()
                    .measureListHeight(.cards)
            } else if filteredSessions.isEmpty {
                ContentUnavailableView.search(text: searchText)
                    .frame(maxWidth: .infinity, minHeight: 150)
                    .measureListHeight(.cards)
            } else {
                AppKitSessionListView(
                    rows: appKitSessionListRows,
                    rowSpacing: displayMode == .cards ? PanelLayoutState.cardSpacing : 4,
                    onGeometryChange: applyNativeSessionListGeometry
                )
                .id(listLayoutKey)
                .measureListMinY(.scrollTop, coordinateSpace: "session-list-root")
                .coordinateSpace(name: "session-list")
                .simultaneousGesture(sessionListReorderGesture)
                .overlay(alignment: .topLeading) {
                    sessionReorderDragOverlay
                }
                .overlay(alignment: .topLeading) {
                    if displayMode == .cards { sessionHoverPreviewOverlay }
                }
            }
        }
        .animation(.spring(response: 0.30, dampingFraction: 0.86), value: isSearching)
        .coordinateSpace(name: "session-list-root")
        .measureListMinY(.browserTop, coordinateSpace: "session-list-root")
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

    private var appKitSessionListRows: [AppKitSessionListRow] {
        var rows: [AppKitSessionListRow] = []
        for (groupIndex, group) in sessionGroups.enumerated() {
            if groupsSessionsByProject {
                rows.append(AppKitSessionListRow(
                    id: "project-header:\(group.id)",
                    sessionID: nil,
                    contentRevision: group.rows.count,
                    content: AnyView(
                        ProjectGroupHeader(path: group.path, count: group.rows.count)
                            .padding(.top, groupIndex == 0 ? 0 : 8)
                    )
                ))
            }
            rows.append(contentsOf: group.rows.map { row in
                AppKitSessionListRow(
                    id: row.id,
                    sessionID: row.id,
                    contentRevision: draggedSessionId == row.id ? 1 : 0,
                    content: AnyView(sessionItem(for: row))
                )
            })
        }
        return rows
    }

    private func applyNativeSessionListGeometry(
        _ rowFrames: [String: CGRect],
        contentFrame: CGRect,
        viewportFrame: CGRect,
        contentHeight: CGFloat
    ) {
        var nextFrames = rowFrames
        nextFrames[listContentFrameKey] = contentFrame
        nextFrames[listViewportFrameKey] = viewportFrame
        guard nextFrames != sessionCardFrames || sessionCardFramesLayoutKey != listLayoutKey else { return }
        sessionCardFrames = nextFrames
        sessionCardFramesLayoutKey = listLayoutKey
        listHeightMeasurements[.cards] = contentHeight
        guard draggedSessionId == nil else { return }
        logListGeometry(trigger: "native-row-frames", frames: nextFrames)
        updatePreferredListHeight(listHeightMeasurements)
    }

    private var displayMode: SessionDisplayMode {
        get {
            if SessionListPerformanceFlags.current.forcesCardDisplayMode {
                return .cards
            }
            return SessionDisplayMode(rawValue: sessionDisplayModeRawValue) ?? .cards
        }
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
                ForEach(sessionListStore.rows) { row in
                    DetailSessionRailRow(
                        row: row,
                        selectedSessionID: backendClient.selectedSession?.id,
                        select: { session in
                            preheatDetail(for: session)
                            backendClient.select(session: session)
                        },
                        preheat: preheatDetail
                    )
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
    private var detailSessionRailOverlay: some View {
        if backendClient.selectedSession != nil,
           backendClient.sessions.count > 1,
           isShowingDetailSessionRail {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Color.black.opacity(0.001)
                        .contentShape(Rectangle())

                    detailSessionRail(height: proxy.size.height)
                        .padding(.leading, 4)
                }
                .frame(width: detailSessionRailGutter + 10)
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .onHover(perform: updateDetailSessionRailHover)
                .transition(.opacity.combined(with: .move(edge: .trailing)))
            }
        }
    }

    @ViewBuilder
    private var collapsedDetailSessionRailTrigger: some View {
        if backendClient.selectedSession != nil,
           backendClient.sessions.count > 1,
           !isShowingDetailSessionRail {
            FastHoverTrackingArea(hoverChanged: updateDetailSessionRailHover)
                .frame(width: detailSessionRailTriggerWidth)
                .frame(maxHeight: .infinity)
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

    private var filteredSessionRows: [SessionRowModel] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let matchingRows = query.isEmpty ? sessionListStore.rows : sessionListStore.rows.filter { row in
            let session = row.session
            return [session.title, session.summary, session.agent, session.external?.cwd ?? ""]
                .contains { $0.localizedCaseInsensitiveContains(query) }
        }
        guard let limit = SessionListPerformanceFlags.current.sessionLimit else {
            return matchingRows
        }
        return Array(matchingRows.prefix(limit))
    }

    private var filteredSessions: [TaskSession] {
        filteredSessionRows.map(\.session)
    }

    private var sessionGroups: [SessionProjectGroup] {
        guard groupsSessionsByProject else {
            return [SessionProjectGroup(id: "all", path: "", rows: filteredSessionRows)]
        }
        var order: [String] = []
        var grouped: [String: [SessionRowModel]] = [:]
        var paths: [String: String] = [:]
        for row in filteredSessionRows {
            let session = row.session
            let workspace = session.external?.workspace
            let repositoryId = workspace?.repositoryId?.trimmingCharacters(in: .whitespacesAndNewlines)
            let currentPath = workspace?.path ?? session.external?.cwd
            let projectPath = workspace?.projectPath?.trimmingCharacters(in: .whitespacesAndNewlines)
            let fallbackPath = currentPath?.trimmingCharacters(in: .whitespacesAndNewlines)
            let path = projectPath?.isEmpty == false ? projectPath! : (fallbackPath?.isEmpty == false ? fallbackPath! : "No Project")
            let key = repositoryId?.isEmpty == false ? "repository:\(repositoryId!)" : "path:\(path)"
            if grouped[key] == nil { order.append(key) }
            grouped[key, default: []].append(row)
            if paths[key] == nil || projectPath?.isEmpty == false {
                paths[key] = path
            }
        }
        return order.map {
            SessionProjectGroup(id: $0, path: paths[$0] ?? "No Project", rows: grouped[$0] ?? [])
        }
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
    private func sessionItem(for row: SessionRowModel) -> some View {
        SessionListRowContent(
            row: row,
            displayMode: displayMode,
            showsProjectName: !groupsSessionsByProject,
            isHiddenForReorder: draggedSessionId == row.id,
            hoverPreviewChanged: { sessionId, isVisible in
                guard draggedSessionId == nil else { return }
                updateHoverPreview(sessionId: sessionId, isVisible: isVisible)
            },
            preheatRequested: { session in
                guard draggedSessionId == nil else { return }
                preheatDetail(for: session)
            }
        )
        .environmentObject(backendClient)
    }

    @ViewBuilder
    private var sessionReorderDragOverlay: some View {
        if let draggedSessionId,
           let session = backendClient.sessions.first(where: { $0.id == draggedSessionId }),
           let dragFrame = reorderDragFrame,
           let viewportFrame = sessionCardFrames[listViewportFrameKey] {
            Group {
                if displayMode == .compact {
                    CompactSessionRow(
                        session: session,
                        showsProjectName: !groupsSessionsByProject,
                        preheatRequested: { _ in }
                    )
                        .environmentObject(backendClient)
                } else {
                    TaskCardView(
                        session: session,
                        showsProjectName: !groupsSessionsByProject
                    )
                        .environmentObject(backendClient)
                }
            }
            .frame(width: dragFrame.width)
            .scaleEffect(1.012)
            .shadow(color: .black.opacity(0.22), radius: 12, y: 5)
            .offset(
                x: dragFrame.minX - viewportFrame.minX,
                y: SessionReorderLayout.draggedTopY(
                    initialTopY: dragFrame.minY,
                    mouseDeltaY: reorderDragScreenDeltaY
                ) - viewportFrame.minY
            )
            .allowsHitTesting(false)
            .transaction { transaction in
                transaction.animation = nil
                transaction.disablesAnimations = true
            }
            .zIndex(100)
        }
    }

    @ViewBuilder
    private var sessionHoverPreviewOverlay: some View {
        if let session = backendClient.sessions.first(where: { $0.id == hoverPreviewSessionId }),
           let frame = sessionCardFrames[session.id] {
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

        if CorptieAppEnvironment.isDevelopment,
           SessionListPerformanceFlags.current.layoutLoggingEnabled {
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
        guard CorptieAppEnvironment.isDevelopment,
              SessionListPerformanceFlags.current.layoutLoggingEnabled else { return }
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

    private func debugSessionId(_ id: String) -> String {
        "\(id.prefix(9))…\(id.suffix(6))"
    }

    private var sessionListReorderGesture: some Gesture {
        DragGesture(minimumDistance: 7, coordinateSpace: .named("session-list"))
            .onChanged { value in
                let session: TaskSession
                if let activeSessionId = draggedSessionId,
                   let activeSession = backendClient.sessions.first(where: { $0.id == activeSessionId }) {
                    session = activeSession
                } else {
                    guard let hitSessionId = SessionReorderLayout.sessionId(
                        at: value.startLocation,
                        using: sessionCardFrames,
                        eligibleIds: Set(backendClient.sessions.map(\.id))
                    ),
                    let hitSession = backendClient.sessions.first(where: { $0.id == hitSessionId }),
                    let frame = sessionCardFrames[hitSessionId] else {
                        return
                    }
                    session = hitSession
                    let mouseScreenY = NSEvent.mouseLocation.y
                    draggedSessionId = hitSession.id
                    reorderDragFrame = frame
                    // Keep hit-testing anchored to the layout that existed at
                    // mouse-down. Reordering the model immediately relays out
                    // the live rows, so using their new frames would make the
                    // insertion target drift underneath a stationary pointer.
                    reorderSessionFrames = sessionCardFrames
                    // The gesture belongs to the stable list viewport rather
                    // than a row that can move or be recreated. AppKit's global
                    // coordinate then makes the floating preview independent of
                    // any SwiftUI layout or coordinate-space rebasing.
                    reorderDragStartMouseScreenY = mouseScreenY + value.translation.height
                    reorderDragScreenDeltaY = value.translation.height
                    reorderTargetSessionId = nil
                    hoverPreviewSessionId = nil
                    hasResolvedReorderTarget = false
                    backendClient.beginSessionReorder()
                    logSessionReorder(
                        "begin id=\(debugSessionId(hitSession.id)) frame=\(debugRect(frame)) viewport=\(sessionCardFrames[listViewportFrameKey].map(debugRect) ?? "nil") screenY=\(debugNumber(mouseScreenY)) stableDeltaY=\(debugNumber(reorderDragScreenDeltaY)) rawTranslationY=\(debugNumber(value.translation.height))"
                    )
                }

                let mouseScreenY = NSEvent.mouseLocation.y
                let stableMouseDeltaY = reorderDragStartMouseScreenY - mouseScreenY
                var continuousTransaction = Transaction(animation: nil)
                continuousTransaction.isContinuous = true
                withTransaction(continuousTransaction) {
                    reorderDragScreenDeltaY = stableMouseDeltaY
                }
                let stableFrames = reorderSessionFrames.isEmpty ? sessionCardFrames : reorderSessionFrames
                guard !stableFrames.isEmpty else {
                    return
                }

                let eligibleIds = Set(backendClient.sessions.lazy
                    .filter { ($0.pinned == true) == (session.pinned == true) }
                    .map(\.id))
                let draggedCenterY = SessionReorderLayout.draggedCenterY(
                    initialCenterY: reorderDragFrame?.midY ?? sessionCardFrames[session.id]?.midY ?? 0,
                    mouseDeltaY: stableMouseDeltaY
                )
                let targetSessionId = SessionReorderLayout.insertionTargetSessionId(
                    forDraggedCenterY: draggedCenterY,
                    excluding: session.id,
                    using: stableFrames,
                    eligibleIds: eligibleIds
                )
                guard targetSessionId != reorderTargetSessionId || !hasResolvedReorderTarget else {
                    return
                }

                reorderTargetSessionId = targetSessionId
                hasResolvedReorderTarget = true
                logSessionReorder(
                    "target id=\(debugSessionId(session.id)) centerY=\(debugNumber(draggedCenterY)) before=\(targetSessionId.map(debugSessionId) ?? "end") screenY=\(debugNumber(mouseScreenY)) stableDeltaY=\(debugNumber(stableMouseDeltaY)) rawLocationY=\(debugNumber(value.location.y)) rawTranslationY=\(debugNumber(value.translation.height))"
                )
                withAnimation(.interactiveSpring(response: 0.22, dampingFraction: 0.88, blendDuration: 0.08)) {
                    backendClient.moveSession(draggedSessionId: session.id, before: targetSessionId)
                }
            }
            .onEnded { _ in
                guard let completedSessionId = draggedSessionId,
                      let completedSession = backendClient.sessions.first(where: { $0.id == completedSessionId }) else {
                    return
                }
                let stableMouseDeltaY = reorderDragStartMouseScreenY - NSEvent.mouseLocation.y
                let stableFrames = reorderSessionFrames.isEmpty ? sessionCardFrames : reorderSessionFrames
                let eligibleIds = Set(backendClient.sessions.lazy
                    .filter { ($0.pinned == true) == (completedSession.pinned == true) }
                    .map(\.id))
                let draggedCenterY = SessionReorderLayout.draggedCenterY(
                    initialCenterY: reorderDragFrame?.midY ?? stableFrames[completedSessionId]?.midY ?? 0,
                    mouseDeltaY: stableMouseDeltaY
                )
                let finalTargetSessionId = SessionReorderLayout.insertionTargetSessionId(
                    forDraggedCenterY: draggedCenterY,
                    excluding: completedSessionId,
                    using: stableFrames,
                    eligibleIds: eligibleIds
                )
                logSessionReorder(
                    "end id=\(debugSessionId(completedSessionId)) stableDeltaY=\(debugNumber(stableMouseDeltaY)) before=\(finalTargetSessionId.map(debugSessionId) ?? "end")"
                )
                // DragGesture does not guarantee that its final pointer
                // position is delivered through onChanged. Settle once more
                // from the actual mouse position before persisting the order.
                backendClient.moveSession(
                    draggedSessionId: completedSessionId,
                    before: finalTargetSessionId
                )
                backendClient.persistSessionOrder()
                withAnimation(.spring(response: 0.24, dampingFraction: 0.86)) {
                    draggedSessionId = nil
                    reorderDragFrame = nil
                    reorderSessionFrames = [:]
                    reorderDragStartMouseScreenY = 0
                    reorderDragScreenDeltaY = 0
                    reorderTargetSessionId = nil
                    hasResolvedReorderTarget = false
                }
            }
    }

    private func logSessionReorder(_ message: String) {
        guard CorptieAppEnvironment.isDevelopment else { return }
        print("[reorder-debug] \(message)")
    }

}

enum SessionDisplayMode: String {
    case cards
    case compact
}

private struct SessionProjectGroup: Identifiable {
    let id: String
    let path: String
    let rows: [SessionRowModel]
}

struct SessionListRowContent: View {
    @ObservedObject var row: SessionRowModel
    let displayMode: SessionDisplayMode
    let showsProjectName: Bool
    let isHiddenForReorder: Bool
    let hoverPreviewChanged: (String, Bool) -> Void
    let preheatRequested: (TaskSession) -> Void

    var body: some View {
        Group {
            if displayMode == .compact {
                CompactSessionRow(
                    session: row.session,
                    showsProjectName: showsProjectName,
                    preheatRequested: preheatRequested
                )
            } else {
                TaskCardView(
                    session: row.session,
                    showsProjectName: showsProjectName,
                    hoverPreviewChanged: hoverPreviewChanged,
                    preheatRequested: preheatRequested
                )
            }
        }
        .opacity(isHiddenForReorder ? 0 : 1)
    }
}

struct DetailSessionRailRow: View {
    @ObservedObject var row: SessionRowModel
    let selectedSessionID: String?
    let select: (TaskSession) -> Void
    let preheat: (TaskSession) -> Void

    private var session: TaskSession { row.session }
    private var isSelected: Bool { selectedSessionID == row.id }

    var body: some View {
        Button {
            guard !isSelected else { return }
            select(session)
        } label: {
            VStack(spacing: 2) {
                SessionAvatarView(session: session, avatarSize: isSelected ? 38 : 34)
                    .frame(width: 58, height: 58)
                    .background {
                        if isSelected {
                            Circle().fill(Color.white.opacity(0.22))
                            Circle().strokeBorder(Color.white.opacity(0.48), lineWidth: 1)
                        }
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
        .buttonStyle(.plain)
        .help("\(session.title)\n\(session.status.label)")
        .onHover { hovering in
            if hovering { preheat(session) }
        }
    }
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

struct CompactSessionRow: View {
    @EnvironmentObject private var backendClient: BackendClient
    @State private var isRenaming = false
    let session: TaskSession
    var showsProjectName = true
    var preheatRequested: (TaskSession) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 10) {
            SessionAvatarView(session: session, avatarSize: 28)
            Text(session.title)
                .font(.system(size: 12.5, weight: .semibold))
                .lineLimit(1)
                .layoutPriority(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 4)
        }
        .padding(.horizontal, 10)
        .frame(height: 46)
        .standardSessionCardSurface()
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onHover { if $0 { preheatRequested(session) } }
        .onTapGesture { backendClient.select(session: session) }
        .contextMenu {
            SessionContextMenuContent(session: session, isRenaming: $isRenaming)
        }
        .sheet(isPresented: $isRenaming) {
            RenameSessionSheet(session: session) { isRenaming = false }
                .environmentObject(backendClient)
                .presentationBackground(.clear)
        }
    }

}

private struct SessionIdentityLine: View {
    let session: TaskSession
    var showsProjectName = false
    var fontSize: CGFloat = 10

    var body: some View {
        HStack(spacing: 6) {
            SessionAgentIdentity(session: session)

            if let branchName {
                HStack(spacing: 2) {
                    Image(systemName: "arrow.triangle.branch")
                    Text(branchName)
                        .fontDesign(.monospaced)
                        .truncationMode(.middle)
                }
                .foregroundStyle(CorptiePalette.secondaryText)
                .lineLimit(1)
                .layoutPriority(1)
                .help(branchName)
            }

            if showsProjectName, let projectName {
                HStack(spacing: 2) {
                    Image(systemName: "folder")
                    Text(projectName)
                }
                    .foregroundStyle(CorptiePalette.mutedText)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(-1)
                    .help(projectPath ?? projectName)
            }
        }
        .font(.system(size: fontSize, weight: .semibold))
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
    }

    private var branchName: String? {
        normalized(session.external?.workspace?.branchName)
    }

    private var projectPath: String? {
        normalized(session.external?.workspace?.projectPath)
            ?? normalized(session.external?.cwd)
    }

    private var projectName: String? {
        projectPath.map { URL(fileURLWithPath: $0).standardizedFileURL.lastPathComponent }
    }

    private func normalized(_ value: String?) -> String? {
        let text = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }
}

private struct SessionAgentIdentity: View {
    let session: TaskSession

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "cpu")
            Text(session.agent)
        }
        .foregroundStyle(session.accent.color)
        .fixedSize(horizontal: true, vertical: false)
    }
}

private struct SessionContextMenuContent: View {
    @EnvironmentObject private var backendClient: BackendClient

    let session: TaskSession
    @Binding var isRenaming: Bool

    var body: some View {
        Button {
            isRenaming = true
        } label: {
            Label(L10n("Rename"), systemImage: "pencil")
        }

        Button {
            SessionSettingsWindowManager.shared.show(session: session, backendClient: backendClient)
        } label: {
            Label(L10n("Settings…"), systemImage: "gearshape")
        }

        if session.actions?.restart?.available == true {
            Button {
                backendClient.restart(session: session)
            } label: {
                Label(L10n("Restart Session"), systemImage: "arrow.clockwise")
            }
            .disabled(backendClient.restartingSessionIds.contains(session.id))
        }

        Divider()

        Button {
            backendClient.setPinned(session.pinned != true, session: session)
        } label: {
            Label(
                session.pinned == true ? L10n("Unpin") : L10n("Pin to Top"),
                systemImage: session.pinned == true ? "pin.slash" : "pin"
            )
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
    @State private var isHovering = false

    var body: some View {
        Button {
            let mainWindow = NSApp.keyWindow
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

    func measureListMinY(_ metric: ListHeightMetric, coordinateSpace: String) -> some View {
        background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: ListHeightPreferenceKey.self,
                    value: [metric: proxy.frame(in: .named(coordinateSpace)).minY]
                )
            }
        )
    }

}

private struct LiquidGlassPanelBackground: View {
    @EnvironmentObject private var panelFocusState: PanelFocusState
    let cornerRadius: CGFloat

    var body: some View {
        if !SessionListPerformanceFlags.current.glassEffectsEnabled {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color(nsColor: .windowBackgroundColor))
        } else if #available(macOS 26.0, *) {
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

private struct FastHoverTrackingArea: NSViewRepresentable {
    let hoverChanged: (Bool) -> Void

    func makeNSView(context: Context) -> TrackingView {
        let view = TrackingView()
        view.hoverChanged = hoverChanged
        return view
    }

    func updateNSView(_ nsView: TrackingView, context: Context) {
        nsView.hoverChanged = hoverChanged
    }

    final class TrackingView: NSView {
        var hoverChanged: ((Bool) -> Void)?

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            trackingAreas.forEach(removeTrackingArea)
            addTrackingArea(NSTrackingArea(
                rect: .zero,
                options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                owner: self,
                userInfo: nil
            ))
        }

        override func mouseEntered(with event: NSEvent) {
            hoverChanged?(true)
        }

        override func mouseExited(with event: NSEvent) {
            hoverChanged?(false)
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

    func show(backendClient: BackendClient, workspacePath: String? = nil) {
        if let panel {
            if workspacePath != nil {
                close()
            } else {
                panel.makeKeyAndOrderFront(nil)
                panel.orderFrontRegardless()
                NSApp.activate(ignoringOtherApps: true)
                isPresented = true
                return
            }
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

        let rootView = NewPtyAgentTaskSheet(
            initialWorkspacePath: workspacePath,
            close: { [weak self] in self?.close() }
        )
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
    @AppStorage("newTask.defaultCodexModel", store: CorptieAppEnvironment.userDefaults) private var defaultCodexModel = ""
    @AppStorage("newTask.defaultCodexReasoningLevel", store: CorptieAppEnvironment.userDefaults) private var defaultCodexReasoningLevel = ""
    @AppStorage("newTask.defaultClaudeModel", store: CorptieAppEnvironment.userDefaults) private var defaultClaudeModel = ""
    @State private var title = ""
    @State private var selectedProviderId = ""
    @State private var existingSessionId = ""
    @State private var cwd = ""
    @State private var sandboxMode = "workspace-write"
    @State private var approvalPolicy = "on-request"
    @State private var selectedModelId = ""
    @State private var selectedReasoningLevel = ""
    @State private var defaultSaveMessage: String?
    @State private var sessionLookupTask: Task<Void, Never>?
    @State private var isLookingUpSession = false
    @State private var sessionLookupMessage: String?
    @State private var isShowingAdvanced = false
    @State private var suggestedSessionTitle: String?
    let close: () -> Void

    init(initialWorkspacePath: String? = nil, close: @escaping () -> Void) {
        _cwd = State(initialValue: initialWorkspacePath ?? "")
        self.close = close
    }

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
                    ForEach(creatableProviders) { provider in
                        PresetButton(
                            title: provider.displayName,
                            command: provider.id,
                            arguments: "",
                            isSelected: selectedProviderId == provider.id,
                            isDisabled: backendClient.isCreatingTask
                        ) { _ in
                            selectedProviderId = provider.id
                        }
                    }
                    if creatableProviders.isEmpty {
                        ProgressView().controlSize(.small)
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
                    reasoningPicker

                    if selectedProviderId == "codex-app-server" {
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
                    }

                    if supportsPermissionConfiguration {
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
                                .help(L10n("Controls the Agent filesystem sandbox mode"))
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
                                .help(L10n("Controls when the Agent asks before running privileged actions"))
                            }
                        }
                        if sandboxMode == "danger-full-access" {
                            Label(L10n("Full Access lets the Agent operate outside the workspace. Use it only for trusted tasks."), systemImage: "exclamationmark.triangle")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(CorptiePalette.amber)
                        }
                    }
                    if selectedProvider?.runtime.lifecycle == "managed" {
                        HStack(spacing: 8) {
                        Button {
                            saveNewSessionDefaults()
                        } label: {
                            Label(L10n("Set as Future Default"), systemImage: "checkmark.seal")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(CorptiePalette.softBlue)
                        .help(L10n("Use the selected model, reasoning, permission, and approval settings for future new sessions"))

                        if let defaultSaveMessage {
                            Text(defaultSaveMessage)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(CorptiePalette.secondaryText)
                                .transition(.opacity)
                        }
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
            Task {
                if backendClient.agentProviders.isEmpty {
                    await backendClient.loadProviders()
                }
                reconcileProviderSelection()
                loadModelsForCurrentAgent()
            }
        }
        .onDisappear {
            sessionLookupTask?.cancel()
        }
        .onChange(of: selectedProviderId) { _, _ in
            selectedModelId = ""
            selectedReasoningLevel = ""
            loadModelsForCurrentAgent()
        }
        .onChange(of: backendClient.agentProviders) { _, providers in
            reconcileProviderSelection()
            loadModelsForCurrentAgent()
        }
        .onChange(of: backendClient.defaultAgentProviderId) { _, _ in
            reconcileProviderSelection()
        }
        .onChange(of: backendClient.codexDefaultModel) { _, value in
            applyDefaultModelIfNeeded(value)
        }
        .onChange(of: backendClient.codexModels) { _, _ in
            applyDefaultModelIfNeeded(backendClient.codexDefaultModel)
        }
        .onChange(of: backendClient.codexDefaultReasoningLevel) { _, _ in
            applyDefaultReasoningIfNeeded()
        }
        .onChange(of: selectedModelId) { _, _ in
            applyDefaultReasoningIfNeeded(preferCurrentSelection: true)
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
                    if !selectedModelId.isEmpty,
                       !backendClient.codexModels.contains(where: { $0.id == selectedModelId }) {
                        Text(selectedModelId).tag(selectedModelId)
                    }
                    ForEach(backendClient.codexModels) { model in
                        Text(model.name).tag(model.id)
                    }
                    if selectedModelId.isEmpty && backendClient.codexModels.isEmpty {
                        Text(L10n("No models available")).tag("")
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(L10n("Choose the model for this new session"))
            }
        }
    }

    @ViewBuilder
    private var reasoningPicker: some View {
        if supportsReasoningSelection {
            VStack(alignment: .leading, spacing: 7) {
                Text(L10n("Reasoning"))
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.black)

                Picker(L10n(""), selection: $selectedReasoningLevel) {
                    if !selectedReasoningLevel.isEmpty,
                       !currentReasoningLevels.contains(selectedReasoningLevel) {
                        Text(newSessionReasoningLabel(selectedReasoningLevel))
                            .tag(selectedReasoningLevel)
                    }
                    ForEach(currentReasoningLevels, id: \.self) { reasoningLevel in
                        Text(newSessionReasoningLabel(reasoningLevel))
                            .tag(reasoningLevel)
                    }
                    if selectedReasoningLevel.isEmpty && currentReasoningLevels.isEmpty {
                        Text(L10n("No reasoning options")).tag("")
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(L10n("Choose the reasoning strength for this new session"))
            }
        }
    }

    private var supportsModelSelection: Bool {
        selectedProvider?.supports("configuration.model.list") == true
    }

    private var supportsReasoningSelection: Bool {
        selectedProvider?.supports("configuration.reasoning.switch") == true
    }

    private var supportsPermissionConfiguration: Bool {
        selectedProvider?.supports("configuration.permissions.update") == true
    }

    private var modelProviderForCurrentAgent: String {
        selectedProviderId
    }

    private var creatableProviders: [AgentProviderDescriptor] {
        backendClient.agentProviders.filter { $0.supports("session.create") }
    }

    private var selectedProvider: AgentProviderDescriptor? {
        backendClient.agentProviders.first(where: { $0.id == selectedProviderId })
    }

    private func reconcileProviderSelection() {
        guard !creatableProviders.contains(where: { $0.id == selectedProviderId }) else { return }
        if let defaultProviderId = backendClient.defaultAgentProviderId,
           creatableProviders.contains(where: { $0.id == defaultProviderId }) {
            selectedProviderId = defaultProviderId
        } else {
            selectedProviderId = creatableProviders.first?.id ?? ""
        }
    }

    private var currentReasoningLevels: [String] {
        selectedModel?.reasoningLevels ?? []
    }

    private var selectedModel: CodexModel? {
        backendClient.codexModels.first(where: { $0.id == selectedModelId })
    }

    private var savedModelForCurrentAgent: String? {
        if selectedProviderId == "claude-sdk" {
            return nonEmptyNewSessionValue(defaultClaudeModel)
                ?? backendClient.settings?.newSessionDefaults?.claudeModel
        }
        return nonEmptyNewSessionValue(defaultCodexModel)
            ?? backendClient.settings?.newSessionDefaults?.codexModel
    }

    private var savedCodexReasoning: String? {
        nonEmptyNewSessionValue(defaultCodexReasoningLevel)
            ?? backendClient.settings?.newSessionDefaults?.codexReasoningLevel
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
        selectedModelId = NewSessionModelSelection.preferredModelId(
            savedModelId: savedModelForCurrentAgent,
            providerDefaultModelId: defaultModel,
            models: backendClient.codexModels
        )
        applyDefaultReasoningIfNeeded()
    }

    private func applyDefaultReasoningIfNeeded(preferCurrentSelection: Bool = false) {
        guard supportsReasoningSelection else {
            selectedReasoningLevel = ""
            return
        }
        let preferredReasoning = preferCurrentSelection && !selectedReasoningLevel.isEmpty
            ? selectedReasoningLevel
            : savedCodexReasoning
        selectedReasoningLevel = NewSessionModelSelection.preferredReasoningLevel(
            savedReasoningLevel: preferredReasoning,
            providerDefaultReasoningLevel: backendClient.codexDefaultReasoningLevel,
            model: selectedModel
        )
    }

    private func saveNewSessionDefaults() {
        defaultSandboxMode = validatedSandboxMode(sandboxMode)
        defaultApprovalPolicy = validatedApprovalPolicy(approvalPolicy)
        if selectedProviderId == "codex-app-server" {
            defaultCodexModel = selectedModelId
            defaultCodexReasoningLevel = selectedReasoningLevel
        } else if selectedProviderId == "claude-sdk" {
            defaultClaudeModel = selectedModelId
        }
        Task {
            await backendClient.syncNewSessionDefaultsFromPreferences(force: true)
        }
        withAnimation(.easeOut(duration: 0.12)) {
            defaultSaveMessage = L10n("Saved")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            withAnimation(.easeOut(duration: 0.12)) {
                defaultSaveMessage = nil
            }
        }
    }

    private func newSessionReasoningLabel(_ value: String) -> String {
        switch value.lowercased() {
        case "low": L10n("Low")
        case "medium": L10n("Medium")
        case "high": L10n("High")
        case "xhigh": L10n("Extra High")
        default: value
        }
    }

    private func nonEmptyNewSessionValue(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
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
        let finalTitle = titleOverride ?? (trimmedTitle.isEmpty ? defaultSessionTitle(for: workspace) : trimmedTitle)
        if selectedProviderId == "codex-app-server" && isBindingExistingSession {
            backendClient.createCodexPtyTask(
                title: finalTitle,
                prompt: "",
                cwd: workspace,
                existingSessionId: existingSessionId,
                sandbox: sandboxMode,
                approvalPolicy: approvalPolicy,
                model: selectedModelId,
                reasoningLevel: selectedReasoningLevel,
                onNameConflict: { suggestedSessionTitle = $0 }
            ) {
                close()
            }
        } else {
            backendClient.createProviderTask(
                providerId: selectedProviderId,
                title: finalTitle,
                prompt: "",
                cwd: workspace,
                sandbox: sandboxMode,
                approvalPolicy: approvalPolicy,
                model: selectedModelId,
                reasoningLevel: selectedReasoningLevel,
                onNameConflict: { suggestedSessionTitle = $0 }
            ) {
                close()
            }
        }
    }

    private var defaultSessionTitle: String {
        let workspace = cwd.isEmpty ? backendClient.defaultWorkspacePath : cwd
        return defaultSessionTitle(for: workspace)
    }

    private func defaultSessionTitle(for path: String) -> String {
        let folderName = URL(fileURLWithPath: path).standardizedFileURL.lastPathComponent
        return folderName.isEmpty ? "Agent" : "\(folderName)_agent"
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
        if backendClient.isCreatingTask {
            return true
        }
        if isLookingUpSession {
            return true
        }
        if isBindingExistingSession && sessionLookupMessage?.hasPrefix("Session not found") == true {
            return true
        }
        if supportsModelSelection && selectedModelId.isEmpty {
            return true
        }
        if supportsReasoningSelection && selectedReasoningLevel.isEmpty {
            return true
        }
        return selectedProvider == nil
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

struct TaskCardView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @State private var quickReply = ""
    @State private var lastQuickReplyInteractionAt = Date.distantPast
    @State private var isRenaming = false
    @State private var isShowingUnboundHint = false
    @State private var isHoveringSummary = false
    @State private var hoverPreviewTask: Task<Void, Never>?
    @FocusState private var isQuickReplyFocused: Bool

    let session: TaskSession
    var showsProjectName = true
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
                    SessionIdentityLine(
                        session: session,
                        showsProjectName: showsProjectName,
                        fontSize: 10
                    )
                }
                .frame(maxWidth: .infinity, alignment: .leading)

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
                .contentShape(Rectangle())
                .onHover { hovering in
                    handleSummaryHover(hovering)
                }

            HStack(spacing: 10) {
                if let restartActivity = backendClient.restartActivityBySessionId[session.id] {
                    ActivityStatusText(
                        text: restartActivity.text,
                        isActive: restartActivity.isActive,
                        fontSize: 11
                    )
                        .frame(height: 14)
                        .layoutPriority(-1)
                } else if let activityStatus = session.activityStatus,
                          !activityStatus.isEmpty,
                          session.status == .running {
                    ActivityStatusText(text: activityStatus, isActive: true, fontSize: 11)
                        .frame(height: 14)
                        .layoutPriority(-1)
                }

                Text(relativeTime(session.updatedAt))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.mutedText)
                    .lineLimit(1)

                if session.status == .running {
                    Spacer()

                    if session.canInterruptNow {
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
            SessionContextMenuContent(session: session, isRenaming: $isRenaming)
        }
        .sheet(isPresented: $isRenaming) {
            RenameSessionSheet(session: session) {
                isRenaming = false
            }
            .environmentObject(backendClient)
            .presentationBackground(.clear)
        }
    }

    private var hasSuggestedOptions: Bool {
        !(session.suggestedOptions ?? []).isEmpty
    }

    private var canQuickReply: Bool {
        session.canSendNow
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
        if session.isUnboundSession {
            return L10n("Session is not bound yet")
        }
        if session.canResumeNow && !session.isConnected {
            return L10n("Reconnect session")
        }
        if !session.usesManualConnection {
            return L10n("Session is available")
        }
        if session.isConnecting || backendClient.connectionTransitionSessionIds.contains(session.id) {
            return L10n("Switching PTY connection")
        }
        return session.isConnected ? L10n("Disconnect PTY") : L10n("Reconnect PTY")
    }

    private var connectionIndicatorPopoverText: String {
        if session.isUnboundSession {
            return L10n("尚未发送消息的会话，无法切换状态。")
        }
        if session.canResumeNow && !session.isConnected {
            return L10n("点击重新连接这个会话。")
        }
        if !session.usesManualConnection {
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
            if session.isUnboundSession {
                isShowingUnboundHint = true
            } else if session.canResumeNow && !session.isConnected {
                backendClient.reconnect(session: session)
            } else if session.usesManualConnection {
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
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    let cornerRadius: CGFloat
    let fillOpacity: Double

    var body: some View {
        if !isLiquidGlass {
            // 原生降级：简洁卡片背景（Sessions Tab）
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
        } else if !SessionListPerformanceFlags.current.glassEffectsEnabled {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
        } else if #available(macOS 26.0, *) {
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
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    private let cornerRadius: CGFloat = 18
    private let glassStrength: Double = 0.55

    private var fillOpacity: Double {
        0.12 + glassStrength * 0.12
    }

    private var strokeOpacity: Double {
        0.18 + glassStrength * 0.14
    }

    func body(content: Content) -> some View {
        if isLiquidGlass {
            content
                .background(
                    LiquidGlassCardBackground(cornerRadius: cornerRadius, fillOpacity: fillOpacity)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(Color.white.opacity(strokeOpacity), lineWidth: 1)
                }
        } else {
            // 原生（Sessions Tab）：去掉卡片外壳，退回普通行
            content
        }
    }
}

private extension View {
    func standardSessionCardSurface() -> some View {
        modifier(StandardSessionCardSurface())
    }
}

struct AgentAvatarView: View {
    @ObservedObject private var client = EntityAPIClient.shared

    let session: TaskSession
    let size: CGFloat
    var showsChrome = true

    // 会话统一继承其绑定 Agent 的头像：优先使用 Agent 自定义头像，否则用 Agent 级派生渐变+首字母。
    private var boundAgent: Agent? {
        guard let agentId = session.agentId, !agentId.isEmpty else { return nil }
        return client.agents.first { $0.agentId == agentId }
    }

    var body: some View {
        Group {
            if let avatarPath = boundAgent?.avatarPath, !avatarPath.isEmpty {
                AnimatedAvatarImage(path: avatarPath)
                    .background(Color.white.opacity(0.16))
            } else {
                DefaultInitialAvatarView(
                    familySeed: familySeed,
                    variationSeed: variationSeed,
                    initials: initials,
                    size: size
                )
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

    // 同一 Agent 下所有会话共用同一种子（familySeed = agent 名，variationSeed = agentId），保证头像一致。
    private var familySeed: String {
        boundAgent?.name ?? session.agent
    }

    private var variationSeed: String {
        boundAgent?.agentId ?? session.agentId ?? session.agent
    }

    private var initials: String {
        if let agent = boundAgent {
            return DefaultAvatarInitials.make(from: agent.name)
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

struct AnimatedAvatarImage: NSViewRepresentable {
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

struct DetailView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @EnvironmentObject private var panelLayoutState: PanelLayoutState
    @MainActor
    static var initialVisibleMessageLimit: Int {
        ChatTimelineFeatureFlags.current.initialDisplayWeight
    }
    @State private var didInitialScroll = false
    @State private var visibleMessageLimit: Int
    @State private var cachedSourceItemCount = 0
    @State private var cachedSourcePenultimateItemId: String?
    @State private var cachedSourceTailItem: CodexThreadItem?
    @State private var cachedDisplayEntries: [ChatDisplayEntry] = []
    @State private var cachedAppKitRows: [AppKitChatTimelineRow] = []
    @State private var cachedTotalDisplayEntryCount = 0
    @State private var cachedVisibleMessageLimit = 0
    @State private var cachedItemsSignature = ""
    @State private var cachedDetailSourceSignature = ""
    @State private var cachedSessionId = ""
    @State private var displayCacheBySessionId: [String: DetailDisplayCache] = [:]
    @State private var collaborationExpansionByItemKey: [String: Bool] = [:]
    @State private var collaborationConfirmationExpansionByItemKey: [String: Bool] = [:]
    @State private var expandedProcessTurnIds: Set<String> = []
    @State private var detailScrollViewportHeight: CGFloat = 0
    @State private var detailScrollBottomMaxY: CGFloat = 0
    @State private var isDetailScrolledNearBottom = true
    @State private var isFollowingLatest = true
    @State private var isMaintainingFollowPosition = false
    @State private var pendingFollowScrollWorkItem: DispatchWorkItem?
    @State private var lastVisibleContentSignature = ""
    @State private var hasNewMessagesBelow = false
    @State private var appKitScrollToBottomRevision = 0
    let sessionId: String
    let preheatedDisplayCache: DetailDisplayCache?
    let composerDraftRepository: ComposerDraftRepository
    // 渲染管线覆盖：nil = 跟随全局 ChatTimelineFeatureFlags.current；Session Tab 传 .swiftUIVStack 走纯 SwiftUI，避开 AppKit 桥接。
    let renderer: ChatTimelineRenderer?

    init(
        sessionId: String,
        preheatedDisplayCache: DetailDisplayCache?,
        composerDraftRepository: ComposerDraftRepository,
        renderer: ChatTimelineRenderer? = nil
    ) {
        self.sessionId = sessionId
        self.preheatedDisplayCache = preheatedDisplayCache
        self.composerDraftRepository = composerDraftRepository
        self.renderer = renderer
        _visibleMessageLimit = State(
            initialValue: ChatTimelineFeatureFlags.current.initialDisplayWeight
        )
    }

    private var effectiveRenderer: ChatTimelineRenderer {
        renderer ?? ChatTimelineFeatureFlags.current.renderer
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            DetailHeaderView()

            if let recovery = backendClient.workspaceRecoveryStatus,
               recovery.orphaned {
                OrphanedWorkspaceRecoveryView(status: recovery)
            }

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
                ThreadMetaView(
                    status: detail.status,
                    isConnecting: detail.isConnecting,
                    connectionColor: detail.connectionColor,
                    activityStatus: detail.activityStatus
                )

                Group {
                    if shouldRenderDetailMessages {
                        if effectiveRenderer == .appKitTable
                            || effectiveRenderer == .appKitNativeText {
                            appKitCachedDetailMessages()
                        } else {
                            detailMessages(detail)
                        }
                    } else {
                        DetailMessagesPlaceholder()
                    }
                }
                .onAppear {
                    if let currentDetail = backendClient.selectedDetail {
                        updateCachedDisplayEntries(for: currentDetail)
                    }
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
                && backendClient.selectedDetail?.canInterruptNow != true {
                ReadOnlyComposer(reason: backendClient.selectedDetail?.sendUnavailableReason)
            } else {
                MessageComposer(
                    sessionId: sessionId,
                    draftRepository: composerDraftRepository
                )
                    .id(sessionId)
            }
        }
        .padding(1)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.white.opacity(0.001))
        )
        .onAppear {
            restorePreheatedDisplayCacheIfNeeded()
        }
        .onChange(of: preheatedDisplayCache?.signature) { _, _ in
            restorePreheatedDisplayCacheIfNeeded()
        }
        .onChange(of: sessionId) { _, _ in
            didInitialScroll = false
            isDetailScrolledNearBottom = true
            isFollowingLatest = true
            isMaintainingFollowPosition = false
            pendingFollowScrollWorkItem?.cancel()
            pendingFollowScrollWorkItem = nil
            lastVisibleContentSignature = ""
            hasNewMessagesBelow = false
            detailScrollViewportHeight = 0
            detailScrollBottomMaxY = 0
            visibleMessageLimit = ChatTimelineFeatureFlags.current.initialDisplayWeight
            collaborationExpansionByItemKey.removeAll()
            collaborationConfirmationExpansionByItemKey.removeAll()
            expandedProcessTurnIds.removeAll()
            restoreDisplayCacheForCurrentSession()
        }
    }

    @ViewBuilder
    private func detailMessages(_ detail: CodexThreadDetail) -> some View {
        let preparedDisplay = preparedDisplayEntries(for: detail)
        let displayEntries = preparedDisplay.visibleEntries
        let visibleDisplayWeight = displayEntries.reduce(0) { $0 + $1.displayWeight }
        let hiddenCount = max(0, preparedDisplay.totalCount - visibleDisplayWeight)

        swiftUIDetailMessages(detail, displayEntries: displayEntries, hiddenCount: hiddenCount)
    }

    private func appKitCachedDetailMessages() -> some View {
        let visibleWeight = cachedDisplayEntries.reduce(0) { $0 + $1.displayWeight }
        let hiddenCount = max(0, cachedTotalDisplayEntryCount - visibleWeight)
        return appKitDetailMessages(displayEntries: cachedDisplayEntries, hiddenCount: hiddenCount)
    }

    private func swiftUIDetailMessages(
        _ detail: CodexThreadDetail,
        displayEntries: [ChatDisplayEntry],
        hiddenCount: Int
    ) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: true) {
                // Dynamic-height Markdown and nested horizontal code scrollers can
                // send LazyVStack's off-screen height estimator into a sustained
                // layout loop on macOS. Keep the explicitly paged timeline eager
                // until the bounded-window timeline store is available; a regular
                // stack is slower for very large pages but avoids the lazy
                // estimate loop observed in production.
                VStack(alignment: .leading, spacing: 8) {
                    if hiddenCount > 0 {
                        Button {
                            let anchor = DetailHistoryScrollAnchor.resolve(
                                orderedEntryIds: displayEntries.map(\.id)
                            )
                            isFollowingLatest = false
                            ChatPerformanceRecorder.shared.increment(.historyPrepends)
                            ChatPerformanceTrace.event("timeline.history.prepend", value: min(100, hiddenCount))
                            visibleMessageLimit += 100
                            updateCachedDisplayEntries(for: detail)
                            restoreHistoryScrollAnchor(anchor, proxy: proxy)
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
                        Group {
                            switch entry.kind {
                            case .message(let item):
                                ThreadItemView(
                                    item: item,
                                    isCollaborationExpanded: collaborationExpansionBinding(for: item),
                                    isCollaborationConfirmationExpanded: collaborationConfirmationExpansionBinding(for: item)
                                )
                            case .process(let turnId, let items):
                                ThreadProcessGroupView(
                                    items: items,
                                    isExpanded: expandedProcessTurnIds.contains(turnId),
                                    onToggle: {
                                        toggleNativeProcessExpansion(turnId)
                                    }
                                )
                            }
                        }
                        .id(entry.id)
                        .transition(.asymmetric(
                            insertion: .move(edge: .bottom).combined(with: .opacity),
                            removal: .identity
                        ))
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
            .onAppear {
                updateCachedDisplayEntries(for: detail)
                lastVisibleContentSignature = visibleContentSignature(for: cachedDisplayEntries)
                scrollToLatestAfterLayout(detail: detail, proxy: proxy, force: true)
            }
            .onChange(of: detailSourceSignature(for: detail)) { _, _ in
                // Following is valid only while the viewport is actually at the
                // bottom. A content update can arrive before the next geometry
                // preference callback after a user scroll, so the historical
                // follow flag alone is not safe enough to trigger scrollTo.
                let wasFollowingLatest = isFollowingLatest && isDetailScrolledNearBottom
                isFollowingLatest = wasFollowingLatest
                if wasFollowingLatest && !expandedProcessTurnIds.isEmpty {
                    isMaintainingFollowPosition = true
                }
                updateCachedDisplayEntries(for: detail)
                maintainLatestPositionIfVisibleContentChanged(detail: detail, proxy: proxy)
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
                ZStack {
                    if hasNewMessagesBelow && !isDetailScrolledNearBottom {
                        Button {
                            isFollowingLatest = true
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
    }

    private func appKitDetailMessages(
        displayEntries: [ChatDisplayEntry],
        hiddenCount: Int
    ) -> some View {
        let rows = cachedAppKitRows.count == displayEntries.count
            ? cachedAppKitRows
            : displayEntries.map { appKitRow($0) }
        return VStack(alignment: .leading, spacing: 6) {
            if hiddenCount > 0 {
                Button {
                    isFollowingLatest = false
                    ChatPerformanceRecorder.shared.increment(.historyPrepends)
                    ChatPerformanceTrace.event("timeline.history.prepend", value: min(100, hiddenCount))
                    visibleMessageLimit += 100
                    if let currentDetail = backendClient.selectedDetail {
                        updateCachedDisplayEntries(for: currentDetail)
                    }
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

            AppKitChatTimelineView(
                rows: rows,
                scrollToBottomRevision: appKitScrollToBottomRevision,
                usesNativeText: effectiveRenderer == .appKitNativeText,
                followsLatest: $isFollowingLatest,
                onToggleExpansion: toggleNativeProcessExpansion
            )
            .onAppear {
                if let currentDetail = backendClient.selectedDetail {
                    updateCachedDisplayEntries(for: currentDetail)
                }
            }
            .onChange(of: appKitDetailRevision) { _, _ in
                if let currentDetail = backendClient.selectedDetail {
                    updateCachedDisplayEntries(for: currentDetail)
                }
                if !isFollowingLatest {
                    hasNewMessagesBelow = true
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if hasNewMessagesBelow {
                    Button {
                        isFollowingLatest = true
                        hasNewMessagesBelow = false
                        appKitScrollToBottomRevision &+= 1
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 12, weight: .bold))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(IconButtonStyle())
                    .help(L10n("Jump to latest message"))
                    .padding(10)
                }
            }
        }
    }

    private var appKitDetailRevision: String {
        guard let detail = backendClient.selectedDetail else { return "none" }
        return detailSourceSignature(for: detail)
    }

    private func appKitRow(
        _ entry: ChatDisplayEntry,
        expansionSnapshot: Set<String>? = nil
    ) -> AppKitChatTimelineRow {
        let expandedTurnIds = expansionSnapshot ?? expandedProcessTurnIds
        if effectiveRenderer == .appKitNativeText {
            return nativeAppKitRow(entry, expandedTurnIds: expandedTurnIds)
        }
        let content = swiftUIAppKitContent(for: entry, expandedTurnIds: expandedTurnIds)
        let expansion = processExpansionMetadata(for: entry, expandedTurnIds: expandedTurnIds)
        return AppKitChatTimelineRow(
            id: entry.id,
            contentRevision: appKitContentRevision(entry, expandedTurnIds: expandedTurnIds),
            content: content,
            nativeText: "",
            copyText: "",
            nativeStyle: .agent,
            title: "",
            metadata: "",
            expandableTurnId: expansion.turnId,
            isExpanded: expansion.isExpanded
        )
    }

    private func swiftUIAppKitContent(
        for entry: ChatDisplayEntry,
        expandedTurnIds: Set<String>
    ) -> AnyView {
        switch entry.kind {
        case .message(let item):
            return AnyView(
                ThreadItemView(
                    item: item,
                    isCollaborationExpanded: collaborationExpansionBinding(for: item),
                    isCollaborationConfirmationExpanded: collaborationConfirmationExpansionBinding(for: item)
                )
                .environmentObject(backendClient)
            )
        case .process(let turnId, let items):
            let isExpanded = expandedTurnIds.contains(turnId)
            return AnyView(
                ThreadProcessGroupView(
                    items: items,
                    isExpanded: isExpanded,
                    onToggle: {
                        setProcessExpansion(!isExpanded, for: turnId)
                    }
                )
                .environmentObject(backendClient)
            )
        }
    }

    private func nativeAppKitRow(
        _ entry: ChatDisplayEntry,
        expandedTurnIds: Set<String>
    ) -> AppKitChatTimelineRow {
        let isExpandedProcessEntry: Bool = switch entry.kind {
        case .process(let turnId, _): expandedTurnIds.contains(turnId)
        case .message: false
        }
        if shouldUseSwiftUIHosting(for: entry) || isExpandedProcessEntry {
            let expansion = processExpansionMetadata(for: entry, expandedTurnIds: expandedTurnIds)
            return AppKitChatTimelineRow(
                id: entry.id,
                contentRevision: appKitContentRevision(entry, expandedTurnIds: expandedTurnIds),
                content: swiftUIAppKitContent(for: entry, expandedTurnIds: expandedTurnIds),
                nativeText: "",
                copyText: "",
                nativeStyle: .agent,
                title: "",
                metadata: "",
                expandableTurnId: expansion.turnId,
                isExpanded: expansion.isExpanded
            )
        }
        let text: String
        let copyText: String
        let style: AppKitChatTimelineRow.NativeStyle
        let title: String
        let metadata: String
        let expandableTurnId: String?
        let isExpanded: Bool
        var processCount: Int?
        var processDuration: String?
        switch entry.kind {
        case .message(let item):
            style = item.type == "userMessage" ? .user : .agent
            copyText = nativeTimelineText(for: item)
            text = ClickableMessageText.markdown(
                from: copyText,
                baseDirectory: backendClient.selectedDetail?.cwd
            )
            title = item.title
            metadata = nativeTimelineMetadata(for: item)
            expandableTurnId = nil
            isExpanded = false
            processCount = nil
            processDuration = nil
        case .process(let turnId, let items):
            let expanded = expandedTurnIds.contains(turnId)
            copyText = items.map { nativeTimelineText(for: $0) }.joined(separator: "\n")
            text = ""
            style = .process
            title = ""
            metadata = ""
            expandableTurnId = turnId
            isExpanded = expanded
            processCount = items.count
            processDuration = nativeProcessDuration(for: items)
        }
        return AppKitChatTimelineRow(
            id: entry.id,
            contentRevision: appKitContentRevision(entry, expandedTurnIds: expandedTurnIds),
            content: nil,
            nativeText: text,
            copyText: copyText,
            nativeStyle: style,
            title: title,
            metadata: metadata,
            expandableTurnId: expandableTurnId,
            isExpanded: isExpanded,
            processCount: processCount,
            processDuration: processDuration
        )
    }

    private func nativeProcessDuration(for items: [CodexThreadItem]) -> String? {
        let timestamps = items.compactMap { item in
            item.createdAt.flatMap(ISO8601DateFormatter.corptieThreadItemDate(from:))
        }
        guard let start = timestamps.min(), let end = timestamps.max() else { return nil }
        let duration = max(0, end.timeIntervalSince(start))
        if duration < 0.95 { return "· <1s" }
        if duration < 10 { return String(format: "· %.1fs", duration) }
        return "· \(Int(duration.rounded()))s"
    }

    private func processExpansionMetadata(
        for entry: ChatDisplayEntry,
        expandedTurnIds: Set<String>
    ) -> (turnId: String?, isExpanded: Bool) {
        switch entry.kind {
        case .process(let turnId, _):
            return (turnId, expandedTurnIds.contains(turnId))
        case .message:
            return (nil, false)
        }
    }

    private func toggleNativeProcessExpansion(_ turnId: String) {
        if effectiveRenderer == .swiftUIVStack {
            withAnimation(.easeOut(duration: 0.14)) {
                setProcessExpansion(!expandedProcessTurnIds.contains(turnId), for: turnId)
            }
        } else {
            // AppKit owns the row geometry. Running a SwiftUI transition around
            // the same change gives the hosted content and NSTableView different
            // animation clocks, which causes flashing and transient overlap.
            setProcessExpansion(!expandedProcessTurnIds.contains(turnId), for: turnId)
        }
    }

    private func nativeTimelineMetadata(for item: CodexThreadItem) -> String {
        guard let createdAt = item.createdAt,
              let date = ISO8601DateFormatter.corptieThreadItemDate(from: createdAt) else { return "" }
        return date.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour().minute())
    }

    private func shouldUseSwiftUIHosting(for entry: ChatDisplayEntry) -> Bool {
        ChatTimelineRowRouting.route(for: entry) == .swiftUI
    }

    private func nativeTimelineText(for item: CodexThreadItem) -> String {
        ChatTimelineRowRouting.displayText(for: item)
    }

    private func appKitContentRevision(
        _ entry: ChatDisplayEntry,
        expandedTurnIds: Set<String>
    ) -> Int {
        var hasher = Hasher()
        hasher.combine(entry.id)
        switch entry.kind {
        case .message(let item):
            hasher.combine(itemSignature(item))
        case .process(let turnId, let items):
            hasher.combine(turnId)
            hasher.combine(expandedTurnIds.contains(turnId))
            if expandedTurnIds.contains(turnId) {
                items.forEach { hasher.combine(itemSignature($0)) }
            }
        }
        return hasher.finalize()
    }

    private func restoreHistoryScrollAnchor(
        _ anchor: DetailHistoryScrollAnchor?,
        proxy: ScrollViewProxy
    ) {
        guard let anchor else { return }
        Task { @MainActor in
            // Let the prepended rows complete layout before restoring the old
            // visible entry. A second pass covers variable-height Markdown
            // cards whose final size settles one layout turn later.
            await Task.yield()
            proxy.scrollTo(
                anchor.entryId,
                anchor: .top
            )
            await Task.yield()
            proxy.scrollTo(
                anchor.entryId,
                anchor: .top
            )
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

    private func setProcessExpansion(_ isExpanded: Bool, for turnId: String) {
        let wasExpanded = expandedProcessTurnIds.contains(turnId)
        guard wasExpanded != isExpanded else { return }
        var nextExpandedTurnIds = expandedProcessTurnIds
        if isExpanded {
            nextExpandedTurnIds.insert(turnId)
        } else {
            nextExpandedTurnIds.remove(turnId)
        }
        expandedProcessTurnIds = nextExpandedTurnIds

        // AppKit rows are independent NSHostingView roots. Parent state changes
        // do not invalidate a cached root by themselves, so rebuild rows with a
        // new content revision and let NSTableView remeasure the changed height.
        if effectiveRenderer != .swiftUIVStack {
            cachedAppKitRows = cachedDisplayEntries.map {
                appKitRow($0, expansionSnapshot: nextExpandedTurnIds)
            }
        }
    }

    private func updateCachedDisplayEntries(for detail: CodexThreadDetail) {
        let sourceSignature = detailSourceSignature(for: detail)
        guard cachedSessionId != sessionId || sourceSignature != cachedDetailSourceSignature else {
            return
        }
        let preparedDisplay = ChatPerformanceTrace.measure("timeline.display.diff") {
            if ChatTimelineFeatureFlags.current.deltaTimelineEnabled,
               let incremental = makeIncrementalTailDisplay(for: detail) {
                incremental
            } else {
                makeVisibleDetailDisplay(for: detail, visibleMessageLimit: visibleMessageLimit)
            }
        }
        ChatPerformanceRecorder.shared.increment(.displayRebuilds)
        let addsMainCard = preparedDisplay.totalCount > cachedTotalDisplayEntryCount
        let oldExpandedProcessCounts = expandedProcessItemCounts(in: cachedDisplayEntries)
        let newExpandedProcessCounts = expandedProcessItemCounts(in: preparedDisplay.visibleEntries)
        let addsExpandedProcessCard = newExpandedProcessCounts.contains { turnId, count in
            count > (oldExpandedProcessCounts[turnId] ?? 0)
        }
        let addsVisibleCard = cachedSessionId == sessionId
            && (addsMainCard || addsExpandedProcessCard)
        // Moving a newly inserted row in from the bottom animates the entire
        // VStack layout and can shift the viewport even without an explicit
        // scrollTo. While the user is reading history, update the list in a
        // non-animated transaction so the currently visible content stays put.
        let animateInsertion = addsVisibleCard
            && isFollowingLatest
            && isDetailScrolledNearBottom
        var transaction = Transaction(animation: animateInsertion ? .easeOut(duration: 0.22) : nil)
        transaction.disablesAnimations = !animateInsertion
        let nextAppKitRows = makeCachedAppKitRows(
            previousEntries: cachedDisplayEntries,
            previousRows: cachedAppKitRows,
            nextEntries: preparedDisplay.visibleEntries
        )
        withTransaction(transaction) {
            cachedDetailSourceSignature = sourceSignature
            cachedItemsSignature = preparedDisplay.signature
            cachedSessionId = sessionId
            updateCachedSourceTail(from: preparedDisplay.displayItems)
            cachedTotalDisplayEntryCount = preparedDisplay.totalCount
            cachedVisibleMessageLimit = visibleMessageLimit
            cachedDisplayEntries = preparedDisplay.visibleEntries
            cachedAppKitRows = nextAppKitRows
            displayCacheBySessionId[sessionId] = DetailDisplayCache(
                sessionId: sessionId,
                displayItems: preparedDisplay.displayItems,
                displayEntries: preparedDisplay.visibleEntries,
                totalDisplayEntryCount: preparedDisplay.totalCount,
                visibleMessageLimit: visibleMessageLimit,
                signature: preparedDisplay.signature,
                sourceSignature: sourceSignature
            )
        }
    }

    private func makeCachedAppKitRows(
        previousEntries: [ChatDisplayEntry],
        previousRows: [AppKitChatTimelineRow],
        nextEntries: [ChatDisplayEntry]
    ) -> [AppKitChatTimelineRow] {
        guard effectiveRenderer != .swiftUIVStack else { return [] }
        guard ChatTimelineFeatureFlags.current.deltaTimelineEnabled,
              previousEntries.count == previousRows.count,
              let nextTailTurnId = nextEntries.last.map(chatDisplayEntryTurnId),
              let nextTailStart = nextEntries.firstIndex(where: { chatDisplayEntryTurnId($0) == nextTailTurnId }),
              let previousTailStart = previousEntries.firstIndex(where: { chatDisplayEntryTurnId($0) == nextTailTurnId }),
              nextTailStart == previousTailStart,
              zip(nextEntries[..<nextTailStart], previousEntries[..<previousTailStart]).allSatisfy({ next, previous in
                  next.id == previous.id
              }) else {
            return nextEntries.map { appKitRow($0) }
        }
        return Array(previousRows[..<previousTailStart]) + nextEntries[nextTailStart...].map { appKitRow($0) }
    }

    private func makeIncrementalTailDisplay(
        for detail: CodexThreadDetail
    ) -> (displayItems: [CodexThreadItem], visibleEntries: [ChatDisplayEntry], totalCount: Int, signature: String, sourceSignature: String)? {
        guard cachedSessionId == sessionId,
              DetailTimelineIncrementalEligibility.canReuseCachedWindow(
                cachedVisibleMessageLimit: cachedVisibleMessageLimit,
                requestedVisibleMessageLimit: visibleMessageLimit
              ),
              detail.items.count == cachedSourceItemCount,
              let nextLast = detail.items.last,
              let cachedLast = cachedSourceTailItem,
              nextLast.id == cachedLast.id,
              nextLast.turnId == cachedLast.turnId,
              detail.items.dropLast().last?.id == cachedSourcePenultimateItemId else {
            return nil
        }

        let tailItems = detail.items.reversed().prefix { $0.turnId == nextLast.turnId }.reversed()
        let nextTailEntries = makeChatDisplayEntriesForTurn(Array(tailItems))
        guard let oldTailStart = cachedDisplayEntries.firstIndex(where: {
            chatDisplayEntryTurnId($0) == nextLast.turnId
        }) else {
            return nil
        }
        let oldTailEntries = cachedDisplayEntries[oldTailStart...]
        guard oldTailEntries.allSatisfy({ chatDisplayEntryTurnId($0) == nextLast.turnId }) else {
            return nil
        }

        let oldTailWeight = oldTailEntries.reduce(0) { $0 + $1.displayWeight }
        let nextTailWeight = nextTailEntries.reduce(0) { $0 + $1.displayWeight }
        let combined = Array(cachedDisplayEntries[..<oldTailStart]) + nextTailEntries
        let visibleEntries = visibleDetailEntries(from: combined, limit: visibleMessageLimit)
        let totalCount = max(0, cachedTotalDisplayEntryCount - oldTailWeight + nextTailWeight)
        return (
            displayItems: detail.items,
            visibleEntries: visibleEntries,
            totalCount: totalCount,
            signature: incrementalDisplaySignature(
                previousSignature: cachedItemsSignature,
                tailEntries: nextTailEntries
            ),
            sourceSignature: detailSourceSignature(for: detail)
        )
    }

    private func updateCachedSourceTail(from items: [CodexThreadItem]) {
        cachedSourceItemCount = items.count
        cachedSourcePenultimateItemId = items.dropLast().last?.id
        cachedSourceTailItem = items.last
    }

    private func incrementalDisplaySignature(
        previousSignature: String,
        tailEntries: [ChatDisplayEntry]
    ) -> String {
        let tailSignature = tailEntries.map { entry in
            switch entry.kind {
            case .message(let item): return detailItemSignature(item)
            case .process(let turnId, let items):
                return turnId + ":" + items.suffix(1).map(detailItemSignature).joined()
            }
        }.joined(separator: "|")
        return "\(previousSignature.hashValue):\(tailSignature)"
    }

    private var shouldRenderDetailMessages: Bool {
        if hasPreparedDisplayCacheForCurrentSession || hasPreheatedDisplayCacheForCurrentSession {
            return true
        }
        return panelLayoutState.canRenderDetailMessages
    }

    private func preparedDisplayEntries(for detail: CodexThreadDetail) -> (visibleEntries: [ChatDisplayEntry], totalCount: Int) {
        // Once a session has a display cache, render that cache until the
        // controlled update path replaces it with the intended transaction.
        // Recomputing directly from a newer detail here bypasses animation
        // suppression for folded process-only updates.
        if hasPreparedDisplayCacheForCurrentSession {
            return (cachedDisplayEntries, cachedTotalDisplayEntryCount)
        }
        if let preheatedDisplayCache, preheatedDisplayCache.sessionId == sessionId {
            return (preheatedDisplayCache.displayEntries, preheatedDisplayCache.totalDisplayEntryCount)
        }
        let preparedDisplay = makeVisibleDetailDisplay(for: detail, visibleMessageLimit: visibleMessageLimit)
        return (preparedDisplay.visibleEntries, preparedDisplay.totalCount)
    }

    private var hasPreparedDisplayCacheForCurrentSession: Bool {
        cachedSessionId == sessionId
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
        updateCachedSourceTail(from: preheatedDisplayCache.displayItems)
        cachedDisplayEntries = preheatedDisplayCache.displayEntries
        cachedAppKitRows = preheatedDisplayCache.displayEntries.map { appKitRow($0) }
        cachedTotalDisplayEntryCount = preheatedDisplayCache.totalDisplayEntryCount
        cachedVisibleMessageLimit = preheatedDisplayCache.visibleMessageLimit
        cachedItemsSignature = preheatedDisplayCache.signature
        cachedDetailSourceSignature = preheatedDisplayCache.sourceSignature
        displayCacheBySessionId[sessionId] = preheatedDisplayCache
    }

    private func restoreDisplayCacheForCurrentSession() {
        if let cache = displayCacheBySessionId[sessionId] {
            cachedSessionId = sessionId
            updateCachedSourceTail(from: cache.displayItems)
            cachedDisplayEntries = cache.displayEntries
            cachedAppKitRows = cache.displayEntries.map { appKitRow($0) }
            cachedTotalDisplayEntryCount = cache.totalDisplayEntryCount
            cachedVisibleMessageLimit = cache.visibleMessageLimit
            cachedItemsSignature = cache.signature
            cachedDetailSourceSignature = cache.sourceSignature
            return
        }
        cachedSessionId = ""
        cachedSourceItemCount = 0
        cachedSourcePenultimateItemId = nil
        cachedSourceTailItem = nil
        cachedDisplayEntries = []
        cachedAppKitRows = []
        cachedTotalDisplayEntryCount = 0
        cachedVisibleMessageLimit = 0
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
            case .process(let turnId, let items):
                return turnId + ":" + items.map(itemSignature).joined(separator: ",")
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
        if force {
            isFollowingLatest = true
        }
        guard force || isFollowingLatest else {
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

    private func maintainLatestPositionAfterIncomingContent(
        detail: CodexThreadDetail,
        proxy: ScrollViewProxy
    ) {
        guard isFollowingLatest else {
            hasNewMessagesBelow = true
            return
        }

        pendingFollowScrollWorkItem?.cancel()
        isMaintainingFollowPosition = true
        scrollToLatestAfterLayout(detail: detail, proxy: proxy)

        // Card insertion runs for 0.22 seconds. Scroll once more after that
        // layout settles so the old bottom cannot become the new viewport top.
        let workItem = DispatchWorkItem {
            guard backendClient.selectedSession?.id == sessionId else {
                return
            }
            isMaintainingFollowPosition = false
            guard isFollowingLatest else {
                return
            }
            scrollToLatestAfterLayout(detail: detail, proxy: proxy)
            pendingFollowScrollWorkItem = nil
        }
        pendingFollowScrollWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.24, execute: workItem)
    }

    private func maintainLatestPositionIfVisibleContentChanged(
        detail: CodexThreadDetail,
        proxy: ScrollViewProxy
    ) {
        let signature = visibleContentSignature(for: cachedDisplayEntries)
        guard signature != lastVisibleContentSignature else {
            if pendingFollowScrollWorkItem == nil {
                isMaintainingFollowPosition = false
            }
            return
        }
        lastVisibleContentSignature = signature
        maintainLatestPositionAfterIncomingContent(detail: detail, proxy: proxy)
    }

    private func visibleContentSignature(for entries: [ChatDisplayEntry]) -> String {
        entries.map { entry in
            switch entry.kind {
            case .message(let item):
                return "message:" + itemSignature(item)
            case .process(let turnId, let items):
                // A collapsed process row has fixed height. Its count, duration,
                // and hidden items can update without changing visible layout.
                guard expandedProcessTurnIds.contains(turnId) else {
                    return "process:\(turnId)"
                }
                return "process:\(turnId):" + items.map(itemSignature).joined(separator: ",")
            }
        }.joined(separator: "|")
    }

    private func expandedProcessItemCounts(in entries: [ChatDisplayEntry]) -> [String: Int] {
        var counts: [String: Int] = [:]
        for entry in entries {
            let processGroup: (turnId: String, items: [CodexThreadItem])?
            switch entry.kind {
            case .process(let turnId, let items):
                processGroup = (turnId, items)
            case .message:
                processGroup = nil
            }
            guard let processGroup,
                  expandedProcessTurnIds.contains(processGroup.turnId) else {
                continue
            }
            counts[processGroup.turnId] = processGroup.items.count
        }
        return counts
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
        let isNearBottom = bottomDistance <= 8
        isDetailScrolledNearBottom = isNearBottom

        let currentEvent = NSApp.currentEvent
        let isUserScrollEvent = currentEvent?.type == .scrollWheel || NSEvent.pressedMouseButtons != 0
        if isUserScrollEvent {
            isFollowingLatest = isNearBottom
            if !isNearBottom {
                pendingFollowScrollWorkItem?.cancel()
                pendingFollowScrollWorkItem = nil
                isMaintainingFollowPosition = false
            }
        } else if !isMaintainingFollowPosition {
            isFollowingLatest = isNearBottom
        }
        if isNearBottom {
            hasNewMessagesBelow = false
        }
    }

    private func visibleEntries(from displayEntries: [ChatDisplayEntry]) -> [ChatDisplayEntry] {
        guard displayEntries.reduce(0, { $0 + $1.displayWeight }) > visibleMessageLimit else {
            return displayEntries
        }
        return visibleDetailEntries(from: displayEntries, limit: visibleMessageLimit)
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

}

private struct OrphanedWorkspaceRecoveryView: View {
    @EnvironmentObject private var backendClient: BackendClient
    let status: WorkspaceRecoveryStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "folder.badge.questionmark")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(.red)
                VStack(alignment: .leading, spacing: 3) {
                    Text(L10n("Workspace missing"))
                        .font(.system(size: 13, weight: .bold))
                    Text(L10n("This session is preserved, but Agent work is blocked until the workspace is restored or switched."))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    if let path = status.originalPath {
                        Text(path)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(CorptiePalette.mutedText)
                            .textSelection(.enabled)
                    }
                }
                Spacer()
                if backendClient.isRecoveringWorkspace {
                    ProgressView().controlSize(.small)
                }
            }

            HStack(spacing: 8) {
                if status.canRebuild == true {
                    Button(L10n("Rebuild Original Worktree")) {
                        backendClient.recoverSelectedWorkspace(action: "rebuild")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(backendClient.isRecoveringWorkspace)
                }

                Menu(L10n("Switch Workspace")) {
                    ForEach(status.worktrees) { worktree in
                        Button(worktree.isMain
                            ? L10nFormat("Main — %@", worktree.path)
                            : L10nFormat("%@ — %@", worktree.branchName ?? L10n("detached HEAD"), worktree.path)) {
                            backendClient.recoverSelectedWorkspace(
                                action: "switch",
                                targetWorktreeId: worktree.worktreeId
                            )
                        }
                    }
                }
                .controlSize(.small)
                .disabled(status.worktrees.isEmpty || backendClient.isRecoveringWorkspace)

                Spacer()

                if let session = backendClient.selectedSession {
                    Button(L10n("Delete Session Only"), role: .destructive) {
                        backendClient.delete(session: session)
                    }
                    .controlSize(.small)
                    .disabled(backendClient.isRecoveringWorkspace)
                }
            }

            if let error = backendClient.lastError {
                Text(error)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .padding(12)
        .background(Color.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.red.opacity(0.22), lineWidth: 0.75)
        )
    }
}

private struct ChatUsageBar: View {
    let usage: SessionUsageResponse?
    @State private var isResetNoticePresented = false
    @State private var resetNoticePresentationTask: Task<Void, Never>?

    var body: some View {
        if let usage {
            HStack(alignment: .center, spacing: 10) {
                if let context = usage.context,
                   let remaining = context.remainingTokens,
                   let window = context.contextWindow {
                    let used = context.usedTokens ?? max(0, window - remaining)
                    let usedPercent = context.usedPercent ?? max(0, min(100, used / window * 100))
                    usageItem(
                        icon: "text.alignleft",
                        value: "\(exactTokens(used))/\(exactTokens(window))",
                        progress: usedPercent / 100,
                        color: contextColor(usedPercent: usedPercent),
                        help: "\(L10n("Context")): \(exactTokens(used)) / \(exactTokens(window)) · \(formatPercent(usedPercent, maximumFractionDigits: 2))% used",
                        numericValue: used
                    )
                }
                if let window = preferredRateLimitWindow(usage.account) {
                    let remainingPercent = max(0, 100 - (window.usedPercent ?? 0))
                    if usage.account.provider == "codex" {
                        Button {
                            presentResetNoticeManually()
                        } label: {
                            usageItem(
                                icon: "bolt.fill",
                                value: "\(formatPercent(remainingPercent))%",
                                progress: remainingPercent / 100,
                                color: quotaColor(remainingPercent: remainingPercent),
                                help: "\(providerQuotaLabel(usage.account.provider)): \(formatPercent(remainingPercent, maximumFractionDigits: 2))% remaining"
                            )
                        }
                        .buttonStyle(.plain)
                        .popover(isPresented: $isResetNoticePresented, arrowEdge: .bottom) {
                            resetNoticePopover(usage: usage, window: window)
                        }
                    } else {
                        usageItem(
                            icon: "bolt.fill",
                            value: "\(formatPercent(remainingPercent))%",
                            progress: remainingPercent / 100,
                            color: quotaColor(remainingPercent: remainingPercent),
                            help: "\(providerQuotaLabel(usage.account.provider)): \(formatPercent(remainingPercent, maximumFractionDigits: 2))% remaining"
                        )
                    }
                }
            }
            .font(.system(size: 9, weight: .semibold))
            .fixedSize(horizontal: true, vertical: false)
            .onAppear {
                scheduleResetNoticeIfNeeded(usage)
            }
            .onChange(of: resetNoticeFingerprint(usage)) { _, _ in
                scheduleResetNoticeIfNeeded(usage)
            }
            .onChange(of: isResetNoticePresented) { _, presented in
                guard !presented,
                      let fingerprint = resetNoticeFingerprint(usage),
                      CodexResetNoticePresentation.shouldPresent(
                          fingerprint: fingerprint,
                          acknowledgedFingerprints: resetNoticeAcknowledgements
                      ) else { return }
                scheduleResetNoticePresentation(
                    after: CodexResetNoticePresentation.rearmDelay,
                    requiredFingerprint: fingerprint
                )
            }
            .onDisappear {
                resetNoticePresentationTask?.cancel()
                resetNoticePresentationTask = nil
            }
        }
    }

    @ViewBuilder
    private func resetNoticePopover(
        usage: SessionUsageResponse,
        window: CodexRateLimitWindow
    ) -> some View {
        let requiresAcknowledgement = resetNoticeRequiresAcknowledgement(usage)
        VStack(alignment: .leading, spacing: 7) {
            Label(
                L10nFormat("Plan reset: %@", formattedResetDate(window.resetsAt)),
                systemImage: "clock"
            )
            .lineLimit(1)

            if let forecast = usage.resetForecast?.forecast {
                Button {
                    openResetForecast(forecast)
                } label: {
                    Label(
                        L10nFormat("Tibo forecast: %@", forecast.estimateLabel),
                        systemImage: "bubble.left"
                    )
                    .lineLimit(1)
                }
                .buttonStyle(.plain)
                .help(forecast.text)
            } else {
                Label(
                    L10n("Tibo forecast: No upcoming reset announcement"),
                    systemImage: "bubble.left"
                )
                .lineLimit(1)
            }

            if requiresAcknowledgement {
                HStack {
                    Spacer()
                    Button(L10n("Confirm")) {
                        acknowledgeResetNotice(usage)
                    }
                    .controlSize(.mini)
                    .keyboardShortcut(.defaultAction)
                }
            }
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(CorptiePalette.primaryText)
        .padding(10)
        .frame(width: 280)
    }

    private func scheduleResetNoticeIfNeeded(_ usage: SessionUsageResponse?) {
        guard let fingerprint = resetNoticeFingerprint(usage),
              CodexResetNoticePresentation.shouldPresent(
                  fingerprint: fingerprint,
                  acknowledgedFingerprints: resetNoticeAcknowledgements
              ) else { return }
        scheduleResetNoticePresentation(
            after: CodexResetNoticePresentation.automaticPresentationDelay,
            requiredFingerprint: fingerprint
        )
    }

    private func presentResetNoticeManually() {
        resetNoticePresentationTask?.cancel()
        resetNoticePresentationTask = nil
        switch CodexResetNoticePresentation.manualAction(isPresented: isResetNoticePresented) {
        case .present:
            isResetNoticePresented = true
        case .rearm:
            // SwiftUI can leave the binding true when a popover was requested
            // during the detail view's opening transition but AppKit could not
            // attach it. Toggle the binding before presenting it again.
            isResetNoticePresented = false
            scheduleResetNoticePresentation(
                after: CodexResetNoticePresentation.rearmDelay
            )
        }
    }

    private func scheduleResetNoticePresentation(
        after delay: Duration,
        requiredFingerprint: String? = nil
    ) {
        resetNoticePresentationTask?.cancel()
        resetNoticePresentationTask = Task { @MainActor in
            do {
                try await Task.sleep(for: delay)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            if let requiredFingerprint {
                guard CodexResetNoticePresentation.shouldPresent(
                    fingerprint: requiredFingerprint,
                    acknowledgedFingerprints: resetNoticeAcknowledgements
                ) else {
                    resetNoticePresentationTask = nil
                    return
                }
            }
            isResetNoticePresented = true
            resetNoticePresentationTask = nil
        }
    }

    private func resetNoticeRequiresAcknowledgement(_ usage: SessionUsageResponse?) -> Bool {
        guard let fingerprint = resetNoticeFingerprint(usage) else { return false }
        return CodexResetNoticePresentation.shouldPresent(
            fingerprint: fingerprint,
            acknowledgedFingerprints: resetNoticeAcknowledgements
        )
    }

    private func resetNoticeFingerprint(_ usage: SessionUsageResponse?) -> String? {
        guard let usage else { return nil }
        return CodexResetNoticeIdentity.fingerprint(
            provider: usage.account.provider,
            window: preferredRateLimitWindow(usage.account),
            forecast: usage.resetForecast?.forecast
        )
    }

    private func acknowledgeResetNotice(_ usage: SessionUsageResponse) {
        guard let fingerprint = resetNoticeFingerprint(usage) else { return }
        resetNoticePresentationTask?.cancel()
        resetNoticePresentationTask = nil
        CodexResetNoticeAcknowledgements.record(fingerprint)
        isResetNoticePresented = false
    }

    private var resetNoticeAcknowledgements: [String] {
        CodexResetNoticeAcknowledgements.load()
    }

    private func formattedResetDate(_ epochSeconds: Double?) -> String {
        guard let epochSeconds else { return L10n("Unknown") }
        return Date(timeIntervalSince1970: epochSeconds).formatted(
            date: .abbreviated,
            time: .shortened
        )
    }

    private func openResetForecast(_ forecast: CodexResetForecast) {
        guard let value = forecast.url, let url = URL(string: value) else { return }
        NSWorkspace.shared.open(url)
    }

    private func usageItem(icon: String, value: String, progress: Double, color: Color, help: String, numericValue: Double? = nil) -> some View {
        HStack(spacing: 4) {
            UsageProgressRing(icon: icon, progress: progress, color: color)
            Text(value)
                .foregroundStyle(color)
                .monospacedDigit()
                .contentTransition(.numericText(value: numericValue ?? progress))
                .animation(.snappy(duration: 0.45), value: numericValue ?? progress)
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

    private func providerQuotaLabel(_ provider: String?) -> String {
        provider == "claude" ? L10n("Claude quota") : L10n("Codex quota")
    }

    private func exactTokens(_ value: Double) -> String {
        value.formatted(.number.grouping(.automatic).precision(.fractionLength(0)))
    }

    private func formatPercent(_ value: Double, maximumFractionDigits: Int = 1) -> String {
        value.formatted(.number.grouping(.never).precision(.fractionLength(0...maximumFractionDigits)))
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

struct ChatDisplayEntry: Identifiable {
    enum Kind {
        case message(CodexThreadItem)
        case process(turnId: String, items: [CodexThreadItem])
    }

    let kind: Kind

    var id: String {
        switch kind {
        case .message(let item):
            return "message:\(item.id)"
        case .process(let turnId, _):
            return "process:\(turnId)"
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

    var displayWeight: Int {
        1
    }
}

struct DetailDisplayCache {
    let sessionId: String
    let displayItems: [CodexThreadItem]
    let displayEntries: [ChatDisplayEntry]
    let totalDisplayEntryCount: Int
    let visibleMessageLimit: Int
    let signature: String
    let sourceSignature: String
}

private func chatDisplayEntryTurnId(_ entry: ChatDisplayEntry) -> String {
    switch entry.kind {
    case .message(let item): item.turnId
    case .process(let turnId, _): turnId
    }
}

@MainActor
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
        visibleMessageLimit: visibleMessageLimit,
        signature: preparedDisplay.signature,
        sourceSignature: preparedDisplay.sourceSignature
    )
}

@MainActor
private func makeVisibleDetailDisplay(
    for detail: CodexThreadDetail,
    visibleMessageLimit: Int
) -> (displayItems: [CodexThreadItem], visibleEntries: [ChatDisplayEntry], totalCount: Int, signature: String, sourceSignature: String) {
    let displayItems = detail.items
        .filter { !isLowSignalDetailProcessItem($0) }
    let displayEntries = makeChatDisplayEntries(from: displayItems)
    let visibleEntries = visibleDetailEntries(from: displayEntries, limit: visibleMessageLimit)
    return (
        displayItems: displayItems,
        visibleEntries: visibleEntries,
        totalCount: displayEntries.reduce(0) { $0 + $1.displayWeight },
        signature: detailDisplaySignature(for: visibleEntries, visibleMessageLimit: visibleMessageLimit),
        sourceSignature: makeDetailSourceSignature(for: detail, visibleMessageLimit: visibleMessageLimit)
    )
}

@MainActor
private func makeDetailSourceSignature(for detail: CodexThreadDetail, visibleMessageLimit: Int) -> String {
    let signatureItemLimit = ChatTimelineFeatureFlags.current.deltaTimelineEnabled
        ? 2
        : max(visibleMessageLimit * 4, visibleMessageLimit + 8)
    let items = detail.items.suffix(signatureItemLimit)
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

func visibleDetailEntries(from displayEntries: [ChatDisplayEntry], limit: Int) -> [ChatDisplayEntry] {
    guard displayEntries.reduce(0, { $0 + $1.displayWeight }) > limit else {
        return displayEntries
    }
    var remainingWeight = limit
    var startIndex = displayEntries.endIndex
    while startIndex > displayEntries.startIndex {
        let candidateIndex = displayEntries.index(before: startIndex)
        let candidateWeight = displayEntries[candidateIndex].displayWeight
        remainingWeight -= candidateWeight
        startIndex = candidateIndex
        if remainingWeight <= 0 {
            break
        }
    }
    return Array(displayEntries[startIndex...])
}

func makeChatDisplayEntries(from items: [CodexThreadItem]) -> [ChatDisplayEntry] {
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

func makeChatDisplayEntriesForTurn(_ items: [CodexThreadItem]) -> [ChatDisplayEntry] {
    let userMessages = items.filter { $0.type == "userMessage" }
    if let confirmation = items.last(where: { $0.type == "collaborationConfirmation" }) {
        return userMessages.map { ChatDisplayEntry(kind: .message($0)) }
            + [ChatDisplayEntry(kind: .message(confirmation))]
    }
    let agentMessages = items.filter {
        $0.type == "agentMessage" && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    let presentedAgentMessage = preferredPresentedAgentMessage(from: agentMessages)
    let progressAgentMessages = agentMessages.filter { $0.id != presentedAgentMessage?.id }
    let progressAgentMessageIds = Set(progressAgentMessages.map(\.id))
    let processItems = items.filter { item in
        isDetailProcessItem(item) || progressAgentMessageIds.contains(item.id)
    }
    let trailingItems = items.filter { item in
        item.type != "userMessage" && item.type != "agentMessage" && !isDetailProcessItem(item)
    }

    var entries = userMessages.map { ChatDisplayEntry(kind: .message($0)) }
    if shouldShowProcessGroup(items: items, userMessages: userMessages, processItems: processItems),
       let turnId = items.first?.turnId {
        // Keep execution lifecycle independent from the user's authored message.
        // The process row owns its disclosure state and remains a separate bubble
        // even for the common one-message turn.
        entries.append(ChatDisplayEntry(kind: .process(turnId: turnId, items: processItems)))
    }
    if let presentedAgentMessage {
        entries.append(ChatDisplayEntry(kind: .message(presentedAgentMessage)))
    }
    entries.append(contentsOf: trailingItems.map { ChatDisplayEntry(kind: .message($0)) })
    return entries
}

private func preferredPresentedAgentMessage(from messages: [CodexThreadItem]) -> CodexThreadItem? {
    if let finalAnswer = messages.last(where: {
        $0.presentationRole?.lowercased() == "final_answer"
    }) {
        return finalAnswer
    }

    // Commentary and other explicitly phased messages are execution progress,
    // even after a turn ends. Only use the historical fallback for old items
    // that predate Codex's phase field, and never while their turn is active.
    guard let legacyMessage = messages.last,
          legacyMessage.presentationRole?.isEmpty != false,
          isTerminalTurnStatus(legacyMessage.turnStatus) else {
        return nil
    }
    return legacyMessage
}

private func isTerminalTurnStatus(_ status: String) -> Bool {
    switch status.lowercased() {
    case "completed", "complete", "failed", "cancelled", "canceled", "interrupted":
        return true
    default:
        return false
    }
}

private func shouldShowProcessGroup(
    items: [CodexThreadItem],
    userMessages: [CodexThreadItem],
    processItems: [CodexThreadItem]
) -> Bool {
    if !processItems.isEmpty {
        return true
    }
    return !userMessages.isEmpty && items.contains { !isTerminalTurnStatus($0.turnStatus) }
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
        case .process(let turnId, let items):
            return turnId + ":" + items.map(detailItemSignature).joined(separator: ",")
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

struct DetailHeaderView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    @State private var didCopyWorkspacePath = false
    @State private var gitHeadState: GitHeadState?

    var body: some View {
        HStack(spacing: 10) {
            if isLiquidGlass {
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
            }

            VStack(alignment: .leading, spacing: 2) {
                if !isLiquidGlass, let selectedSession = backendClient.selectedSession {
                    Text(selectedSession.title)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if backendClient.viewingHistoricalThreadId != nil {
                        Label(L10n("Read-only history"), systemImage: "clock.arrow.circlepath")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.orange)
                    } else if let continuationState = backendClient.selectedSession?.external?.workspace?.continuationState,
                              ["pending", "queued", "running"].contains(continuationState) {
                        Label(L10n("Continuing after Worktree switch"), systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(CorptiePalette.connected)
                            .lineLimit(2)
                            .truncationMode(.tail)
                    } else if backendClient.selectedSession?.external?.workspace?.continuationState == "failed" {
                        Label(L10n("Worktree continuation failed"), systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.orange)
                    } else if backendClient.selectedSession?.external?.workspace?.transitionStrategy == "handoff" {
                        Label(L10n("Context handoff"), systemImage: "arrow.triangle.branch")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                }
                if let cwd = workspacePath, !cwd.isEmpty {
                    HStack(alignment: .center, spacing: 6) {
                        if let selectedSession = backendClient.selectedSession {
                            SessionAgentIdentity(session: selectedSession)
                                .font(.system(size: 11, weight: .semibold))
                        }

                        Button(action: copyWorkspacePath) {
                            HStack(spacing: 4) {
                                Text(projectName ?? URL(fileURLWithPath: cwd).lastPathComponent)
                                    .lineLimit(1)
                                if didCopyWorkspacePath {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 8, weight: .bold))
                                        .foregroundStyle(CorptiePalette.connected)
                                        .transition(.opacity.combined(with: .scale))
                                }
                            }
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(L10nFormat("Copy full workspace path: %@", cwd))

                        if let gitHeadState,
                           gitHeadState.stampText != nil {
                            Button {
                                ProjectWorktreeWindowManager.shared.show(backendClient: backendClient)
                            } label: {
                                GitBranchStamp(headState: gitHeadState)
                            }
                            .buttonStyle(.plain)
                            .help(L10n("Manage project worktrees and service"))
                            .accessibilityLabel(L10n("Manage project worktrees and service"))
                        }
                    }
                } else {
                    Text(backendClient.selectedSession?.summary ?? "")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .lineLimit(1)
                }
            }

            Spacer()

            if let action = primaryHeaderAction {
                headerActionButton(action)
                    .contextMenu {
                        headerActionMenu
                    }
            }

            if let status = backendClient.selectedProjectWorktreeStatus {
                ProjectServiceStatusDot(status: status.service)
                    .help(projectServiceStatusHelp(status))
            }
        }
        .task(id: workspaceRouteIdentity) {
            await refreshGitBranch()
        }
        .onChange(of: backendClient.gitHubPushPreparation) { _, preparation in
            if let preparation {
                GitHubPushConfirmationWindowManager.shared.show(
                    preparation: preparation,
                    backendClient: backendClient
                )
            } else {
                GitHubPushConfirmationWindowManager.shared.close()
            }
        }
    }

    private var selectedSessionWorktree: ProjectWorktreeStatus? {
        guard let sessionId = backendClient.selectedSession?.id,
              let status = backendClient.selectedProjectWorktreeStatus else { return nil }
        if let bound = status.project.worktrees.first(where: { worktree in
            worktree.sessions.contains(where: { $0.sessionId == sessionId })
        }) {
            return bound
        }
        guard let workspacePath else { return nil }
        let normalized = URL(fileURLWithPath: workspacePath).standardizedFileURL.path
        return status.project.worktrees.first {
            URL(fileURLWithPath: $0.path).standardizedFileURL.path == normalized
        }
    }

    private enum HeaderAction {
        case returnToActiveThread
        case reconnect
        case gitHubPush
        case manageWorktrees
    }

    private var primaryHeaderAction: HeaderAction? {
        if backendClient.viewingHistoricalThreadId != nil {
            return .returnToActiveThread
        }
        if canReconnectSelectedSession {
            return .reconnect
        }
        if backendClient.isSelectedSessionPushingGitHub {
            return .gitHubPush
        }
        if gitHubPushHasPendingChanges, selectedSessionWorktree != nil {
            return .gitHubPush
        }
        if shouldSuggestWorktreeManagement {
            return .manageWorktrees
        }
        return nil
    }

    private var canReconnectSelectedSession: Bool {
        backendClient.selectedSession?.canResumeNow == true
            && backendClient.selectedSession?.isConnected == false
    }

    private var shouldSuggestWorktreeManagement: Bool {
        guard let project = backendClient.selectedProjectWorktreeStatus?.project else { return false }
        return project.pendingWorktreeCount > 0 || project.worktrees.contains { worktree in
            worktree.availability != "available"
                || worktree.dirty == true
                || worktree.pendingIntegration
                || (worktree.behindMain ?? 0) > 0
        }
    }

    @ViewBuilder
    private func headerActionButton(_ action: HeaderAction) -> some View {
        switch action {
        case .returnToActiveThread:
            Button {
                backendClient.returnToActiveThread()
            } label: {
                Label(L10n("Active thread"), systemImage: "arrow.forward.circle")
                    .font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help(L10n("Return to the active workspace thread"))
        case .reconnect:
            Button {
                backendClient.reconnectSelectedSession()
            } label: {
                Image(systemName: "link")
                    .font(.system(size: 11, weight: .bold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(IconButtonStyle())
            .help(L10n("Reconnect session"))
        case .gitHubPush:
            let worktree = selectedSessionWorktree
            let color = gitHubButtonColor(worktree)
            if backendClient.isSelectedSessionPushingGitHub {
                GitHubPushButtonVisual(color: color, state: .pushing)
                    .help(gitHubPushButtonHelp(worktree))
            } else {
                Button {
                    backendClient.prepareGitHubPush()
                } label: {
                    GitHubPushButtonVisual(
                        color: color,
                        state: backendClient.isPreparingGitHubPush ? .preparing : .ready
                    )
                }
                .buttonStyle(.plain)
                .disabled(
                    backendClient.isPreparingGitHubPush || backendClient.isPushingGitHub
                )
                .help(gitHubPushButtonHelp(worktree))
            }
        case .manageWorktrees:
            if let status = backendClient.selectedProjectWorktreeStatus {
                Button {
                    ProjectWorktreeWindowManager.shared.show(backendClient: backendClient)
                } label: {
                    ProjectWorktreeStatusChip(status: status)
                }
                .buttonStyle(.plain)
                .help(L10n("Manage project worktrees and service"))
            }
        }
    }

    @ViewBuilder
    private var headerActionMenu: some View {
        if backendClient.viewingHistoricalThreadId != nil {
            Button {
                backendClient.returnToActiveThread()
            } label: {
                Label(L10n("Active thread"), systemImage: "arrow.forward.circle")
            }
        }

        if canReconnectSelectedSession {
            Button {
                backendClient.reconnectSelectedSession()
            } label: {
                Label(L10n("Reconnect session"), systemImage: "link")
            }
        }

        Button {
            backendClient.prepareGitHubPush()
        } label: {
            Label(L10n("Commit and Push to GitHub"), systemImage: "arrow.up.circle.fill")
        }
        .disabled(
            backendClient.viewingHistoricalThreadId != nil
                || backendClient.isPreparingGitHubPush
                || backendClient.isPushingGitHub
                || !gitHubPushHasPendingChanges
        )

        Button {
            ProjectWorktreeWindowManager.shared.show(backendClient: backendClient)
        } label: {
            Label(L10n("Manage project worktrees and service"), systemImage: "arrow.triangle.branch")
        }
        .disabled(backendClient.selectedProjectWorktreeStatus == nil)

        Divider()

        Button(action: openWorkspaceInVSCode) {
            Label(L10n("Open in Visual Studio Code"), systemImage: "chevron.left.forwardslash.chevron.right")
        }
        .disabled(workspacePath == nil)

        Button(action: openWorkspaceInFinder) {
            Label(L10n("Open in Finder"), systemImage: "folder")
        }
        .disabled(workspacePath == nil)
    }

    private func gitHubButtonColor(_ worktree: ProjectWorktreeStatus?) -> Color {
        if backendClient.isSelectedSessionPushingGitHub {
            return worktree?.dirty == true ? CorptiePalette.amber : CorptiePalette.connected
        }
        guard gitHubPushHasPendingChanges else { return CorptiePalette.mutedText }
        return worktree?.dirty == true ? CorptiePalette.amber : CorptiePalette.connected
    }

    private var gitHubPushHasPendingChanges: Bool {
        guard let push = selectedGitHubPushStatus else { return false }
        return push.available && push.pending
    }

    private var selectedGitHubPushStatus: GitHubPushStatus? {
        ProjectGitHubPushSelection.status(
            for: selectedSessionWorktree,
            fallback: backendClient.selectedProjectWorktreeStatus?.gitHubPush
        )
    }

    private func gitHubPushButtonHelp(_ worktree: ProjectWorktreeStatus?) -> String {
        if backendClient.isSelectedSessionPushingGitHub {
            return L10n("Pushing to GitHub…")
        }
        if let error = backendClient.gitHubPushError {
            return error
        }
        guard let push = selectedGitHubPushStatus else {
            return L10n("Checking for changes to push")
        }
        if !push.available {
            return push.error ?? L10n("GitHub push is unavailable")
        }
        if !push.pending {
            return L10n("No changes or commits to push")
        }
        return worktree?.dirty == true
            ? L10n("Uncommitted changes — review commit and GitHub push")
            : L10nFormat("%d commit(s) ready to push", push.unpushedCommitCount)
    }

    private func projectServiceStatusHelp(_ status: ProjectWorktreeStatusResponse) -> String {
        let service: String
        switch status.service.freshness {
        case "current": service = L10n("Service is running the latest code")
        case "stale": service = L10n("Service is running older or modified code")
        case "configurationMismatch": service = L10n("Service profile does not match the selected profile")
        case "unverifiedBuild": service = L10n("Running build cannot be verified")
        case "toolsetUpdateRequired": service = L10n("Update the project toolset to verify this service")
        case "unhealthy": service = L10n("Service is running but unhealthy")
        case "stopped": service = L10n("Service is stopped")
        default: service = L10n("Service version is unknown")
        }
        return service
    }

    private var workspacePath: String? {
        if backendClient.viewingHistoricalThreadId != nil {
            let historicalPath = backendClient.selectedDetail?.cwd?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let historicalPath, !historicalPath.isEmpty {
                return historicalPath
            }
        }
        let routedPath = backendClient.selectedSession?.external?.workspace?.path?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let routedPath, !routedPath.isEmpty {
            return routedPath
        }
        let detailPath = backendClient.selectedDetail?.cwd?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let detailPath, !detailPath.isEmpty {
            return detailPath
        }
        let sessionPath = backendClient.selectedSession?.external?.cwd?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return sessionPath?.isEmpty == false ? sessionPath : nil
    }

    private var projectName: String? {
        let projectPath = backendClient.selectedSession?.external?.workspace?.projectPath?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let path = projectPath?.isEmpty == false ? projectPath : workspacePath
        guard let path, !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path).standardizedFileURL.lastPathComponent
    }

    private var workspaceRouteIdentity: String {
        let version = backendClient.selectedSession?.external?.routingVersion ?? 0
        return "\(version):\(workspacePath ?? "")"
    }

    private func refreshGitBranch() async {
        guard let workspacePath else {
            gitHeadState = nil
            return
        }
        while !Task.isCancelled {
            let nextHeadState = await GitBranchResolver.headState(at: workspacePath)
            guard !Task.isCancelled, workspacePath == self.workspacePath else {
                return
            }
            if gitHeadState != nextHeadState {
                gitHeadState = nextHeadState
            }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    private var canInterruptCurrentRun: Bool {
        backendClient.selectedDetail?.status == .running
            && backendClient.selectedDetail?.canInterruptNow == true
    }

    private func copyWorkspacePath() {
        guard copySessionNameToPasteboard(workspacePath) else { return }
        withAnimation(.easeOut(duration: 0.12)) {
            didCopyWorkspacePath = true
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 900_000_000)
            withAnimation(.easeOut(duration: 0.12)) {
                didCopyWorkspacePath = false
            }
        }
    }

    private func openWorkspaceInFinder() {
        guard let workspacePath else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: workspacePath, isDirectory: true))
    }

    private func openWorkspaceInVSCode() {
        guard let workspacePath else { return }
        let workspaceURL = URL(fileURLWithPath: workspacePath, isDirectory: true)
        if let applicationURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.VSCode") {
            NSWorkspace.shared.open(
                [workspaceURL],
                withApplicationAt: applicationURL,
                configuration: NSWorkspace.OpenConfiguration()
            )
            return
        }
        var components = URLComponents()
        components.scheme = "vscode"
        components.host = "file"
        components.path = workspaceURL.path
        if let url = components.url {
            NSWorkspace.shared.open(url)
        }
    }
}

struct GitHubPushArrowAnimation {
    static let duration = 1.4
    static let progressSymbolName = "arrow.up"
    static let travelExtent = 20.0

    static func progress(at time: TimeInterval) -> Double {
        let remainder = time.truncatingRemainder(dividingBy: duration)
        return (remainder < 0 ? remainder + duration : remainder) / duration
    }

    static func verticalOffset(progress: Double) -> Double {
        let clamped = min(max(progress, 0), 1)
        return travelExtent - (travelExtent * 2 * clamped)
    }

    static func opacity(progress: Double) -> Double {
        let clamped = min(max(progress, 0), 1)
        if clamped < 0.25 {
            return clamped / 0.25
        }
        if clamped <= 0.55 {
            return 1
        }
        return (1 - clamped) / 0.45
    }
}

struct GitHubPushButtonAppearance {
    static let diameter = 28.0
    static let arrowFontSize = 12.0
    static let arrowOpacity = 1.0
}

private struct GitHubPushButtonVisual: View {
    enum State: Equatable {
        case ready
        case preparing
        case pushing
    }

    let color: Color
    let state: State

    var body: some View {
        ZStack {
            switch state {
            case .ready:
                Image(systemName: GitHubPushArrowAnimation.progressSymbolName)
                    .font(.system(
                        size: GitHubPushButtonAppearance.arrowFontSize,
                        weight: .heavy
                    ))
                    .symbolRenderingMode(.monochrome)
                    .foregroundColor(color)
                    .opacity(GitHubPushButtonAppearance.arrowOpacity)
            case .preparing:
                ProgressView()
                    .controlSize(.small)
                    .tint(color)
            case .pushing:
                GitHubPushProgressIcon(color: color)
            }
        }
        .frame(
            width: GitHubPushButtonAppearance.diameter,
            height: GitHubPushButtonAppearance.diameter
        )
        .background { ComposerGlassActionBackground(tint: color) }
    }
}

struct GitHubPushDisclosure {
    struct ChangeGroups: Equatable {
        let added: [String]
        let modified: [String]
        let deleted: [String]
    }

    static func changeGroups(
        addedFiles: [String],
        modifiedFiles: [String],
        deletedFiles: [String],
        changedFiles: [String],
        protectedPaths: [String],
        ignoringProtectedFiles: Bool
    ) -> ChangeGroups {
        guard ignoringProtectedFiles else {
            return ChangeGroups(added: addedFiles, modified: modifiedFiles, deleted: deletedFiles)
        }
        let normalizedChangedPaths = Set(changedFiles.map(normalize))
        let normalizedProtectedPaths = protectedPaths.map(normalize)
        func filtered(_ values: [String]) -> [String] {
            values.filter { path in
                let normalizedPath = normalize(path)
                guard normalizedChangedPaths.contains(normalizedPath) else { return true }
                return !normalizedProtectedPaths.contains { protectedPath in
                    protectedPath == normalizedPath || protectedPath.hasPrefix("\(normalizedPath)/")
                }
            }
        }
        var added = filtered(addedFiles)
        var modified = filtered(modifiedFiles)
        let deleted = filtered(deletedFiles)
        if !added.contains(".gitignore") && !modified.contains(".gitignore") {
            modified.append(".gitignore")
        }
        added = Array(Set(added)).sorted()
        modified = Array(Set(modified)).sorted()
        return ChangeGroups(added: added, modified: modified, deleted: Array(Set(deleted)).sorted())
    }

    static func filesToPush(
        filesToPush: [String],
        changedFiles: [String],
        protectedPaths: [String],
        ignoringProtectedFiles: Bool
    ) -> [String] {
        guard ignoringProtectedFiles else { return filesToPush }
        let normalizedChangedPaths = Set(changedFiles.map(normalize))
        let normalizedProtectedPaths = protectedPaths.map(normalize)
        let disclosed = filesToPush.filter { path in
            let normalizedPath = normalize(path)
            guard normalizedChangedPaths.contains(normalizedPath) else { return true }
            return !normalizedProtectedPaths.contains { protectedPath in
                protectedPath == normalizedPath || protectedPath.hasPrefix("\(normalizedPath)/")
            }
        }
        return Array(Set(disclosed + [".gitignore"])).sorted()
    }

    private static func normalize(_ path: String) -> String {
        var normalized = path
        while normalized.hasPrefix("/") { normalized.removeFirst() }
        while normalized.hasSuffix("/") { normalized.removeLast() }
        return normalized
    }
}

private struct GitHubPushProgressIcon: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let color: Color

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
            let progress = GitHubPushArrowAnimation.progress(
                at: context.date.timeIntervalSinceReferenceDate
            )
            Image(systemName: GitHubPushArrowAnimation.progressSymbolName)
                .font(.system(
                    size: GitHubPushButtonAppearance.arrowFontSize,
                    weight: .heavy
                ))
                .symbolRenderingMode(.monochrome)
                .foregroundColor(color)
                .offset(y: reduceMotion ? 0 : GitHubPushArrowAnimation.verticalOffset(progress: progress))
                .opacity(reduceMotion
                    ? GitHubPushButtonAppearance.arrowOpacity
                    : GitHubPushArrowAnimation.opacity(progress: progress))
        }
        .frame(
            width: GitHubPushButtonAppearance.diameter,
            height: GitHubPushButtonAppearance.diameter
        )
        .clipShape(Circle())
        .accessibilityLabel(L10n("Pushing to GitHub…"))
    }
}

private struct GitHubPushConfirmationView: View {
    @EnvironmentObject private var backendClient: BackendClient
    let preparation: GitHubPushPreparation
    @State private var privateFilesDecision = "include"
    @State private var neverRemindPrivateFiles = false
    @State private var commitMessage = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(preparation.dirty ? CorptiePalette.amber : CorptiePalette.connected)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n("Review GitHub Push"))
                        .font(.system(size: 18, weight: .bold))
                    Text(preparation.repository)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                disclosureRow(L10n("Destination"), value: preparation.remoteUrl)
                disclosureRow(L10n("Branch"), value: preparation.branch)
                disclosureRow(L10n("Source code"), value: L10n("Included"))
                disclosureRow(
                    L10n("Visibility"),
                    value: L10n("Existing GitHub repository access settings; Corptie will not change visibility.")
                )
                disclosureRow(
                    L10n("Remote storage"),
                    value: L10n("Commits will remain in GitHub history until removed under repository and GitHub retention policies.")
                )
            }
            .padding(12)
            .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.09), lineWidth: 0.75)
            )

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    disclosureList(
                        title: L10nFormat("Added files (%d)", disclosedChangeGroups.added.count),
                        values: disclosedChangeGroups.added,
                        icon: "plus.circle.fill",
                        color: CorptiePalette.connected
                    )
                    disclosureList(
                        title: L10nFormat("Modified files (%d)", disclosedChangeGroups.modified.count),
                        values: disclosedChangeGroups.modified,
                        icon: "pencil.circle.fill",
                        color: CorptiePalette.amber
                    )
                    disclosureList(
                        title: L10nFormat("Deleted files (%d)", disclosedChangeGroups.deleted.count),
                        values: disclosedChangeGroups.deleted,
                        icon: "minus.circle.fill",
                        color: .red
                    )
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L10nFormat("Commits sent to GitHub (%d)", preparation.commitsToPush.count))
                            .font(.system(size: 12, weight: .semibold))
                        if preparation.commitsToPush.isEmpty {
                            Text(L10n("No existing local commits are waiting to be pushed."))
                                .font(.system(size: 11))
                                .foregroundStyle(CorptiePalette.secondaryText)
                        } else {
                            ForEach(preparation.commitsToPush, id: \.oid) { commit in
                                HStack(alignment: .firstTextBaseline, spacing: 7) {
                                    Text(String(commit.oid.prefix(8)))
                                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                                        .foregroundStyle(CorptiePalette.mutedText)
                                    Text(commit.subject)
                                        .font(.system(size: 11))
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 210)

            if preparation.dirty {
                CommitMessageEditor(
                    message: $commitMessage,
                    isGenerating: backendClient.isGeneratingGitHubCommitMessage,
                    helpText: L10n("Enter your own message or generate one with Agent, then edit it before pushing."),
                    generate: { await backendClient.generateGitHubCommitMessage() }
                )
            }

            if preparation.commitProtection?.requiresDecision == true,
               let protection = preparation.commitProtection {
                PrivateAgentFilesDecisionView(
                    protection: protection,
                    decision: $privateFilesDecision,
                    neverRemind: $neverRemindPrivateFiles
                )
            }

            if let error = backendClient.gitHubPushError {
                Text(error)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }

            HStack {
                Spacer()
                Button(L10n("Cancel")) {
                    backendClient.cancelGitHubPush()
                }
                .keyboardShortcut(.cancelAction)

                Button(preparation.dirty
                    ? L10n("Commit and Push to GitHub")
                    : L10n("Push to GitHub")) {
                    backendClient.confirmGitHubPush(
                        commitMessage: preparation.dirty
                            ? commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
                            : nil,
                        privateFilesDecision: preparation.commitProtection?.requiresDecision == true
                            ? privateFilesDecision
                            : nil,
                        neverRemindPrivateFiles: neverRemindPrivateFiles
                    )
                }
                .keyboardShortcut(.defaultAction)
                .disabled(
                    backendClient.isGeneratingGitHubCommitMessage
                        || (preparation.dirty
                            && commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                )
            }
        }
        .padding(20)
        .frame(width: 560, height: 710)
    }

    private func disclosureRow(_ title: String, value: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CorptiePalette.secondaryText)
                .frame(width: 94, alignment: .leading)
            Text(value)
                .font(.system(size: 11, design: title == L10n("Destination") ? .monospaced : .default))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var disclosedChangeGroups: GitHubPushDisclosure.ChangeGroups {
        let hasStructuredChanges = preparation.addedFiles != nil
            || preparation.modifiedFiles != nil
            || preparation.deletedFiles != nil
        return GitHubPushDisclosure.changeGroups(
            addedFiles: preparation.addedFiles ?? [],
            modifiedFiles: preparation.modifiedFiles ?? (hasStructuredChanges ? [] : preparation.filesToPush),
            deletedFiles: preparation.deletedFiles ?? [],
            changedFiles: preparation.changedFiles,
            protectedPaths: preparation.commitProtection?.protectedPaths ?? [],
            ignoringProtectedFiles: privateFilesDecision == "ignore"
                && preparation.commitProtection?.requiresDecision == true
        )
    }

    @ViewBuilder
    private func disclosureList(title: String, values: [String], icon: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(color)
            if values.isEmpty {
                Text(L10n("None"))
                    .font(.system(size: 11))
                    .foregroundStyle(CorptiePalette.secondaryText)
            } else {
                ForEach(values, id: \.self) { value in
                    Text(value)
                        .font(.system(size: 10.5, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
        }
    }
}

private struct CommitMessageEditor: View {
    @Binding var message: String
    let isGenerating: Bool
    let helpText: String
    let generate: () async -> String?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(L10n("Commit message"))
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                Button {
                    Task {
                        if let suggestion = await generate() {
                            message = suggestion
                        }
                    }
                } label: {
                    if isGenerating {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text(L10n("Generating…"))
                        }
                    } else {
                        Label(L10n("Generate with Agent"), systemImage: "wand.and.stars")
                    }
                }
                .disabled(isGenerating)
            }
            TextField(L10n("Enter a commit message"), text: $message)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12, design: .monospaced))
            Text(helpText)
                .font(.system(size: 10.5))
                .foregroundStyle(CorptiePalette.secondaryText)
        }
    }
}

@MainActor
private final class GitHubPushConfirmationWindowManager {
    static let shared = GitHubPushConfirmationWindowManager()
    private var controller: GitHubPushConfirmationWindowController?

    func show(preparation: GitHubPushPreparation, backendClient: BackendClient) {
        if let controller {
            controller.show()
            return
        }
        let controller = GitHubPushConfirmationWindowController(
            preparation: preparation,
            backendClient: backendClient
        ) { [weak self] in
            self?.controller = nil
        }
        self.controller = controller
        controller.show()
    }

    func close() {
        controller?.close()
    }
}

@MainActor
private final class GitHubPushConfirmationWindowController: NSObject, NSWindowDelegate {
    private let panel: NSPanel
    private let backendClient: BackendClient
    private let didClose: () -> Void

    init(
        preparation: GitHubPushPreparation,
        backendClient: BackendClient,
        didClose: @escaping () -> Void
    ) {
        self.backendClient = backendClient
        self.didClose = didClose
        let content = GitHubPushConfirmationView(preparation: preparation)
            .environmentObject(backendClient)
        let hostingController = NSHostingController(rootView: content)
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 710),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        panel.title = L10n("Review GitHub Push")
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.contentViewController = hostingController
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.center()
        self.panel = panel
        super.init()
        panel.delegate = self
    }

    func show() {
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() {
        panel.close()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        backendClient.cancelGitHubPush()
        return true
    }

    func windowWillClose(_ notification: Notification) {
        didClose()
    }
}

private struct ProjectWorktreeStatusChip: View {
    let status: ProjectWorktreeStatusResponse

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 10, weight: .semibold))
            Text("\(status.project.pendingWorktreeCount)")
                .font(.system(size: 10, weight: .bold, design: .rounded))
        }
        .foregroundStyle(status.project.pendingWorktreeCount > 0 ? CorptiePalette.amber : CorptiePalette.secondaryText)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color.white.opacity(0.06), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 0.75))
    }

}

private struct ProjectServiceStatusDot: View {
    let status: ProjectServiceStatus

    var body: some View {
        Circle()
            .fill(serviceColor)
            .frame(width: 7, height: 7)
            .frame(width: 16, height: 28)
            .accessibilityLabel(accessibilityText)
    }

    private var serviceColor: Color {
        switch status.freshness {
        case "current": CorptiePalette.connected
        case "stale", "configurationMismatch", "unverifiedBuild", "toolsetUpdateRequired", "unhealthy": CorptiePalette.amber
        default: CorptiePalette.mutedText
        }
    }

    private var accessibilityText: String {
        switch status.freshness {
        case "current": return L10n("Service is running the latest code")
        case "stale": return L10n("Service is running older or modified code")
        case "configurationMismatch": return L10n("Service profile does not match the selected profile")
        case "unverifiedBuild": return L10n("Running build cannot be verified")
        case "toolsetUpdateRequired": return L10n("Update the project toolset to verify this service")
        case "unhealthy": return L10n("Service is running but unhealthy")
        case "stopped": return L10n("Service is stopped")
        default: return L10n("Service version is unknown")
        }
    }
}

@MainActor
private final class ProjectWorktreeWindowManager {
    static let shared = ProjectWorktreeWindowManager()
    private var controller: ProjectWorktreeWindowController?

    func show(backendClient: BackendClient) {
        if let controller {
            controller.show()
            return
        }
        let controller = ProjectWorktreeWindowController(backendClient: backendClient) { [weak self] in
            self?.controller = nil
        }
        self.controller = controller
        controller.show()
    }

    func close() {
        controller?.close()
    }
}

@MainActor
private final class ProjectWorktreeWindowController: NSObject, NSWindowDelegate {
    private let panel: NSPanel
    private let didClose: () -> Void

    init(backendClient: BackendClient, didClose: @escaping () -> Void) {
        self.didClose = didClose
        let content = ProjectWorktreeManagerView()
            .environmentObject(backendClient)
        let hostingController = NSHostingController(rootView: content)
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 680, height: 500),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.title = L10n("Project Worktrees")
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.contentViewController = hostingController
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 600, height: 430)
        panel.center()
        self.panel = panel
        super.init()
        panel.delegate = self
    }

    func show() {
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() {
        panel.close()
    }

    func windowWillClose(_ notification: Notification) {
        didClose()
    }
}

private struct PendingWorktreeDeletion: Identifiable {
    let id = UUID()
    let worktree: ProjectWorktreeStatus
    let deleteSessions: Bool
    let restartService: Bool
}

enum ProjectWorktreeCleanupPolicy {
    static func eligibleWorktrees(from worktrees: [ProjectWorktreeStatus]) -> [ProjectWorktreeStatus] {
        worktrees.filter { worktree in
            !worktree.isMain
                && worktree.availability == "available"
                && worktree.mergedIntoMain == true
                && worktree.dirty == false
                && worktree.sessions.isEmpty
        }
    }
}

enum ProjectGitHubPushSelection {
    static func status(
        for worktree: ProjectWorktreeStatus?,
        fallback: GitHubPushStatus?
    ) -> GitHubPushStatus? {
        worktree?.gitHubPush ?? fallback
    }
}

private struct ProjectWorktreeManagerView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @StateObject private var newSessionPanel = NewSessionPanelController()
    @State private var pendingOperation: ProjectWorktreeStatus?
    @State private var pendingSynchronization: ProjectWorktreeStatus?
    @State private var pendingCommit: ProjectWorktreeStatus?
    @State private var pendingDeletionWarning: PendingWorktreeDeletion?
    @State private var pendingDeletionConfirmation: PendingWorktreeDeletion?
    @State private var pendingMergedCleanup: [ProjectWorktreeStatus] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L10n("Project Worktrees"))
                        .font(.system(size: 18, weight: .bold))
                    if let status {
                        Text(L10nFormat("%d worktrees are not merged into main", status.project.pendingWorktreeCount))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                }
                Spacer()
                if let status {
                    let eligible = ProjectWorktreeCleanupPolicy.eligibleWorktrees(
                        from: status.project.worktrees
                    )
                    Button {
                        pendingMergedCleanup = eligible
                    } label: {
                        Label(
                            L10nFormat("Clean Up Merged (%d)", eligible.count),
                            systemImage: "trash"
                        )
                    }
                    .controlSize(.small)
                    .disabled(eligible.isEmpty || backendClient.isCleaningMergedProjectWorktrees)
                    .help(eligible.isEmpty
                        ? L10n("No merged Worktrees without associated sessions")
                        : L10n("Remove all merged Worktrees that have no associated sessions"))
                }
            }

            if let error = backendClient.lastError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }

            if let status {
                serviceCard(status)
                Divider()
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(status.project.worktrees) { worktree in
                            worktreeRow(worktree)
                        }
                    }
                    .padding(.vertical, 2)
                }
            } else if let loadError = backendClient.projectWorktreeLoadError {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(.orange)
                    Text(loadError)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .multilineTextAlignment(.center)
                        .textSelection(.enabled)
                    Button(L10n("Retry")) {
                        Task { await backendClient.refreshSelectedProjectWorktrees() }
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 10) {
                    ProgressView()
                    Text(L10n("Loading project worktrees"))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(20)
        .frame(minWidth: 600, idealWidth: 680, minHeight: 400, idealHeight: 500)
        .task {
            await backendClient.refreshSelectedProjectWorktrees()
        }
        .sheet(item: $pendingOperation) { worktree in
            if let status {
                ProjectWorktreeOperationView(
                    worktree: worktree,
                    status: status,
                    onExecute: { merge, synchronize, deleteWorktree, deleteSessions, restart in
                        pendingOperation = nil
                        if deleteWorktree,
                           worktree.mergedIntoMain != true || worktree.dirty == true {
                            let deletion = PendingWorktreeDeletion(
                                worktree: worktree,
                                deleteSessions: deleteSessions,
                                restartService: restart
                            )
                            Task { @MainActor in
                                try? await Task.sleep(for: .milliseconds(180))
                                pendingDeletionWarning = deletion
                            }
                        } else {
                            backendClient.operateProjectWorktree(
                                worktree,
                                mergeIntoMain: merge,
                                synchronizeWithMain: synchronize,
                                deleteWorktree: deleteWorktree,
                                deleteSessions: deleteSessions,
                                restartService: restart
                            )
                        }
                    },
                    onCancel: { pendingOperation = nil }
                )
            }
        }
        .sheet(item: Binding(
            get: { backendClient.worktreeCommitReviewPrompt },
            set: { value in
                if value == nil { backendClient.cancelProtectedWorktreeCommit() }
            }
        )) { prompt in
            WorktreeCommitReviewView(prompt: prompt)
                .environmentObject(backendClient)
        }
        .confirmationDialog(
            L10nFormat("Remove %d merged Worktrees?", pendingMergedCleanup.count),
            isPresented: Binding(
                get: { !pendingMergedCleanup.isEmpty },
                set: { if !$0 { pendingMergedCleanup = [] } }
            ),
            titleVisibility: .visible
        ) {
            Button(L10n("Remove Worktrees"), role: .destructive) {
                let targets = pendingMergedCleanup
                pendingMergedCleanup = []
                backendClient.cleanupMergedProjectWorktrees(targets)
            }
            Button(L10n("Cancel"), role: .cancel) {
                pendingMergedCleanup = []
            }
        } message: {
            Text(L10nFormat(
                "The following merged Worktrees have no associated sessions and will be permanently removed with their local branches:\n%@",
                pendingMergedCleanup.map { $0.branchName ?? $0.path }.joined(separator: "\n")
            ))
        }
        .confirmationDialog(
            L10nFormat(
                "%d unmerged commits will be permanently deleted",
                pendingDeletionWarning?.worktree.aheadOfMain ?? 0
            ),
            isPresented: Binding(
                get: { pendingDeletionWarning != nil },
                set: { if !$0 { pendingDeletionWarning = nil } }
            ),
            presenting: pendingDeletionWarning
        ) { deletion in
            Button(L10n("Continue to branch-name confirmation"), role: .destructive) {
                pendingDeletionWarning = nil
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(140))
                    pendingDeletionConfirmation = deletion
                }
            }
            Button(L10n("Cancel"), role: .cancel) {
                pendingDeletionWarning = nil
            }
        } message: { deletion in
            Text(L10nFormat(
                "Deleting this Worktree will permanently delete all changes on branch %@. This action cannot be undone.",
                deletion.worktree.branchName ?? L10n("detached HEAD")
            ))
        }
        .sheet(item: $pendingDeletionConfirmation) { deletion in
            ForceDeleteWorktreeConfirmationView(
                deletion: deletion,
                onConfirm: { branchName in
                    backendClient.operateProjectWorktree(
                        deletion.worktree,
                        mergeIntoMain: false,
                        synchronizeWithMain: false,
                        deleteWorktree: true,
                        deleteSessions: deletion.deleteSessions,
                        restartService: deletion.restartService,
                        forceDeleteUnmerged: true,
                        confirmedBranchName: branchName
                    )
                    pendingDeletionConfirmation = nil
                },
                onCancel: { pendingDeletionConfirmation = nil }
            )
        }
        .confirmationDialog(
            L10n("Synchronize this Worktree with main?"),
            isPresented: Binding(
                get: { pendingSynchronization != nil },
                set: { if !$0 { pendingSynchronization = nil } }
            ),
            presenting: pendingSynchronization
        ) { worktree in
            Button(L10n("Synchronize with main")) {
                backendClient.synchronizeProjectWorktree(worktree)
                pendingSynchronization = nil
            }
            Button(L10n("Cancel"), role: .cancel) {
                pendingSynchronization = nil
            }
        } message: { worktree in
            if worktree.dirty == true || worktree.mergedIntoMain != true {
                Text(L10n("This Worktree has changes not yet merged into main. Corptie will commit them if needed, merge them into main, and then synchronize the Worktree. No remote push is performed."))
            } else {
                Text(L10nFormat(
                    "This fast-forwards the Worktree by %d commits to the current main revision. No remote push is performed.",
                    worktree.behindMain ?? 0
                ))
            }
        }
        .confirmationDialog(
            L10n("Commit changes in this Worktree?"),
            isPresented: Binding(
                get: { pendingCommit != nil },
                set: { if !$0 { pendingCommit = nil } }
            ),
            presenting: pendingCommit
        ) { worktree in
            Button(L10n("Commit changes")) {
                backendClient.commitProjectWorktreeChanges(worktree)
                pendingCommit = nil
            }
            Button(L10n("Cancel"), role: .cancel) {
                pendingCommit = nil
            }
        } message: { worktree in
            Text(L10nFormat(
                "Corptie will generate a commit message using the associated session and commit the uncommitted changes on %@. No remote push is performed.",
                worktree.branchName ?? L10n("detached HEAD")
            ))
        }
    }

    private var status: ProjectWorktreeStatusResponse? {
        backendClient.selectedProjectWorktreeStatus
    }

    @ViewBuilder
    private func serviceCard(_ status: ProjectWorktreeStatusResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(L10n("Development Service"), systemImage: "server.rack")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(serviceLabel(status.service))
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(serviceColor(status.service))
                    if let detail = serviceIdentityDetail(status.service) {
                        Text(detail)
                            .font(.system(size: 9.5, weight: .medium, design: .monospaced))
                            .foregroundStyle(CorptiePalette.secondaryText)
                            .lineLimit(1)
                            .help(detail)
                    }
                }
            }

            if status.toolset.configured {
                if !status.toolset.profiles.isEmpty {
                    HStack(spacing: 8) {
                        Text(L10n("Service profile"))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                        Picker("", selection: Binding(
                            get: { status.toolset.selectedProfile },
                            set: { backendClient.selectProjectServiceProfile($0) }
                        )) {
                            ForEach(status.toolset.profiles) { profile in
                                Text(profile.label).tag(profile.id)
                            }
                        }
                        .labelsHidden()
                        .frame(maxWidth: 220)
                        .help(status.toolset.profiles.first(where: {
                            $0.id == status.toolset.selectedProfile
                        })?.description ?? "")
                        Spacer()
                    }
                    .controlSize(.small)
                    .disabled(isServiceActionRunning)
                }

                HStack(spacing: 8) {
                    if status.service.running == true {
                        Button(L10n("Rebuild and Restart")) { backendClient.runProjectServiceAction("restart") }
                        Button(L10n("Stop")) { backendClient.runProjectServiceAction("stop") }
                    } else {
                        Button(L10n("Build and Start")) { backendClient.runProjectServiceAction("start") }
                    }
                    Spacer()
                    Button(L10n("Update Corptie Scripts Tools Set")) {
                        backendClient.initializeProjectToolset(update: true)
                    }
                }
                .controlSize(.small)
                .disabled(isServiceActionRunning)
            } else if status.toolset.requiresUpdate {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(L10n("This project uses an older Corptie toolset."))
                            .font(.system(size: 11, weight: .semibold))
                        Text(L10n("Update it before rebuilding or claiming that the running service is current."))
                            .font(.system(size: 10.5))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                    Spacer()
                    Button(L10n("Update Corptie Scripts Tools Set")) {
                        backendClient.initializeProjectToolset(update: true)
                    }
                    .disabled(backendClient.isLoadingProjectWorktrees)
                }
            } else {
                HStack {
                    Text(L10n("The Corptie Scripts Tools Set is being prepared or is not configured."))
                        .font(.system(size: 11))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    Spacer()
                    Button(L10n("Initialize Toolset")) {
                        backendClient.initializeProjectToolset()
                    }
                    .disabled(backendClient.isLoadingProjectWorktrees)
                }
            }
        }
        .padding(12)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.09), lineWidth: 0.75)
        )
    }

    @ViewBuilder
    private func worktreeRow(_ worktree: ProjectWorktreeStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: worktree.isMain ? "house.fill" : "arrow.triangle.branch")
                    .foregroundStyle(worktreeStateColor(worktree))
                Text(worktree.branchName ?? L10n("detached HEAD"))
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)
                Spacer()
                if !worktree.isMain {
                    if backendClient.projectWorktreeActionIds.contains(worktree.worktreeId) {
                        ProgressView().controlSize(.small)
                    } else {
                        Button(L10n("Actions…")) {
                            pendingOperation = worktree
                        }
                        .controlSize(.small)
                    }
                }
            }
            Text(worktree.path)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(CorptiePalette.mutedText)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(worktree.path)
            HStack(spacing: 8) {
                worktreeStateBadge(worktree)
                if !worktree.isMain {
                    worktreeSyncBadge(worktree)
                }
                if let ahead = worktree.aheadOfMain, ahead > 0 {
                    Button {
                        pendingOperation = worktree
                    } label: {
                        Label(L10nFormat("%d ahead", ahead), systemImage: "arrow.up")
                    }
                    .buttonStyle(.plain)
                    .help(L10n("Open Worktree operations"))
                }
                if let behind = worktree.behindMain, behind > 0 {
                    Button {
                        pendingSynchronization = worktree
                    } label: {
                        Label(L10nFormat("%d behind", behind), systemImage: "arrow.down")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(CorptiePalette.amber)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(CorptiePalette.amber.opacity(0.12), in: Capsule())
                    .disabled(backendClient.projectWorktreeActionIds.contains(worktree.worktreeId))
                    .help(L10n("Synchronize this Worktree with main"))
                }
                if worktree.dirty == true {
                    Button {
                        pendingCommit = worktree
                    } label: {
                        Label(L10n("Uncommitted changes"), systemImage: "pencil.circle")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(CorptiePalette.amber)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(CorptiePalette.amber.opacity(0.12), in: Capsule())
                    .disabled(backendClient.projectWorktreeActionIds.contains(worktree.worktreeId))
                    .help(L10n("Generate a commit message with the associated session and commit these changes"))
                }
                if worktree.isMain,
                   let push = worktree.gitHubPush,
                   push.available,
                   push.pending {
                    mainPushBadge(worktree, push: push)
                }
                worktreeSessionsBadge(worktree)
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(CorptiePalette.secondaryText)
        }
        .padding(12)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.09), lineWidth: 0.75)
        )
    }

    @ViewBuilder
    private func mainPushBadge(_ worktree: ProjectWorktreeStatus, push: GitHubPushStatus) -> some View {
        let label = push.unpushedCommitCount > 0
            ? L10nFormat("%d commit(s) pending push", push.unpushedCommitCount)
            : L10n("Pending GitHub push")
        if selectedSessionWorktreeId == worktree.worktreeId {
            Button {
                backendClient.prepareGitHubPush()
            } label: {
                Label(label, systemImage: "arrow.up.circle.fill")
            }
            .buttonStyle(.plain)
            .foregroundStyle(CorptiePalette.connected)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(CorptiePalette.connected.opacity(0.12), in: Capsule())
            .disabled(backendClient.isPreparingGitHubPush || backendClient.isPushingGitHub)
            .help(L10n("Review and push the current main branch to GitHub"))
        } else {
            Label(label, systemImage: "arrow.up.circle.fill")
                .foregroundStyle(CorptiePalette.connected)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(CorptiePalette.connected.opacity(0.12), in: Capsule())
                .help(L10n("Open a Session on main to review and push these commits"))
        }
    }

    private var selectedSessionWorktreeId: String? {
        guard let session = backendClient.selectedSession,
              let status else { return nil }
        if let associated = status.project.worktrees.first(where: { worktree in
            worktree.sessions.contains(where: { $0.sessionId == session.id })
        }) {
            return associated.worktreeId
        }
        guard let path = session.external?.workspace?.path else { return nil }
        let normalized = URL(fileURLWithPath: path).standardizedFileURL.path
        return status.project.worktrees.first(where: {
            URL(fileURLWithPath: $0.path).standardizedFileURL.path == normalized
        })?.worktreeId
    }

    private func worktreeStatusBadge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(color.opacity(0.12), in: Capsule())
    }

    @ViewBuilder
    private func worktreeStateBadge(_ worktree: ProjectWorktreeStatus) -> some View {
        if worktree.isMain && worktree.dirty != true {
            worktreeStatusBadge(worktreeStateLabel(worktree), color: worktreeStateColor(worktree))
        } else {
            Button {
                if worktree.isMain {
                    pendingCommit = worktree
                } else {
                    pendingOperation = worktree
                }
            } label: {
                worktreeStatusBadge(worktreeStateLabel(worktree), color: worktreeStateColor(worktree))
            }
            .buttonStyle(.plain)
            .help(worktree.isMain ? L10n("Commit uncommitted changes") : L10n("Open Worktree operations"))
        }
    }

    @ViewBuilder
    private func worktreeSyncBadge(_ worktree: ProjectWorktreeStatus) -> some View {
        if worktree.synchronizedWithMain == false {
            Button {
                pendingSynchronization = worktree
            } label: {
                worktreeStatusBadge(worktreeSyncLabel(worktree), color: worktreeSyncColor(worktree))
            }
            .buttonStyle(.plain)
            .disabled(backendClient.projectWorktreeActionIds.contains(worktree.worktreeId))
            .help(L10n("Synchronize this Worktree with main"))
        } else {
            worktreeStatusBadge(worktreeSyncLabel(worktree), color: worktreeSyncColor(worktree))
        }
    }

    @ViewBuilder
    private func worktreeSessionsBadge(_ worktree: ProjectWorktreeStatus) -> some View {
        if worktree.sessions.isEmpty {
            Button {
                newSessionPanel.show(backendClient: backendClient, workspacePath: worktree.path)
            } label: {
                Label(L10n("No associated sessions"), systemImage: "plus.bubble")
            }
            .buttonStyle(.plain)
            .foregroundStyle(CorptiePalette.amber)
            .help(L10n("Create a session in this Worktree"))
        } else if worktree.sessions.count == 1, let association = worktree.sessions.first {
            Button {
                openSession(association)
            } label: {
                Label(L10nFormat("%d sessions", worktree.sessions.count), systemImage: "bubble.left.and.bubble.right")
            }
            .buttonStyle(.plain)
            .help(association.title ?? L10n("Open associated session"))
        } else {
            Menu {
                ForEach(worktree.sessions, id: \.logicalSessionId) { association in
                    Button(association.title ?? association.sessionId ?? association.logicalSessionId) {
                        openSession(association)
                    }
                }
            } label: {
                Label(L10nFormat("%d sessions", worktree.sessions.count), systemImage: "bubble.left.and.bubble.right")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help(L10n("Open associated session"))
        }
    }

    private func openSession(_ association: ProjectWorktreeSession) {
        guard let sessionId = association.sessionId,
              let session = backendClient.sessions.first(where: { $0.id == sessionId }) else { return }
        backendClient.select(session: session)
        ProjectWorktreeWindowManager.shared.close()
    }

    private func serviceLabel(_ service: ProjectServiceStatus) -> String {
        switch service.freshness {
        case "current": L10n("Running main latest")
        case "stale": L10n("Restart required")
        case "configurationMismatch": L10n("Service profile mismatch")
        case "unverifiedBuild": L10n("Build version unverified")
        case "toolsetUpdateRequired": L10n("Toolset update required")
        case "unhealthy": L10n("Service unhealthy")
        case "stopped": L10n("Stopped")
        default:
            switch service.state {
            case "configuring": L10n("Configuring")
            case "configurationFailed": L10n("Configuration failed")
            case "notConfigured": L10n("Not configured")
            default: L10n("Version unknown")
            }
        }
    }

    private var isServiceActionRunning: Bool {
        backendClient.projectWorktreeActionIds.contains { $0.hasPrefix("service:") }
    }

    private func serviceColor(_ service: ProjectServiceStatus) -> Color {
        switch service.freshness {
        case "current": CorptiePalette.connected
        case "stale", "configurationMismatch", "unverifiedBuild", "toolsetUpdateRequired", "unhealthy": CorptiePalette.amber
        default: CorptiePalette.secondaryText
        }
    }

    private func serviceIdentityDetail(_ service: ProjectServiceStatus) -> String? {
        guard let revision = service.runningRevision, !revision.isEmpty else {
            return service.verificationDetail
        }
        let shortRevision = String(revision.prefix(5))
        let branch = service.runningBranch ?? L10n("unknown branch")
        let commitTime = service.runningCommitTime.flatMap { value -> String? in
            guard let date = ISO8601DateFormatter.corptieThreadItemDate(from: value) else { return nil }
            let formatter = DateFormatter()
            formatter.locale = Locale.current
            formatter.timeZone = .current
            formatter.dateFormat = "yyyy-MM-dd HH:mm"
            return formatter.string(from: date)
        } ?? L10n("unknown time")
        let profile = service.runningProfile ?? service.desiredProfile
        let base = L10nFormat("Commit %@ · %@ · branch %@", shortRevision, commitTime, branch)
        if let profile, !profile.isEmpty {
            return "\(base) · \(L10n("profile")) \(profile)"
        }
        return base
    }

    private func worktreeStateLabel(_ worktree: ProjectWorktreeStatus) -> String {
        switch worktree.state {
        case "main": L10n("Main")
        case "mainDirty": L10n("Main has changes")
        case "working": L10n("In progress")
        case "readyToMerge": L10n("Ready to merge")
        case "diverged": L10n("Diverged")
        case "synced": L10n("Merged")
        default: L10n("Unavailable")
        }
    }

    private func worktreeStateColor(_ worktree: ProjectWorktreeStatus) -> Color {
        switch worktree.state {
        case "main", "synced": CorptiePalette.connected
        case "working", "readyToMerge": CorptiePalette.amber
        case "diverged", "unavailable": .red
        default: CorptiePalette.secondaryText
        }
    }

    private func worktreeSyncLabel(_ worktree: ProjectWorktreeStatus) -> String {
        switch worktree.synchronizedWithMain {
        case true: L10n("In sync with main")
        case false: L10n("Not in sync with main")
        case nil: L10n("Sync unknown")
        }
    }

    private func worktreeSyncColor(_ worktree: ProjectWorktreeStatus) -> Color {
        switch worktree.synchronizedWithMain {
        case true: CorptiePalette.connected
        case false: CorptiePalette.amber
        case nil: CorptiePalette.secondaryText
        }
    }
}

private struct ForceDeleteWorktreeConfirmationView: View {
    let deletion: PendingWorktreeDeletion
    let onConfirm: (String) -> Void
    let onCancel: () -> Void
    @State private var typedBranchName = ""

    private var branchName: String {
        deletion.worktree.branchName ?? ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "trash.slash.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(.red)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n("Confirm permanent Worktree deletion"))
                        .font(.system(size: 18, weight: .bold))
                    Text(L10nFormat(
                        "%d commits have not been merged into main.",
                        deletion.worktree.aheadOfMain ?? 0
                    ))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.red)
                }
            }

            Text(L10n("This will permanently delete the Worktree directory, its branch, and all changes unique to that branch. This action cannot be undone."))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.red)

            VStack(alignment: .leading, spacing: 8) {
                Text(L10n("Type the full branch name exactly as shown to confirm:"))
                    .font(.system(size: 11, weight: .medium))
                Text(branchName.isEmpty ? L10n("detached HEAD") : branchName)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 7))
                TextField(L10n("Full branch name"), text: $typedBranchName)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
            }

            HStack {
                Spacer()
                Button(L10n("Cancel"), action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button(L10n("Permanently Delete Worktree"), role: .destructive) {
                    onConfirm(typedBranchName)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(branchName.isEmpty || typedBranchName != branchName)
            }
        }
        .padding(20)
        .frame(width: 520)
    }
}

private struct WorktreeCommitReviewView: View {
    @EnvironmentObject private var backendClient: BackendClient
    let prompt: WorktreeCommitReviewPrompt
    @State private var decision = "include"
    @State private var neverRemind = false
    @State private var commitMessage = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(CorptiePalette.amber)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n("Review Commit"))
                        .font(.system(size: 18, weight: .bold))
                    Text(prompt.worktree.branchName ?? L10n("detached HEAD"))
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
            }

            Text(operationSummary)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(CorptiePalette.secondaryText)

            CommitMessageEditor(
                message: $commitMessage,
                isGenerating: backendClient.isGeneratingWorktreeCommitMessage,
                helpText: L10n("Enter your own message or generate one with Agent, then edit it before continuing."),
                generate: { await backendClient.generateWorktreeCommitMessage() }
            )

            if prompt.protection.requiresDecision {
                PrivateAgentFilesDecisionView(
                    protection: prompt.protection,
                    decision: $decision,
                    neverRemind: $neverRemind
                )
            }

            HStack {
                Spacer()
                Button(L10n("Cancel")) {
                    backendClient.cancelProtectedWorktreeCommit()
                }
                .keyboardShortcut(.cancelAction)
                Button(confirmButtonLabel) {
                    backendClient.confirmProtectedWorktreeCommit(
                        commitMessage: commitMessage.trimmingCharacters(in: .whitespacesAndNewlines),
                        decision: decision,
                        neverRemindPrivateFiles: neverRemind
                    )
                }
                .keyboardShortcut(.defaultAction)
                .disabled(
                    backendClient.isGeneratingWorktreeCommitMessage
                        || commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            }
        }
        .padding(20)
        .frame(width: 560)
    }

    private var operationSummary: String {
        switch prompt.operation {
        case .commit: L10n("The changes will be committed to this Worktree only. No remote push is performed.")
        case .merge: L10n("The changes will be committed and then merged into main. No remote push is performed.")
        case .complete: L10n("The changes will be committed before completing the Worktree operation. No remote push is performed.")
        case .operate: L10n("The changes will be committed before running the selected Worktree operations. No remote push is performed.")
        }
    }

    private var confirmButtonLabel: String {
        switch prompt.operation {
        case .commit: L10n("Commit Changes")
        case .merge: L10n("Commit and Merge")
        case .complete, .operate: L10n("Commit and Continue")
        }
    }
}

private struct PrivateAgentFilesDecisionView: View {
    let protection: GitCommitProtectionStatus
    @Binding var decision: String
    @Binding var neverRemind: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(L10n("Detected these local Agent files:"))
                .font(.system(size: 12, weight: .semibold))
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(protection.protectedPaths, id: \.self) { path in
                        Label {
                            Text(path)
                                .font(.system(size: 10.5, design: .monospaced))
                        } icon: {
                            Image(systemName: "doc.fill")
                                .font(.system(size: 9))
                                .foregroundStyle(CorptiePalette.amber)
                        }
                        .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(
                height: min(
                    max(CGFloat(protection.protectedPaths.count) * 18, 36),
                    105
                )
            )
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 6))

            Picker("", selection: $decision) {
                Text(L10n("Add matching paths to the project .gitignore")).tag("ignore")
                Text(L10n("Include these files in the commit")).tag("include")
            }
            .pickerStyle(.radioGroup)
            .labelsHidden()

            Toggle(L10n("Do not remind me again for this project"), isOn: $neverRemind)
                .font(.system(size: 11, weight: .medium))

            if decision == "ignore" {
                Text(L10n("Corptie will append only the matching root paths to the project .gitignore. Existing rules will be preserved."))
                    .font(.system(size: 10.5))
                    .foregroundStyle(CorptiePalette.secondaryText)
            } else {
                Text(L10n("These files may be stored in Git history and included in a GitHub push."))
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(CorptiePalette.amber)
            }
        }
        .padding(12)
        .background(CorptiePalette.amber.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(CorptiePalette.amber.opacity(0.24), lineWidth: 0.75)
        )
    }
}

private struct ProjectWorktreeOperationView: View {
    let worktree: ProjectWorktreeStatus
    let status: ProjectWorktreeStatusResponse
    let onExecute: (Bool, Bool, Bool, Bool, Bool) -> Void
    let onCancel: () -> Void

    @State private var mergeIntoMain: Bool
    @State private var synchronizeWithMain: Bool
    @State private var deleteWorktree = false
    @State private var deleteSessions = false
    @State private var restartService: Bool

    init(
        worktree: ProjectWorktreeStatus,
        status: ProjectWorktreeStatusResponse,
        onExecute: @escaping (Bool, Bool, Bool, Bool, Bool) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.worktree = worktree
        self.status = status
        self.onExecute = onExecute
        self.onCancel = onCancel
        let needsMerge = worktree.dirty == true || worktree.mergedIntoMain != true
        _mergeIntoMain = State(initialValue: needsMerge)
        _synchronizeWithMain = State(initialValue: worktree.synchronizedWithMain != true)
        _restartService = State(initialValue: false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("Worktree Operations"))
                    .font(.system(size: 17, weight: .bold))
                Text(worktree.branchName ?? L10n("detached HEAD"))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(CorptiePalette.secondaryText)
            }

            VStack(alignment: .leading, spacing: 12) {
                Toggle(L10n("Merge into main"), isOn: $mergeIntoMain)
                    .disabled(deleteWorktree || mergeIsUnnecessary)
                Toggle(L10n("Synchronize with main"), isOn: $synchronizeWithMain)
                    .disabled(deleteWorktree || worktree.synchronizedWithMain == true)
                Toggle(L10n("Delete this Worktree"), isOn: $deleteWorktree)
                Toggle(L10nFormat("Delete %d associated sessions", worktree.sessions.count), isOn: $deleteSessions)
                    .disabled(worktree.sessions.isEmpty)
                Toggle(L10n("Restart service"), isOn: $restartService)
            }
            .toggleStyle(.checkbox)

            if deleteWorktree && !worktree.sessions.isEmpty && !deleteSessions {
                Text(L10n("Deleting this Worktree also requires deleting its associated sessions."))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.amber)
            } else {
                Text(L10n("Operations run in the displayed order. Service restart always runs last. No remote push is performed."))
                    .font(.system(size: 11))
                    .foregroundStyle(CorptiePalette.secondaryText)
            }

            Spacer()
            HStack {
                Spacer()
                Button(L10n("Cancel"), action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button(L10n("Execute")) {
                    onExecute(
                        mergeIntoMain,
                        synchronizeWithMain,
                        deleteWorktree,
                        deleteSessions,
                        restartService
                    )
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canExecute)
            }
        }
        .padding(20)
        .frame(width: 430, height: 350)
        .onChange(of: deleteWorktree) { _, selected in
            if selected {
                mergeIntoMain = false
                synchronizeWithMain = false
            }
        }
        .onChange(of: mergeIntoMain) { _, selected in
            if selected { deleteWorktree = false }
        }
        .onChange(of: synchronizeWithMain) { _, selected in
            if selected {
                deleteWorktree = false
                if worktree.mergedIntoMain != true || worktree.dirty == true {
                    mergeIntoMain = true
                }
            }
        }
    }

    private var mergeIsUnnecessary: Bool {
        worktree.mergedIntoMain == true && worktree.dirty != true
    }

    private var canExecute: Bool {
        let hasSelection = mergeIntoMain
            || synchronizeWithMain
            || deleteWorktree
            || deleteSessions
            || restartService
        let canDelete = !deleteWorktree || worktree.sessions.isEmpty || deleteSessions
        return hasSelection && canDelete
    }
}

private struct GitBranchStamp: View {
    let headState: GitHeadState

    var body: some View {
        Text(headState.stampText ?? "")
            .font(.system(size: 7.5, weight: .bold, design: .monospaced))
            .foregroundStyle(headState.isWarning ? CorptiePalette.amber : Color.white)
            .lineLimit(1)
            .truncationMode(.middle)
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .background(
                headState.isWarning ? CorptiePalette.amber.opacity(0.12) : Color.black.opacity(0.34),
                in: RoundedRectangle(cornerRadius: 3, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .strokeBorder(
                        headState.isWarning ? CorptiePalette.amber.opacity(0.8) : Color.white.opacity(0.78),
                        lineWidth: 0.75
                    )
            }
            .help(headState.helpText ?? "")
            .accessibilityLabel(headState.helpText ?? "")
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

struct ThreadMetaView: View {
    @EnvironmentObject private var backendClient: BackendClient
    let status: TaskStatus
    let isConnecting: Bool
    let connectionColor: Color
    let activityStatus: String?

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 5) {
                ConnectionIndicatorLight(
                    color: isConnecting ? CorptiePalette.disconnected : connectionColor,
                    size: 5,
                    glowSize: 10,
                    isBreathing: isConnecting
                )
                Text(status.label)
                    .foregroundStyle(status.color)
                if let sessionId = backendClient.selectedSession?.id,
                   let restartActivity = backendClient.restartActivityBySessionId[sessionId] {
                    ActivityStatusText(
                        text: restartActivity.text,
                        isActive: restartActivity.isActive,
                        fontSize: 9
                    )
                        .layoutPriority(-1)
                } else if let activityStatus, !activityStatus.isEmpty {
                    ActivityStatusText(
                        text: activityStatus,
                        isActive: status == .running,
                        fontSize: 9
                    )
                        .layoutPriority(-1)
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

@discardableResult
private func copySessionNameToPasteboard(_ rawName: String?) -> Bool {
    guard let name = rawName?.trimmingCharacters(in: .whitespacesAndNewlines),
          !name.isEmpty else {
        return false
    }
    NSPasteboard.general.clearContents()
    return NSPasteboard.general.setString(name, forType: .string)
}

private struct ThreadProcessGroupView: View {
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    let items: [CodexThreadItem]
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                // The owning timeline decides whether this state change is
                // animated. AppKit-hosted rows must not start a nested SwiftUI
                // transition while NSTableView is updating row geometry.
                onToggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .frame(width: 12, height: 12)
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(CorptiePalette.mutedText.opacity(0.72))
                    Text(L10n("Execution process"))
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
                .frame(height: 26)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)

            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(items) { item in
                        ProcessMiniCard(item: item)
                            .transition(.asymmetric(
                                insertion: .move(edge: .bottom).combined(with: .opacity),
                                removal: .identity
                            ))
                    }
                }
                .padding(.leading, 22)
                .padding(.top, 2)
                .clipped()
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, isExpanded ? 8 : 4)
        .background(processBubbleBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.black.opacity(isLiquidGlass ? 0.06 : 0.08), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(isLiquidGlass ? 0.035 : 0), radius: 7, y: 3)
        .frame(
            idealWidth: processBubbleWidth,
            maxWidth: processBubbleWidth,
            alignment: .leading
        )
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n("Execution process"))
    }

    private var processBubbleWidth: CGFloat {
        isExpanded
            ? ChatBubbleWidthPolicy.maximumWidth
            : ChatBubbleWidthPolicy.collapsedProcessWidth + ChatBubbleWidthPolicy.horizontalPadding
    }

    private var processBubbleBackground: Color {
        if isLiquidGlass {
            return Color.white.opacity(0.38)
        }
        return Color(nsColor: .controlBackgroundColor).opacity(0.72)
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
    @Environment(\.isLiquidGlass) private var isLiquidGlass
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
        .background(
            isLiquidGlass
                ? Color.white.opacity(0.34)
                : Color.clear,
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(
                    isLiquidGlass ? Color.black.opacity(0.045) : Color.clear,
                    lineWidth: 1
                )
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

struct ThreadItemView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    @State private var isActivityExpanded = false
    @State private var isCollaborationDetailsExpanded = false
    @State private var isHovering = false
    @State private var isConfirmingUndo = false
    @State private var isDiffActionRunning = false
    @State private var diffActionError: String?
    @State private var didCopySessionName = false
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
        DefaultInitialAvatarView(
            seed: name,
            initials: DefaultAvatarInitials.make(from: name),
            size: 20
        )
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
                HStack(spacing: 8) {
                    itemTitleView
                    if !isUserOrAgentMessage {
                        Spacer()
                    }
                    Text(itemMetadataLabel)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(CorptiePalette.mutedText)
                }

                if !item.text.isEmpty {
                    if item.type == "agentMessage" {
                        agentMessageTextView
                    } else {
                        messageTextView(text: item.text, allowsSelection: true, fillWidth: !isUserMessage)
                    }
                }

                if item.type == "choice",
                   item.status == "selected",
                   let selected = item.options?.first(where: { $0.selected == true }) {
                    Label(L10nFormat("Selected: %@", selected.label), systemImage: "checkmark.circle.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(CorptiePalette.connected)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(CorptiePalette.connected.opacity(0.10), in: Capsule())
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
        // 气泡本身采用共享策略算出的明确内容宽度；外层 frame 只负责左右定位。
        // 不能用 maxWidth 模拟 CSS w-fit：Markdown 会接受宽度提议并把短消息撑到上限。
        .background(itemBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(itemBorder, lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(isLiquidGlass ? 0.04 : 0), radius: isLiquidGlass ? 8 : 0, y: isLiquidGlass ? 3 : 0)
        .frame(
            idealWidth: isUserOrAgentMessage ? preferredMessageBubbleWidth : nil,
            maxWidth: isUserOrAgentMessage ? preferredMessageBubbleWidth : .infinity,
            alignment: isUserMessage ? .trailing : .leading
        )
        .frame(
            maxWidth: .infinity,
            alignment: isUserMessage ? .trailing : .leading
        )
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

    @ViewBuilder
    private var itemTitleView: some View {
        if item.type == "agentMessage" {
            Button(action: copySelectedSessionName) {
                HStack(spacing: 4) {
                    Text(item.title)
                    if didCopySessionName {
                        Image(systemName: "checkmark")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(CorptiePalette.connected)
                            .transition(.opacity.combined(with: .scale))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(L10n("Copy session name"))
            .accessibilityLabel(L10n("Copy session name"))
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(itemColor)
        } else {
            Text(item.title)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(itemColor)
        }
    }

    private func copySelectedSessionName() {
        guard copySessionNameToPasteboard(backendClient.selectedSession?.title) else {
            return
        }
        withAnimation(.easeOut(duration: 0.12)) {
            didCopySessionName = true
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 900_000_000)
            withAnimation(.easeOut(duration: 0.12)) {
                didCopySessionName = false
            }
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
        guard let sessionId = backendClient.selectedDetail?.id else { return }
        isDiffActionRunning = true
        Task {
            defer { isDiffActionRunning = false }
            if case .failure(let error) = await backendClient.reviewTurnChanges(sessionId: sessionId, turnId: item.turnId) {
                diffActionError = error.localizedDescription
            }
        }
    }

    private func undoChanges() {
        guard let sessionId = backendClient.selectedDetail?.id else { return }
        isDiffActionRunning = true
        Task {
            defer { isDiffActionRunning = false }
            if case .failure(let error) = await backendClient.undoTurnChanges(sessionId: sessionId, turnId: item.turnId) {
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

    private var isUserMessage: Bool { item.type == "userMessage" }
    private var isAgentMessage: Bool { item.type == "agentMessage" }
    private var isUserOrAgentMessage: Bool { isUserMessage || isAgentMessage }
    /// 消息气泡最大宽度，保留左右留白。
    private var messageBubbleMaxWidth: CGFloat { ChatBubbleWidthPolicy.maximumWidth }

    private var preferredMessageBubbleWidth: CGFloat {
        let style: AppKitChatTimelineRow.NativeStyle = isUserMessage ? .user : .agent
        let measurementText: String
        if isAgentMessage {
            let parsed = AgentMessageParts.parse(item.text)
            measurementText = parsed.body.isEmpty ? item.text : parsed.body
        } else {
            measurementText = item.text
        }
        return ChatBubbleWidthPolicy.preferredWidth(
            text: measurementText,
            style: style,
            title: item.title,
            metadata: itemMetadataLabel
        )
    }

    private var itemBackground: Color {
        // 协作卡统一淡底
        if isCollaborationItem {
            return CorptiePalette.collaborationSurface
        }
        // 会话页（Sessions Tab）：用户消息右侧、Agent 消息左侧的气泡
        if !isLiquidGlass {
            if item.type == "userMessage" {
                return CorptiePalette.softBlue.opacity(0.16)
            }
            if item.type == "agentMessage" {
                return Color(nsColor: .controlBackgroundColor).opacity(0.72)
            }
            if item.type == "approval" || item.type == "choice" {
                return Color(nsColor: NSColor(calibratedRed: 1.0, green: 0.98, blue: 0.91, alpha: 1))
            }
            return Color.clear
        }
        return item.type == "approval" || item.type == "choice" ? Color(nsColor: NSColor(calibratedRed: 1.0, green: 0.98, blue: 0.91, alpha: 1)) : Color.white
    }

    private var itemBorder: Color {
        if isCollaborationItem {
            return CorptiePalette.collaborationBorder.opacity(0.62)
        }
        // 会话页：用户/Agent 消息气泡的细边框
        if !isLiquidGlass {
            if item.type == "userMessage" {
                return CorptiePalette.softBlue.opacity(0.18)
            }
            if item.type == "agentMessage" {
                return Color(nsColor: .separatorColor).opacity(0.55)
            }
            if item.type == "approval" || item.type == "choice" {
                return CorptiePalette.amber.opacity(0.32)
            }
            return Color.clear
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
            messageTextView(text: parsed.body, allowsSelection: true, fillWidth: false)
        }
    }

    @ViewBuilder
    private func messageTextView(text: String, allowsSelection: Bool, fillWidth: Bool = true) -> some View {
        MarkdownMessageView(
            text: text,
            baseDirectory: backendClient.selectedDetail?.cwd,
            allowsSelection: allowsSelection,
            fillWidth: fillWidth,
            maxContentWidth: fillWidth ? nil : (messageBubbleMaxWidth - 20)
        )
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

struct MessageComposer: View {
    @EnvironmentObject private var backendClient: BackendClient
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    let sessionId: String
    let draftRepository: ComposerDraftRepository
    @FocusState private var isFocused: Bool
    @State private var composerWidth: CGFloat = 0
    @State private var editorController: ComposerEditorController
    @State private var hasSendableText: Bool

    init(sessionId: String, draftRepository: ComposerDraftRepository) {
        self.sessionId = sessionId
        self.draftRepository = draftRepository
        let draft = draftRepository.draft(for: sessionId)
        _editorController = State(initialValue: ComposerEditorController(draft: draft))
        _hasSendableText = State(initialValue: draft.hasSendableText)
    }

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 2) {
                ComposerInputTextView(
                    controller: editorController,
                    placeholder: "Send a instruction",
                    font: .systemFont(ofSize: 12, weight: .medium),
                    onFocusChange: { isFocused = $0 },
                    onSendableTextChange: { nextValue in
                        if hasSendableText != nextValue {
                            hasSendableText = nextValue
                        }
                    },
                    onSubmit: send
                )
                    .frame(height: 32)
                    .padding(.leading, 10)
                    .padding(.trailing, 2)
                    .onTapGesture {
                        isFocused = true
                    }
                    .disabled(false)

                if isRunningTurn {
                    Button {
                        backendClient.interruptSelectedSession()
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 9, weight: .bold))
                            .frame(width: 24, height: 24)
                            .background { ComposerGlassActionBackground(tint: .red) }
                            .frame(width: 28, height: 28)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.red)
                    .help(L10n("Stop current run"))
                }

                Button {
                    sendCurrentDraft()
                } label: {
                    Group {
                        if backendClient.isSendingMessage {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "paperplane.fill")
                                .font(.system(size: 10, weight: .bold))
                        }
                    }
                    .frame(width: 24, height: 24)
                    .background { ComposerGlassActionBackground(tint: CorptiePalette.softBlue) }
                    .frame(width: 28, height: 28)
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(CorptiePalette.softBlue)
                .disabled(isSendDisabled)
                .help(L10n("Send instruction"))
                .padding(.trailing, 4)
            }
            .background(
                isLiquidGlass ? Color.white : Color(nsColor: .textBackgroundColor),
                in: RoundedRectangle(cornerRadius: 13, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .strokeBorder(
                        isLiquidGlass
                            ? Color.black.opacity(isFocused ? 0.16 : 0.08)
                            : Color(nsColor: .separatorColor).opacity(isFocused ? 0.9 : 0.5),
                        lineWidth: 1
                    )
            )
            .shadow(
                color: Color.black.opacity(isLiquidGlass ? 0.04 : 0),
                radius: isLiquidGlass ? 8 : 0,
                y: isLiquidGlass ? 3 : 0
            )

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

    private func sendCurrentDraft() {
        guard let submission = editorController.submission() else {
            return
        }
        send(submission)
    }

    private func send(_ submission: ComposerDraftBuffer.Submission) {
        guard backendClient.selectedDetail?.canSend != false,
              !backendClient.isSendingMessage else {
            return
        }
        backendClient.sendMessage(submission.text) {
            if editorController.clear(ifUnchangedSince: submission) {
                hasSendableText = false
            }
        }
    }

    private var isRunningTurn: Bool {
        backendClient.selectedDetail?.status == .running
            && backendClient.selectedDetail?.canInterruptNow == true
    }

    private var isSendDisabled: Bool {
        return !hasSendableText
            || backendClient.isSendingMessage
            || backendClient.selectedDetail?.canSend == false
    }

    private var canSwitchModel: Bool {
        backendClient.selectedDetail?.actions?.switchModel.available
            ?? backendClient.selectedSession?.actions?.switchModel.available
            ?? backendClient.selectedDetail?.capabilities?.canSwitchModel
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

private struct ComposerGlassActionBackground: View {
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    let tint: Color

    var body: some View {
        if !isLiquidGlass {
            // 原生降级：简洁圆按钮
            Circle()
                .fill(tint.opacity(0.14))
        } else if #available(macOS 26.0, *) {
            Circle()
                .fill(.clear)
                .glassEffect(.clear.tint(tint.opacity(0.11)), in: .circle)
                .overlay {
                    Circle()
                        .strokeBorder(Color.white.opacity(0.18), lineWidth: 0.6)
                }
                .overlay {
                    Circle()
                        .strokeBorder(tint.opacity(0.2), lineWidth: 0.6)
                }
        } else {
            Circle()
                .fill(.ultraThinMaterial)
                .overlay {
                    Circle()
                        .fill(tint.opacity(0.07))
                }
                .overlay {
                    Circle()
                        .strokeBorder(tint.opacity(0.2), lineWidth: 0.6)
                }
        }
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
                Text(ModelMenuLabel.compact(currentModelLabel))
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
            ?? backendClient.codexDefaultReasoningLevel
            ?? currentModel?.defaultReasoningLevel
            ?? "medium"
    }

    private var currentReasoningLevels: [String] {
        guard supportsReasoningSwitch else {
            return []
        }
        return currentModel?.reasoningLevels ?? []
    }

    private var supportsReasoningSwitch: Bool {
        backendClient.selectedDetail?.actions?.switchReasoning.available
            ?? backendClient.selectedSession?.actions?.switchReasoning.available
            ?? backendClient.selectedDetail?.capabilities?.canSwitchReasoning
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

enum ModelMenuLabel {
    static let maximumCharacterCount = 15

    static func compact(_ value: String) -> String {
        guard value.count > maximumCharacterCount else {
            return value
        }
        return String(value.prefix(maximumCharacterCount - 1)) + "…"
    }
}

private struct ComposerInputTextView: NSViewRepresentable {
    let controller: ComposerEditorController
    let placeholder: String
    let font: NSFont
    var textInsetHeight: CGFloat = 6
    var onFocusChange: (Bool) -> Void = { _ in }
    var onSendableTextChange: (Bool) -> Void = { _ in }
    let onSubmit: (ComposerDraftBuffer.Submission) -> Void

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.borderType = .noBorder
        scrollView.automaticallyAdjustsContentInsets = false
        scrollView.contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)

        let textView = ComposerSubmitTextView()
        textView.delegate = context.coordinator
        textView.placeholder = placeholder
        textView.font = font
        textView.drawsBackground = false
        textView.isRichText = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainerInset = NSSize(width: 0, height: textInsetHeight)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.autoresizingMask = [.width]
        textView.string = controller.draft.text
        textView.onFocusChange = onFocusChange
        textView.onSubmit = context.coordinator.submit

        scrollView.documentView = textView
        controller.attach(textView)
        context.coordinator.attach(textView)
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? ComposerSubmitTextView else {
            return
        }
        context.coordinator.update(
            controller: controller,
            onFocusChange: onFocusChange,
            onSendableTextChange: onSendableTextChange,
            onSubmit: onSubmit
        )
        textView.placeholder = placeholder
        textView.font = font
        textView.textContainerInset = NSSize(width: 0, height: textInsetHeight)
        textView.onFocusChange = onFocusChange
        textView.onSubmit = context.coordinator.submit
        controller.attach(textView)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            controller: controller,
            onFocusChange: onFocusChange,
            onSendableTextChange: onSendableTextChange,
            onSubmit: onSubmit
        )
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        private var controller: ComposerEditorController
        private var onFocusChange: (Bool) -> Void
        private var onSendableTextChange: (Bool) -> Void
        private var onSubmit: (ComposerDraftBuffer.Submission) -> Void
        private var lastSendableState: Bool

        init(
            controller: ComposerEditorController,
            onFocusChange: @escaping (Bool) -> Void,
            onSendableTextChange: @escaping (Bool) -> Void,
            onSubmit: @escaping (ComposerDraftBuffer.Submission) -> Void
        ) {
            self.controller = controller
            self.onFocusChange = onFocusChange
            self.onSendableTextChange = onSendableTextChange
            self.onSubmit = onSubmit
            lastSendableState = controller.draft.hasSendableText
        }

        func attach(_ textView: ComposerSubmitTextView) {
            textView.onFocusChange = onFocusChange
            textView.onSubmit = submit
        }

        func update(
            controller: ComposerEditorController,
            onFocusChange: @escaping (Bool) -> Void,
            onSendableTextChange: @escaping (Bool) -> Void,
            onSubmit: @escaping (ComposerDraftBuffer.Submission) -> Void
        ) {
            self.controller = controller
            self.onFocusChange = onFocusChange
            self.onSendableTextChange = onSendableTextChange
            self.onSubmit = onSubmit
            lastSendableState = controller.draft.hasSendableText
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else {
                return
            }
            controller.recordEditorText(textView.string)
            let nextSendableState = controller.draft.hasSendableText
            guard nextSendableState != lastSendableState else {
                return
            }
            lastSendableState = nextSendableState
            onSendableTextChange(nextSendableState)
        }

        func submit() {
            guard let submission = controller.submission() else {
                return
            }
            onSubmit(submission)
        }
    }

    final class ComposerSubmitTextView: NSTextView {
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
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.primary)
            .background(
                isLiquidGlass
                    ? Color.white.opacity(configuration.isPressed ? 0.24 : 0.13)
                    : Color(nsColor: .controlBackgroundColor),
                in: Circle()
            )
            .overlay(
                Circle().strokeBorder(
                    isLiquidGlass
                        ? Color.white.opacity(0.16)
                        : Color(nsColor: .separatorColor).opacity(0.6),
                    lineWidth: 1
                )
            )
            .contentShape(Circle())
    }
}
