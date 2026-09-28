import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
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
    @ObservedObject private var sessionCreationState = BackendClient.shared.sessionCreationController
    @EnvironmentObject private var sessionIndexStore: SessionIndexStore
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
    @ObservedObject private var presentationCache = SessionPresentationCache.shared
    @ObservedObject private var viewportController = SessionViewportController.shared
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
                        presentationCache: presentationCache,
                        composerDraftRepository: composerDraftRepository,
                        initialTimelinePosition: viewportController.position(for: selectedSession.id),
                        onTimelinePositionChange: { position in
                            viewportController.store(position, for: selectedSession.id)
                        }
                    )
                    .onAppear {
                        viewportController.hydrate(selectedSession.id)
                    }
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

            if sessionIndexStore.orderedIDs.isEmpty {
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
                ForEach(sessionIndexStore.rows) { row in
                    DetailSessionRailRow(
                        row: row,
                        selectedSessionID: backendClient.selectedSession?.id,
                        select: { session in
                            backendClient.select(session: session, focusComposer: true)
                        }
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
        let matchingRows = query.isEmpty ? sessionIndexStore.rows : sessionIndexStore.rows.filter { row in
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
                        showsProjectName: !groupsSessionsByProject
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
