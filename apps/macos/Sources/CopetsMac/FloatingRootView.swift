import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct FloatingRootView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @EnvironmentObject private var panelLayoutState: PanelLayoutState
    @EnvironmentObject private var detachedSessionManager: DetachedSessionManager
    @AppStorage("floatingPanelTransparency", store: CopetsAppEnvironment.userDefaults) private var panelTransparency = 0.45
    @Namespace private var taskNavigationNamespace
    @StateObject private var newSessionPanel = NewSessionPanelController()
    @State private var isShowingActionMenu = false
    @State private var draggedSessionId: String?
    @State private var sessionCardFrames: [String: CGRect] = [:]
    @State private var reorderStartFrames: [String: CGRect] = [:]

    var body: some View {
        ZStack {
            LiquidGlassPanelBackground(cornerRadius: 26)
            WindowDragArea()
                .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))

            VStack(alignment: .leading, spacing: 14) {
                if let selectedSession = backendClient.selectedSession {
                    DetailView(namespace: taskNavigationNamespace, sessionId: selectedSession.id)
                        .transition(.asymmetric(
                            insertion: .scale(scale: 0.94, anchor: .center).combined(with: .opacity),
                            removal: .scale(scale: 0.98, anchor: .center).combined(with: .opacity)
                        ))
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
                    .transition(.asymmetric(
                        insertion: .scale(scale: 0.98, anchor: .center).combined(with: .opacity),
                        removal: .scale(scale: 0.94, anchor: .center).combined(with: .opacity)
                    ))
                }
            }
            .padding(18)

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
                .padding(14)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                .zIndex(1)
            }

            MainPanelCloseButton()
                .padding(.top, 13)
                .padding(.leading, 13)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .zIndex(3)
        }
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .animation(.spring(response: 0.34, dampingFraction: 0.86), value: backendClient.selectedSession?.id)
        .animation(.spring(response: 0.28, dampingFraction: 0.88), value: newSessionPanel.isPresented)
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12 + 0.1 * glassStrength), lineWidth: 1)
        )
        .overlay(alignment: .topTrailing) {
            if CopetsAppEnvironment.isDevelopment {
                EnvironmentModeBadge()
                    .padding(.top, 10)
                    .padding(.trailing, 10)
                    .zIndex(4)
            }
        }
        .frame(minWidth: 360, idealWidth: 420, maxWidth: .infinity, minHeight: 158, idealHeight: 410, maxHeight: .infinity)
        .onChange(of: backendClient.selectedSession?.id) { _, _ in
            isShowingActionMenu = false
            newSessionPanel.close()
        }
    }

    private var glassStrength: Double {
        max(0.2, 1.0 - panelTransparency)
    }

    private var sessionListView: some View {
        NativeSessionScrollView {
            LazyVStack(spacing: PanelLayoutState.cardSpacing) {
                ForEach(backendClient.sessions) { session in
                    sessionCard(for: session)
                }
            }
            .animation(.spring(response: 0.30, dampingFraction: 0.84), value: backendClient.sessions.map(\.id))
            .padding(.horizontal, 6)
            .padding(.bottom, 4)
            .measureListHeight(.cards)
            .coordinateSpace(name: "session-list")
        }
        .onPreferenceChange(SessionCardFramePreferenceKey.self) { frames in
            sessionCardFrames = frames
            updateMeasuredListHeights(cardFrames: frames)
        }
        .onChange(of: backendClient.sessions) { _, _ in
            updateMeasuredListHeights(cardFrames: sessionCardFrames)
        }
        .onChange(of: backendClient.selectedSession?.id) { _, _ in
            updateMeasuredListHeights(cardFrames: sessionCardFrames)
        }
    }

    @ViewBuilder
    private func sessionCard(for session: TaskSession) -> some View {
        if backendClient.isShowingArchivedSessions {
            TaskCardView(session: session, namespace: taskNavigationNamespace)
        } else {
            TaskCardView(session: session, namespace: taskNavigationNamespace)
                .opacity(draggedSessionId == session.id ? 0.82 : 1)
                .scaleEffect(draggedSessionId == session.id ? 1.015 : 1)
                .shadow(
                    color: Color.black.opacity(draggedSessionId == session.id ? 0.18 : 0),
                    radius: draggedSessionId == session.id ? 14 : 0,
                    y: draggedSessionId == session.id ? 8 : 0
                )
                .measureSessionCardFrame(session.id)
                .gesture(reorderGesture(for: session))
                .animation(.spring(response: 0.28, dampingFraction: 0.82), value: backendClient.sessions.map(\.id))
                .animation(.spring(response: 0.20, dampingFraction: 0.78), value: draggedSessionId)
        }
    }

    private func updatePreferredListHeight(_ values: [ListHeightMetric: CGFloat]) {
        let cardsHeight = values[.cards] ?? 0
        guard cardsHeight > 0 else {
            return
        }

        let outerPadding: CGFloat = 36
        let bottomBreathingRoom: CGFloat = 8
        let usefulHeight = outerPadding + cardsHeight + bottomBreathingRoom

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

        let outerPadding: CGFloat = 36
        let bottomBreathingRoom: CGFloat = 8
        let minimumHeight = outerPadding + (visibleHeights.first ?? PanelLayoutState.cardHeight) + bottomBreathingRoom
        let visibleSpacing = CGFloat(max(0, visibleHeights.count - 1)) * PanelLayoutState.cardSpacing
        let preferredHeight = outerPadding + visibleHeights.reduce(0, +) + visibleSpacing + bottomBreathingRoom

        DispatchQueue.main.async {
            panelLayoutState.updateMeasuredListHeights(minimum: minimumHeight, preferred: preferredHeight, useful: nil)
        }
    }

    private func reorderGesture(for session: TaskSession) -> some Gesture {
        DragGesture(minimumDistance: 7, coordinateSpace: .named("session-list"))
            .onChanged { value in
                if draggedSessionId != session.id {
                    reorderStartFrames = sessionCardFrames
                }
                draggedSessionId = session.id
                guard let startFrame = reorderStartFrames[session.id] ?? sessionCardFrames[session.id] else {
                    return
                }
                let projectedCenterY = startFrame.midY + value.translation.height

                withAnimation(.spring(response: 0.30, dampingFraction: 0.84)) {
                    backendClient.moveSession(draggedSessionId: session.id, before: targetSessionId(forProjectedCenterY: projectedCenterY, excluding: session.id))
                }
            }
            .onEnded { _ in
                backendClient.persistSessionOrder()
                withAnimation(.spring(response: 0.24, dampingFraction: 0.86)) {
                    draggedSessionId = nil
                    reorderStartFrames = [:]
                }
            }
    }

    private func targetSessionId(forProjectedCenterY centerY: CGFloat, excluding draggedId: String) -> String? {
        let candidates = reorderStartFrames
            .filter { $0.key != draggedId }
            .sorted { $0.value.midY < $1.value.midY }

        for candidate in candidates {
            if centerY < candidate.value.midY {
                return candidate.key
            }
        }
        return nil
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
        CopetsAppEnvironment.displayName
    }

    private var modeIcon: String {
        CopetsAppEnvironment.isDevelopment ? "hammer.fill" : "sparkles"
    }

    private var modeColor: Color {
        CopetsAppEnvironment.isDevelopment ? CopetsPalette.amber : CopetsPalette.softBlue
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
        .help("Environment: \(modeLabel) (\(CopetsAppEnvironment.backendPort))")
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

private struct LastMessageHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
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

        let hostingView = NSHostingView(rootView: content)
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
            hostingView.rootView = content
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
                    .fill(isFocused ? CopetsPalette.glassVeilFocused : CopetsPalette.glassVeilIdle)
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
        let size = NSSize(width: 420, height: 560)
        let origin = NSPoint(
            x: parentFrame.midX - size.width / 2,
            y: max(80, parentFrame.midY - size.height / 2)
        )
        let nextPanel = NSPanel(
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
        nextPanel.isMovableByWindowBackground = true
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
        .foregroundStyle(CopetsPalette.primaryText)
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
            .foregroundStyle(CopetsPalette.primaryText)
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
    @State private var title = ""
    @State private var command = "codex"
    @State private var arguments = ""
    @State private var existingSessionId = ""
    @State private var cwd = ""
    @State private var sandboxMode = "workspace-write"
    @State private var approvalPolicy = "on-request"
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
                        .foregroundStyle(isBindingExistingSession ? CopetsPalette.mutedText : CopetsPalette.primaryText)

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
                            .foregroundStyle(sessionLookupMessage?.hasPrefix("Session not found") == true ? .red : CopetsPalette.secondaryText)
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
            .foregroundStyle(CopetsPalette.secondaryText)
            .help(isShowingAdvanced ? "Hide advanced settings" : "Show advanced settings")

            if isShowingAdvanced {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text("Title")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(Color.black)
                        TextField("Background agent task", text: $title)
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
                            .help("Enter an existing Codex session id to resume it in Copets")
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
                            .foregroundStyle(CopetsPalette.amber)
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
        }
        .onDisappear {
            sessionLookupTask?.cancel()
        }
    }

    private func selectAgent(_ preset: AgentPreset) {
        command = preset.command
        arguments = preset.arguments
    }

    private func startSelectedAgent() {
        let finalTitle = title.isEmpty ? "" : title
        let workspace = cwd.isEmpty ? backendClient.defaultWorkspacePath : cwd
        if command.trimmingCharacters(in: .whitespacesAndNewlines) == "codex" {
            backendClient.createCodexPtyTask(
                title: finalTitle,
                prompt: "",
                cwd: workspace,
                existingSessionId: existingSessionId,
                sandbox: sandboxMode,
                approvalPolicy: approvalPolicy
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
        .foregroundStyle(isSelected ? Color.black : CopetsPalette.primaryText)
        .background(isSelected ? CopetsPalette.softBlue.opacity(0.72) : Color.white.opacity(isDisabled ? 0.07 : 0.13), in: Capsule())
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
                        .fill(CopetsPalette.glassVeilFocused)
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
    @AppStorage("floatingPanelTransparency", store: CopetsAppEnvironment.userDefaults) private var panelTransparency = 0.45
    @State private var quickReply = ""
    @State private var lastQuickReplyInteractionAt = Date.distantPast
    @State private var isRenaming = false
    @State private var isShowingUnboundHint = false
    @FocusState private var isQuickReplyFocused: Bool

    let session: TaskSession
    let namespace: Namespace.ID

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
                        .foregroundStyle(CopetsPalette.amber)
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
                .foregroundStyle(CopetsPalette.cardPreviewText)
                .lineLimit(1)
                .truncationMode(.tail)

            HStack(spacing: 10) {
                Text(session.agent)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CopetsPalette.secondaryText)
                    .lineLimit(1)

                if let activityStatus = session.activityStatus,
                   !activityStatus.isEmpty,
                   session.status == .running {
                    ActivityStatusText(text: activityStatus, isActive: true)
                        .font(.system(size: 11, weight: .semibold))
                }

                Text(relativeTime(session.updatedAt))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CopetsPalette.mutedText)
                    .lineLimit(1)

                if session.status == .running {
                    Spacer()

                    Button {
                        backendClient.interrupt(session: session)
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 9, weight: .bold))
                            .frame(width: 24, height: 24)
                    }
                    .buttonStyle(IconButtonStyle())
                    .help("Stop current run")
                } else if session.status == .blocked {
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
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(visibleSuggestedOptions) { option in
                        Button {
                            lastQuickReplyInteractionAt = Date()
                            backendClient.sendMessage(option.label, to: session)
                        } label: {
                            Label(option.label, systemImage: "arrow.turn.down.right")
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(CopetsPalette.primaryText)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 9)
                                .padding(.vertical, 6)
                        }
                        .buttonStyle(.plain)
                        .background(optionChipBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(CopetsPalette.amber.opacity(0.24), lineWidth: 1)
                        )
                        .help(option.label)
                    }
                }
                .padding(.top, 1)
            }
        }
        .padding(13)
        .frame(minHeight: PanelLayoutState.cardHeight)
        .background(
            LiquidGlassCardBackground(cornerRadius: 18, fillOpacity: cardFillOpacity)
                .matchedGeometryEffect(id: "task-card-\(session.id)", in: namespace)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.white.opacity(cardStrokeOpacity), lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onTapGesture {
            if Date().timeIntervalSince(lastQuickReplyInteractionAt) > 0.25 {
                withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                    backendClient.select(session: session)
                }
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
    }

    private var glassStrength: Double {
        max(0.2, 1.0 - panelTransparency)
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

    private var visibleSuggestedOptions: [CodexApprovalOption] {
        Array((session.suggestedOptions ?? []).prefix(5))
    }

    private var optionChipBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.12, alpha: 0.92)
                : NSColor(calibratedWhite: 1.0, alpha: 0.88)
        })
    }

    private var connectionIndicatorHelp: String {
        if session.isUnboundCodexSession {
            return "Session is not bound yet"
        }
        if session.isConnecting || backendClient.connectionTransitionSessionIds.contains(session.id) {
            return "Switching PTY connection"
        }
        return session.isConnected ? "Disconnect PTY" : "Reconnect PTY"
    }

    private var connectionIndicatorButton: some View {
        Button {
            lastQuickReplyInteractionAt = Date()
            if session.isUnboundCodexSession {
                isShowingUnboundHint = true
            } else {
                backendClient.togglePtyConnection(for: session)
            }
        } label: {
            let isTransitioning = session.isConnecting || backendClient.connectionTransitionSessionIds.contains(session.id)
            let lightColor = (session.isConnecting || (!session.isConnected && isTransitioning))
                ? CopetsPalette.disconnected
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
        .disabled(session.external?.provider != "codex-pty" || backendClient.connectionTransitionSessionIds.contains(session.id))
        .popover(isPresented: $isShowingUnboundHint, arrowEdge: .top) {
            Text("尚未发送消息的会话，无法切换状态。")
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
                                colors: [session.accent.color.opacity(0.92), CopetsPalette.softBlue.opacity(0.72)],
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
    @State private var message = ""
    let namespace: Namespace.ID
    let sessionId: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            DetailHeaderView()

            if backendClient.isLoadingDetail && backendClient.selectedDetail == nil {
                VStack(spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading Codex thread")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CopetsPalette.secondaryText)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let detail = backendClient.selectedDetail {
                ThreadMetaView(detail: detail)

                ScrollViewReader { proxy in
                    ScrollView(.vertical, showsIndicators: true) {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(detail.items) { item in
                                ThreadItemView(item: item)
                                    .id(item.id)
                                    .measureLastMessageHeight(isLast: item.id == detail.items.last?.id)
                            }
                        }
                        .padding(.bottom, 4)
                    }
                    .onAppear {
                        scrollToLatest(detail: detail, proxy: proxy)
                        if detail.items.isEmpty {
                            panelLayoutState.updateDetailLastMessageHeight(nil)
                        }
                    }
                    .onChange(of: detail.items.last?.id) { _, _ in
                        scrollToLatest(detail: detail, proxy: proxy)
                        if detail.items.isEmpty {
                            panelLayoutState.updateDetailLastMessageHeight(nil)
                        }
                    }
                    .onPreferenceChange(LastMessageHeightPreferenceKey.self) { height in
                        panelLayoutState.updateDetailLastMessageHeight(height > 0 ? height : nil)
                    }
                }
            } else {
                OfflineView(error: backendClient.lastError ?? "No detail is available for this task.")
            }

            if let sendStatusMessage = backendClient.sendStatusMessage,
               sendStatusMessage.hasPrefix("Send failed") || sendStatusMessage.contains("read-only") {
                Text(sendStatusMessage)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }

            if backendClient.selectedDetail?.canSend == false {
                ReadOnlyComposer(reason: backendClient.selectedDetail?.sendUnavailableReason)
            } else {
                MessageComposer(message: $message)
            }
        }
        .padding(1)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.white.opacity(0.001))
                .matchedGeometryEffect(id: "task-card-\(sessionId)", in: namespace)
        )
        .onDisappear {
            panelLayoutState.updateDetailLastMessageHeight(nil)
        }
    }

    private func scrollToLatest(detail: CodexThreadDetail, proxy: ScrollViewProxy) {
        guard let lastItem = detail.items.last else {
            return
        }

        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo(lastItem.id, anchor: .bottom)
            }
        }
    }
}

private struct DetailHeaderView: View {
    @EnvironmentObject private var backendClient: BackendClient

    var body: some View {
        HStack(spacing: 10) {
            Button {
                withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
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
                Text(backendClient.selectedDetail?.cwd ?? backendClient.selectedSession?.summary ?? "")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CopetsPalette.secondaryText)
                    .lineLimit(1)
            }

            Spacer()

            if backendClient.selectedDetail?.connectionStatus == "pty disconnected" {
                Button {
                    backendClient.reconnectSelectedSession()
                } label: {
                    Image(systemName: "link")
                        .font(.system(size: 11, weight: .bold))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(IconButtonStyle())
                .help("Reconnect PTY")
            } else if (backendClient.selectedSession?.external?.provider == "pty" || backendClient.selectedSession?.external?.provider == "codex-pty")
                && backendClient.selectedDetail?.canSend != false {
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

            Button {
                backendClient.loadSelectedDetail()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .bold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(IconButtonStyle())
            .help("Refresh thread")
        }
    }
}

private struct ThreadMetaView: View {
    let detail: CodexThreadDetail

    var body: some View {
        HStack(spacing: 8) {
            ConnectionIndicatorLight(
                color: detail.isConnecting ? CopetsPalette.disconnected : detail.connectionColor,
                size: 8,
                glowSize: 20,
                isBreathing: detail.isConnecting
            )
            Text(detail.status.label)
                .foregroundStyle(detail.status.color)
            if let activityStatus = detail.activityStatus, !activityStatus.isEmpty {
                ActivityStatusText(text: activityStatus, isActive: detail.status == .running)
            } else if let source = detail.source {
                Text(source)
            }
        }
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(CopetsPalette.secondaryText)
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
                CopetsPalette.connected,
                CopetsPalette.softBlue,
                CopetsPalette.periwinkle
            ],
            startPoint: .leading,
            endPoint: .trailing
        )
    }

    private var idleColor: Color {
        .secondary
    }
}

private struct ThreadItemView: View {
    @EnvironmentObject private var backendClient: BackendClient
    let item: CodexThreadItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(item.title)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(itemColor)
                Spacer()
                Text(item.type)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(CopetsPalette.mutedText)
            }

            if !item.text.isEmpty {
                Text(item.text)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CopetsPalette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            if shouldShowOptions {
                optionButtonStack {
                    ForEach(approvalOptions) { option in
                        Button {
                            if item.type == "approval" {
                                backendClient.respondToCodexApproval(option: option)
                            } else if item.type == "choice" {
                                backendClient.respondToPtyChoice(option: option)
                            } else {
                                backendClient.sendMessage(option.label)
                            }
                        } label: {
                            Label(option.label, systemImage: iconName(for: option))
                                .font(.system(size: 11, weight: .bold))
                                .padding(.horizontal, 10)
                                .frame(maxWidth: item.type == "agentMessage" ? .infinity : nil, minHeight: 28, alignment: .leading)
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
            }
        }
        .padding(10)
        .background(itemBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(itemBorder, lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.04), radius: 8, y: 3)
    }

    private var itemBackground: Color {
        item.type == "approval" || item.type == "choice" ? Color(nsColor: NSColor(calibratedRed: 1.0, green: 0.98, blue: 0.91, alpha: 1)) : Color.white
    }

    private var itemBorder: Color {
        item.type == "approval" || item.type == "choice" ? CopetsPalette.amber.opacity(0.32) : Color.black.opacity(0.08)
    }

    private var itemColor: Color {
        switch item.type {
        case "userMessage": CopetsPalette.userText
        case "approval", "choice": CopetsPalette.amber
        case "agentMessage": CopetsPalette.agentText
        case "commandExecution": CopetsPalette.amber
        case "fileChange": CopetsPalette.periwinkle
        default: .secondary
        }
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
            : CopetsPalette.connected.opacity(0.14)
    }

    private func optionBorder(for option: CodexApprovalOption) -> Color {
        option.role?.localizedCaseInsensitiveContains("deny") == true
            ? Color.red.opacity(0.24)
            : CopetsPalette.connected.opacity(0.34)
    }
}

private struct MessageComposer: View {
    @EnvironmentObject private var backendClient: BackendClient
    @Binding var message: String
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            TextField("Send a instruction", text: $message, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1...3)
                .focused($isFocused)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.black.opacity(isFocused ? 0.16 : 0.08), lineWidth: 1)
                )
                .shadow(color: Color.black.opacity(0.04), radius: 8, y: 3)
                .onTapGesture {
                    isFocused = true
                }
                .onSubmit {
                    send()
                }
                .disabled(backendClient.selectedDetail?.canSend == false)

            if backendClient.selectedSession?.external?.provider == "codex-pty" {
                CodexModelMenu()
            }

            Button {
                send()
            } label: {
                if backendClient.isSendingMessage {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 30, height: 30)
                } else {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 30, height: 30)
                }
            }
            .buttonStyle(IconButtonStyle())
            .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || backendClient.isSendingMessage || backendClient.selectedDetail?.canSend == false)
            .help("Send instruction")
        }
        .opacity(backendClient.selectedDetail?.canSend == false ? 0.55 : 1)
        .task {
            if backendClient.codexModels.isEmpty {
                await backendClient.loadCodexModels()
            }
        }
    }

    private func send() {
        let text = message
        backendClient.sendMessage(text) {
            message = ""
        }
    }
}

private struct CodexModelMenu: View {
    @EnvironmentObject private var backendClient: BackendClient

    var body: some View {
        Menu {
            if backendClient.isLoadingCodexModels {
                Text("Loading models")
            } else if backendClient.codexModels.isEmpty {
                Button {
                    Task {
                        await backendClient.loadCodexModels()
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

                Divider()

                Button {
                    Task {
                        await backendClient.loadCodexModels()
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
                } else {
                    Image(systemName: "cpu")
                        .font(.system(size: 10, weight: .bold))
                }
                Text(currentModelLabel)
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(reasoningShortLabel(currentReasoningLevel))
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundStyle(CopetsPalette.secondaryText)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
            }
            .foregroundStyle(CopetsPalette.primaryText)
            .frame(maxWidth: 148)
            .padding(.horizontal, 8)
            .frame(height: 30)
            .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
            )
        }
        .menuStyle(.borderlessButton)
        .fixedSize(horizontal: true, vertical: false)
        .disabled(backendClient.selectedDetail?.canSend == false || backendClient.isSwitchingModel || backendClient.isSwitchingReasoning)
        .help("Switch Codex model or reasoning")
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
        currentModel?.reasoningLevels ?? []
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

private struct QuickReplyField: View {
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    let isSending: Bool
    let placeholder: String
    let onInteract: () -> Void
    let send: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .focused(isFocused)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .onSubmit {
                    sendIfPossible()
                }

            Button {
                sendIfPossible()
            } label: {
                if isSending {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 22, height: 22)
                } else {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 22, height: 22)
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? CopetsPalette.disabledText : CopetsPalette.softBlue)
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
            .help("Send reply")
        }
        .simultaneousGesture(TapGesture().onEnded(onInteract))
        .background(isFocused.wrappedValue ? CopetsPalette.inputFillFocused : CopetsPalette.inputFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(isFocused.wrappedValue ? CopetsPalette.inputBorderFocused : CopetsPalette.inputBorder, lineWidth: isFocused.wrappedValue ? 1.25 : 1)
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
                .foregroundStyle(CopetsPalette.secondaryText)

            Text(reason ?? "This session is read-only in Copets.")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CopetsPalette.secondaryText)
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
                .foregroundStyle(CopetsPalette.secondaryText)
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
