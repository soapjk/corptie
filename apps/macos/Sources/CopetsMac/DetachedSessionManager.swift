import AppKit
import Combine
import SwiftUI

@MainActor
final class DetachedSessionManager: ObservableObject {
    private let client: BackendClient
    private let openSession: (TaskSession) -> Void
    private var controllers: [String: DetachedSessionWindowController] = [:]

    init(client: BackendClient, openSession: @escaping (TaskSession) -> Void) {
        self.client = client
        self.openSession = openSession
    }

    func float(session: TaskSession) {
        let id = session.id
        if let controller = controllers[id] {
            controller.show()
            return
        }

        let controller = DetachedSessionWindowController(
            sessionId: id,
            client: client,
            openSession: { [weak self] session in
                self?.openSession(session)
            },
            close: { [weak self] sessionId in
                self?.controllers[sessionId] = nil
            }
        )
        controllers[id] = controller
        controller.show()
    }

    func close(sessionId: String) {
        controllers[sessionId]?.close()
        controllers[sessionId] = nil
    }

    func closeAll() {
        for controller in controllers.values {
            controller.close()
        }
        controllers.removeAll()
    }
}

@MainActor
private final class DetachedReplyPreviewState: ObservableObject {
    @Published var text = ""
    @Published var isVisible = false
    @Published var placement = DetachedReplyPlacement.right
    @Published var isQuickReplyVisible = false
    @Published var quickReplyDraft = ""
    @Published var dismissedOptionsFingerprint: String?
    @Published var hoveredOptionId: String?
}

private enum DetachedReplyPlacement {
    case left
    case right
    case top
    case bottom
}

private func detachedOptionsFingerprint(for session: TaskSession) -> String {
    let summary = session.summary.trimmingCharacters(in: .whitespacesAndNewlines)
    let labels = (session.suggestedOptions ?? [])
        .map { $0.label.trimmingCharacters(in: .whitespacesAndNewlines) }
        .joined(separator: "\u{1f}")
    return "\(summary)\u{1e}\(labels)"
}

private final class DetachedSessionPanel: NSPanel {
    override var canBecomeKey: Bool {
        true
    }

    override var canBecomeMain: Bool {
        true
    }
}

@MainActor
private final class DetachedAccessoryWindowController {
    private let panel: NSPanel
    private let contentContainer: NSView
    private let hostingView: NSHostingView<DetachedSessionAccessoryView>
    private let state: DetachedReplyPreviewState
    private let client: BackendClient
    private let sessionId: String
    private let dismissPreview: () -> Void
    private let dismissQuickReply: () -> Void

    private let orbSize: CGFloat = 72
    private let orbHaloPadding: CGFloat = 8
    private let spacing: CGFloat = 5
    private let previewTotalWidth: CGFloat = 324
    private let replyComposerTotalHeight: CGFloat = 194
    private let optionWidth: CGFloat = 246

    init(
        state: DetachedReplyPreviewState,
        client: BackendClient,
        sessionId: String,
        dismissPreview: @escaping () -> Void,
        dismissQuickReply: @escaping () -> Void
    ) {
        self.state = state
        self.client = client
        self.sessionId = sessionId
        self.dismissPreview = dismissPreview
        self.dismissQuickReply = dismissQuickReply
        self.contentContainer = NSView(frame: NSRect(x: 0, y: 0, width: 1, height: 1))
        self.hostingView = NSHostingView(
            rootView: DetachedSessionAccessoryView(
                client: client,
                sessionId: sessionId,
                previewState: state,
                dismissPreview: dismissPreview,
                dismissQuickReply: dismissQuickReply
            )
        )

        self.panel = DetachedSessionPanel(
            contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false

        contentContainer.wantsLayer = true
        contentContainer.layer?.backgroundColor = NSColor.clear.cgColor
        contentContainer.translatesAutoresizingMaskIntoConstraints = true
        hostingView.translatesAutoresizingMaskIntoConstraints = true
        hostingView.autoresizingMask = [.width, .height]
        hostingView.frame = contentContainer.bounds
        contentContainer.addSubview(hostingView)
        panel.contentView = contentContainer
    }

    func close() {
        panel.close()
    }

    func orderFront() {
        panel.orderFrontRegardless()
    }

    func update(for session: TaskSession?, orbCenter: NSPoint, screenFrame: NSRect?) {
        let size = accessorySize(for: session)
        guard size.width > 0, size.height > 0 else {
            panel.orderOut(nil)
            return
        }

        let placement = bestPlacement(for: size, orbCenter: orbCenter, screenFrame: screenFrame)
        state.placement = placement
        let frame = accessoryFrame(size: size, placement: placement, orbCenter: orbCenter)
        updateContentSize(size)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0
            context.allowsImplicitAnimation = false
            panel.setFrame(frame, display: true)
        }
        panel.orderFrontRegardless()
    }

    private func updateContentSize(_ size: NSSize) {
        let bounds = NSRect(origin: .zero, size: size)
        if contentContainer.frame != bounds {
            contentContainer.frame = bounds
        }
        if hostingView.frame != bounds {
            hostingView.frame = bounds
        }
    }

    func makeKeyIfNeeded() {
        guard state.isQuickReplyVisible else {
            return
        }
        panel.makeKeyAndOrderFront(nil)
    }

    private func accessorySize(for session: TaskSession?) -> NSSize {
        let hasPreview = state.isVisible && !state.text.isEmpty
        let hasQuickReply = state.isQuickReplyVisible
        let optionCount = min(visibleOptionCount(for: session), 5)
        let hasOptions = optionCount > 0

        let stackHeight = floatingAccessoryHeight(hasPreview: hasPreview, hasQuickReply: hasQuickReply)
        let optionsHeight = hasOptions ? optionAreaHeight(for: session, optionCount: optionCount) : 0
        let width = max(hasPreview || hasQuickReply ? previewTotalWidth : 0, hasOptions ? optionWidth : 0)
        var height = stackHeight
        if hasOptions {
            if height > 0 {
                height += spacing
            }
            height += optionsHeight
        }
        return NSSize(width: width, height: height)
    }

    private func optionAreaHeight(for session: TaskSession?, optionCount: Int) -> CGFloat {
        var height = min(138, CGFloat(optionCount) * 34 + 8)
        if session != nil, state.hoveredOptionId != nil {
            height += 52
        }
        return height
    }

    private func visibleOptionCount(for session: TaskSession?) -> Int {
        guard let session else {
            return 0
        }
        let options = session.suggestedOptions ?? []
        guard !options.isEmpty else {
            return 0
        }
        if state.dismissedOptionsFingerprint == detachedOptionsFingerprint(for: session) {
            state.hoveredOptionId = nil
            return 0
        }
        return options.count
    }

    private func floatingAccessoryHeight(hasPreview: Bool, hasQuickReply: Bool) -> CGFloat {
        if hasPreview && hasQuickReply {
            return replyComposerTotalHeight
        }
        return 0
    }

    private func bestPlacement(for size: NSSize, orbCenter: NSPoint, screenFrame: NSRect?) -> DetachedReplyPlacement {
        guard let screenFrame else {
            return .right
        }
        let candidates: [DetachedReplyPlacement] = [.right, .left, .top, .bottom]
        let scored = candidates.map { placement in
            let frame = accessoryFrame(size: size, placement: placement, orbCenter: orbCenter)
            let visible = frame.intersection(screenFrame.insetBy(dx: 8, dy: 8))
            let visibleArea = visible.isNull ? 0 : visible.width * visible.height
            let ratio = visibleArea / max(1, frame.width * frame.height)
            return (placement, ratio)
        }
        if let exact = scored.first(where: { $0.1 >= 0.999 }) {
            return exact.0
        }
        return scored.max(by: { $0.1 < $1.1 })?.0 ?? .right
    }

    private func accessoryFrame(size: NSSize, placement: DetachedReplyPlacement, orbCenter: NSPoint) -> NSRect {
        let orbRenderSize = orbSize + orbHaloPadding * 2
        switch placement {
        case .right:
            return NSRect(x: orbCenter.x + orbRenderSize / 2 + spacing, y: orbCenter.y + orbRenderSize / 2 - size.height, width: size.width, height: size.height)
        case .left:
            return NSRect(x: orbCenter.x - orbRenderSize / 2 - spacing - size.width, y: orbCenter.y + orbRenderSize / 2 - size.height, width: size.width, height: size.height)
        case .top:
            return NSRect(x: orbCenter.x - size.width / 2, y: orbCenter.y + orbRenderSize / 2 + spacing, width: size.width, height: size.height)
        case .bottom:
            return NSRect(x: orbCenter.x - size.width / 2, y: orbCenter.y - orbRenderSize / 2 - spacing - size.height, width: size.width, height: size.height)
        }
    }
}

@MainActor
private final class DetachedSessionWindowController: NSObject, NSWindowDelegate {
    private let sessionId: String
    private let client: BackendClient
    private let openSession: (TaskSession) -> Void
    private let closeHandler: (String) -> Void
    private let panel: NSPanel
    private let previewState = DetachedReplyPreviewState()
    private lazy var accessoryController = DetachedAccessoryWindowController(
        state: previewState,
        client: client,
        sessionId: sessionId,
        dismissPreview: { [weak self] in
            self?.hideReplyPreview(markDismissed: true)
            self?.updateAccessory(for: self?.currentSession)
        },
        dismissQuickReply: { [weak self] in
            self?.hideQuickReply()
            self?.updateAccessory(for: self?.currentSession)
        }
    )
    private var cancellables = Set<AnyCancellable>()
    private var outsideClickMonitor: Any?
    private var lastSummary: String?
    private var lastStatus: TaskStatus?
    private var lastPreviewText: String?
    private var dismissedPreviewText: String?

    private let orbSize: CGFloat = 72
    private let orbHaloPadding: CGFloat = 8

    init(
        sessionId: String,
        client: BackendClient,
        openSession: @escaping (TaskSession) -> Void,
        close: @escaping (String) -> Void
    ) {
        self.sessionId = sessionId
        self.client = client
        self.openSession = openSession
        self.closeHandler = close

        let size = NSSize(width: orbSize + orbHaloPadding * 2, height: orbSize + orbHaloPadding * 2)
        self.panel = DetachedSessionPanel(
            contentRect: NSRect(x: 1220, y: 620, width: size.width, height: size.height),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        super.init()

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.delegate = self
        panel.contentView = NSHostingView(
            rootView: DetachedSessionOrbView(
                client: client,
                sessionId: sessionId,
                previewState: previewState,
                primaryAction: { [weak self] in
                    self?.showQuickReply()
                },
                openSession: { [weak self] session in
                    self?.hideReplyPreview()
                    self?.hideQuickReply()
                    self?.updateAccessory(for: session)
                    self?.openSession(session)
                },
                dismissPreview: { [weak self] in
                    self?.hideReplyPreview(markDismissed: true)
                    self?.updateAccessory(for: self?.currentSession)
                },
                dismissQuickReply: { [weak self] in
                    self?.hideQuickReply()
                    self?.updateAccessory(for: self?.currentSession)
                },
                moved: { [weak self] in
                    self?.updateAccessory(for: self?.currentSession)
                },
                close: { [weak self] in
                    self?.close()
                }
            )
        )

        client.$sessions
            .receive(on: RunLoop.main)
            .sink { [weak self] sessions in
                guard let self else { return }
                let session = sessions.first { $0.id == self.sessionId }
                self.updateReplyPreview(for: session)
                self.updateAccessory(for: session)
            }
            .store(in: &cancellables)
    }

    func show() {
        panel.orderFrontRegardless()
        updateAccessory(for: currentSession)
    }

    func close() {
        accessoryController.close()
        panel.close()
    }

    func windowWillClose(_ notification: Notification) {
        removeOutsideClickMonitor()
        closeHandler(sessionId)
    }

    func windowDidResignKey(_ notification: Notification) {
        updateAccessory(for: currentSession)
    }

    func windowDidMove(_ notification: Notification) {
        updateAccessory(for: currentSession)
    }

    private func showQuickReply() {
        previewState.isQuickReplyVisible = true
        showLatestReplyPreviewIfNeeded()
        panel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        updateAccessory(for: currentSession)
        accessoryController.makeKeyIfNeeded()
    }

    private func hideQuickReply() {
        previewState.isQuickReplyVisible = false
    }

    private func updateAccessory(for session: TaskSession?) {
        accessoryController.update(for: session, orbCenter: currentOrbCenter, screenFrame: panel.screen?.visibleFrame ?? NSScreen.main?.visibleFrame)
    }

    private func updateReplyPreview(for session: TaskSession?) {
        guard let session else {
            hideReplyPreview()
            lastSummary = nil
            lastStatus = nil
            lastPreviewText = nil
            dismissedPreviewText = nil
            return
        }
        guard !isSessionOpenInMainView(session) else {
            hideReplyPreview()
            lastSummary = session.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            lastStatus = session.status
            return
        }

        let summary = session.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let previousStatus = lastStatus
        defer {
            if !summary.isEmpty {
                lastSummary = summary
            }
            lastStatus = session.status
        }

        guard session.status != .running else {
            return
        }

        guard let previousSummary = lastSummary else {
            if session.status == .blocked || session.status == .complete || session.status == .failed || session.status == .cancelled {
                fetchDetailPreviewIfNeeded(for: session, fallbackSummary: summary, allowFallback: true)
            }
            return
        }

        if summary != previousSummary, !summary.isEmpty {
            fetchDetailPreviewIfNeeded(for: session, fallbackSummary: summary, allowFallback: true)
        } else if previousStatus == .running {
            fetchDetailPreviewIfNeeded(for: session, fallbackSummary: summary, allowFallback: true)
        }
    }

    private func hideReplyPreview(markDismissed: Bool = false) {
        if markDismissed {
            let text = previewState.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                dismissedPreviewText = text
            }
        }
        previewState.isVisible = false
        previewState.isQuickReplyVisible = false
    }

    private func fetchDetailPreviewIfNeeded(for session: TaskSession, fallbackSummary: String, allowFallback: Bool) {
        Task { [weak self] in
            guard let self else { return }
            let detail = await client.fetchDetail(for: session)
            let text = Self.latestFinalAgentPreviewText(from: detail, includeActiveTurn: false) ?? (allowFallback ? fallbackSummary : "")
            await MainActor.run {
                guard let current = self.currentSession,
                      current.id == session.id,
                      current.status != .running,
                      !self.isSessionOpenInMainView(current) else {
                    return
                }
                self.showReplyPreview(text, for: current)
            }
        }
    }

    private func showLatestReplyPreviewIfNeeded() {
        guard !previewState.isVisible else {
            return
        }
        dismissedPreviewText = nil
        if !previewState.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            previewState.isVisible = true
            return
        }
        guard let session = currentSession, !isSessionOpenInMainView(session) else {
            return
        }

        let fallbackSummary = session.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if session.status != .running, !fallbackSummary.isEmpty {
            showReplyPreview(fallbackSummary, for: session, force: true)
        }
        fetchLatestReplyPreview(
            for: session,
            fallbackSummary: fallbackSummary,
            allowFallback: session.status != .running,
            includeActiveTurn: session.status != .running,
            force: true
        )
    }

    private func fetchLatestReplyPreview(
        for session: TaskSession,
        fallbackSummary: String,
        allowFallback: Bool,
        includeActiveTurn: Bool,
        force: Bool = false
    ) {
        Task { [weak self] in
            guard let self else { return }
            let detail = await client.fetchDetail(for: session)
            let text = Self.latestFinalAgentPreviewText(from: detail, includeActiveTurn: includeActiveTurn) ?? (allowFallback ? fallbackSummary : "")
            await MainActor.run {
                guard let current = self.currentSession,
                      current.id == session.id,
                      !self.isSessionOpenInMainView(current) else {
                    return
                }
                self.showReplyPreview(text, for: current, force: force)
            }
        }
    }

    private func showReplyPreview(_ text: String, for session: TaskSession, force: Bool = false) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !force, trimmed == dismissedPreviewText {
            return
        }
        guard !trimmed.isEmpty, force || trimmed != lastPreviewText || !previewState.isVisible else {
            return
        }
        if trimmed != dismissedPreviewText {
            dismissedPreviewText = nil
        }
        lastPreviewText = trimmed
        previewState.text = trimmed
        previewState.isVisible = true
        previewState.isQuickReplyVisible = true
        updateAccessory(for: session)
    }

    private func isSessionOpenInMainView(_ session: TaskSession) -> Bool {
        client.selectedSession?.id == session.id
    }

    private static func latestFinalAgentPreviewText(from detail: CodexThreadDetail?, includeActiveTurn: Bool) -> String? {
        guard let detail else {
            return nil
        }

        var turnIds: [String] = []
        var itemsByTurnId: [String: [CodexThreadItem]] = [:]
        for item in detail.items {
            if itemsByTurnId[item.turnId] == nil {
                turnIds.append(item.turnId)
                itemsByTurnId[item.turnId] = []
            }
            itemsByTurnId[item.turnId]?.append(item)
        }

        if detail.status == .running && !includeActiveTurn && !turnIds.isEmpty {
            turnIds.removeLast()
        }

        for turnId in turnIds.reversed() {
            guard let turnItems = itemsByTurnId[turnId] else {
                continue
            }
            if let text = turnItems.reversed().first(where: { item in
                item.type == "agentMessage" && !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            })?.text.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                return text
            }
        }
        return nil
    }

    private var currentSession: TaskSession? {
        client.sessions.first { $0.id == sessionId }
    }

    private func installOutsideClickMonitor() {
        removeOutsideClickMonitor()
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor in
                self?.hideQuickReply()
                self?.updateAccessory(for: self?.currentSession)
            }
        }
    }

    private func removeOutsideClickMonitor() {
        if let outsideClickMonitor {
            NSEvent.removeMonitor(outsideClickMonitor)
            self.outsideClickMonitor = nil
        }
    }

    private var currentOrbCenter: NSPoint {
        NSPoint(x: panel.frame.minX + orbHaloPadding + orbSize / 2, y: panel.frame.maxY - orbHaloPadding - orbSize / 2)
    }
}

private struct DetachedSessionOrbView: View {
    @ObservedObject var client: BackendClient
    let sessionId: String
    @ObservedObject var previewState: DetachedReplyPreviewState
    let primaryAction: () -> Void
    let openSession: (TaskSession) -> Void
    let dismissPreview: () -> Void
    let dismissQuickReply: () -> Void
    let moved: () -> Void
    let close: () -> Void

    var body: some View {
        Group {
            if let session {
                orb(session: session)
                    .help(session.status.label)
            } else {
                EmptyView()
                    .onAppear {
                        close()
                }
            }
        }
        .frame(width: orbRenderSize, height: orbRenderSize, alignment: .topLeading)
        .background(Color.clear)
    }

    @ViewBuilder
    private func orb(session: TaskSession) -> some View {
        ZStack {
            StatusHalo(status: session.status)
                .frame(width: orbRenderSize, height: orbRenderSize)

            AgentAvatarView(session: session, size: 52, showsChrome: false)
                .frame(width: 52, height: 52)

            ConnectionIndicatorLight(
                color: session.connectionColor,
                size: 8,
                glowSize: 17,
                isBreathing: session.isConnecting
            )
            .offset(x: 21, y: -21)
        }
        .frame(width: 72, height: 72)
        .transaction { transaction in
            transaction.animation = nil
        }
        .contentShape(Circle())
        .overlay(
            DetachedOrbEventLayer(
                open: {
                    primaryAction()
                },
                openSession: {
                    openSession(session)
                },
                moved: moved,
                close: close
            )
            .frame(width: 72, height: 72)
        )
        .padding(orbHaloPadding)
    }

    private var orbRenderSize: CGFloat {
        88
    }

    private var orbHaloPadding: CGFloat {
        8
    }

    private var session: TaskSession? {
        client.sessions.first { $0.id == sessionId }
    }
}

private struct DetachedSessionAccessoryView: View {
    @ObservedObject var client: BackendClient
    let sessionId: String
    @ObservedObject var previewState: DetachedReplyPreviewState
    let dismissPreview: () -> Void
    let dismissQuickReply: () -> Void

    var body: some View {
        if let session {
            ZStack(alignment: .topLeading) {
                floatingAccessory(session: session)

                if !visibleOptions.isEmpty {
                    optionList(session: session)
                        .offset(y: contentOffsetBeforeOptionList)
                }

                if let hoveredOption {
                    DetachedOptionTooltip(text: hoveredOption.label)
                        .offset(x: 8, y: optionTooltipY(for: hoveredOption))
                        .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .bottom)))
                        .zIndex(8)
                        .allowsHitTesting(false)
                }
            }
            .frame(width: contentWidth, height: contentHeight, alignment: .topLeading)
            .background(Color.clear)
        } else {
            EmptyView()
        }
    }

    @ViewBuilder
    private func floatingAccessory(session: TaskSession) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if shouldShowReplyPreview && previewState.isQuickReplyVisible {
                DetachedReplyComposerCard(
                    text: previewState.text,
                    draft: $previewState.quickReplyDraft,
                    send: {
                        sendQuickReply(to: session)
                    },
                    dismiss: {
                        dismissPreview()
                        dismissQuickReply()
                    }
                )
                .padding(10)
                .frame(width: previewTotalWidth, height: replyComposerTotalHeight, alignment: .topLeading)
            }
        }
        .frame(width: previewTotalWidth, height: accessoryHeight, alignment: .topLeading)
    }

    @ViewBuilder
    private func optionList(session: TaskSession) -> some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(visibleOptions) { option in
                    DetachedOptionButton(
                        option: option,
                        background: optionBackground,
                        hoverChanged: { hovering in
                            previewState.hoveredOptionId = hovering ? option.id : (previewState.hoveredOptionId == option.id ? nil : previewState.hoveredOptionId)
                        },
                        send: {
                            previewState.dismissedOptionsFingerprint = detachedOptionsFingerprint(for: session)
                            previewState.hoveredOptionId = nil
                            dismissPreview()
                            dismissQuickReply()
                            client.sendMessage(option.label, to: session, isChoiceSelection: true)
                        }
                    )
                }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        }
        .frame(width: optionWidth, height: optionListHeight, alignment: .topLeading)
    }

    private func sendQuickReply(to session: TaskSession) {
        let trimmed = previewState.quickReplyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return
        }
        previewState.quickReplyDraft = ""
        dismissQuickReply()
        dismissPreview()
        client.sendMessage(trimmed, to: session)
    }

    private var session: TaskSession? {
        client.sessions.first { $0.id == sessionId }
    }

    private var visibleOptions: [CodexApprovalOption] {
        guard let session else {
            return []
        }
        if previewState.dismissedOptionsFingerprint == detachedOptionsFingerprint(for: session) {
            return []
        }
        return Array((session.suggestedOptions ?? []).prefix(5))
    }

    private var hoveredOption: CodexApprovalOption? {
        guard let hoveredOptionId = previewState.hoveredOptionId else {
            return nil
        }
        return visibleOptions.first { $0.id == hoveredOptionId }
    }

    private var sessionHasOptions: Bool {
        !visibleOptions.isEmpty
    }

    private var shouldShowReplyPreview: Bool {
        previewState.isVisible && !previewState.text.isEmpty
    }

    private var contentWidth: CGFloat {
        max(accessoryHeight > 0 ? previewTotalWidth : 0, sessionHasOptions ? optionWidth : 0)
    }

    private var contentHeight: CGFloat {
        accessoryHeight + (accessoryHeight > 0 && sessionHasOptions ? spacing : 0) + (sessionHasOptions ? optionListHeight : 0)
    }

    private var accessoryHeight: CGFloat {
        if shouldShowReplyPreview && previewState.isQuickReplyVisible {
            return replyComposerTotalHeight
        }
        return 0
    }

    private var previewTotalWidth: CGFloat {
        324
    }

    private var replyComposerTotalHeight: CGFloat {
        194
    }

    private var spacing: CGFloat {
        10
    }

    private var optionWidth: CGFloat {
        246
    }

    private func optionTooltipY(for option: CodexApprovalOption) -> CGFloat {
        guard let index = visibleOptions.firstIndex(of: option) else {
            return 0
        }
        let optionListOriginY = contentOffsetBeforeOptionList
        let optionTop = optionListOriginY + CGFloat(index) * 34 + 8
        let tooltipHeight: CGFloat = 44
        let tooltipReserveY = tooltipHeight + 8
        let aboveY = optionTop - tooltipHeight - 3
        let maxTopY = max(0, optionListHeight - tooltipHeight - 4)
        if optionTop > tooltipReserveY {
            return max(0, min(aboveY, maxTopY))
        }
        return min(optionTop + 34, maxTopY)
    }

    private var contentOffsetBeforeOptionList: CGFloat {
        let topPad = accessoryHeight > 0 ? accessoryHeight + spacing : 0
        return topPad
    }

    private var optionListHeight: CGFloat {
        var listHeight = min(138, CGFloat(visibleOptions.count) * 34 + 8)
        if previewState.hoveredOptionId != nil {
            listHeight += 52
        }
        return listHeight
    }

    private var optionBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.12, alpha: 0.92)
                : NSColor(calibratedWhite: 1.0, alpha: 0.88)
        })
    }
}

private struct DetachedReplyPreviewBubble: View {
    let text: String
    let dismiss: () -> Void
    @State private var isHovering = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            ScrollView(.vertical, showsIndicators: true) {
                Text(text)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(CopetsPalette.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 14)
                    .padding(.trailing, 12)
                    .padding(.top, 24)
                    .padding(.bottom, 11)
            }
            .frame(width: 300, height: 126, alignment: .leading)

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
                    .frame(width: 16, height: 16)
                    .foregroundStyle(CopetsPalette.secondaryText)
            }
            .buttonStyle(.plain)
            .background(Color.black.opacity(0.06), in: Circle())
            .padding(7)
            .help("Dismiss")

            CopyTextButton(text: text, isVisible: isHovering && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .frame(width: 300, height: 126, alignment: .bottomTrailing)
                .padding(.trailing, 7)
                .padding(.bottom, 7)
        }
        .background(replyBackground, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(Color.white.opacity(0.38), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.12), radius: 7, y: 3)
        .onHover { hovering in
            isHovering = hovering
        }
    }

    private var replyBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.10, alpha: 0.94)
                : NSColor(calibratedWhite: 1.0, alpha: 0.92)
        })
    }
}

private struct DetachedReplyComposerCard: View {
    let text: String
    @Binding var draft: String
    let send: () -> Void
    let dismiss: () -> Void
    @FocusState private var isFocused: Bool
    @State private var isHoveringPreview = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topLeading) {
                ScrollView(.vertical, showsIndicators: true) {
                    Text(text)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(CopetsPalette.primaryText)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 24)
                        .padding(.trailing, 6)
                        .padding(.vertical, 4)
                }
                .frame(height: 118, alignment: .leading)

                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .bold))
                        .frame(width: 16, height: 16)
                        .foregroundStyle(CopetsPalette.secondaryText)
                }
                .buttonStyle(.plain)
                .background(Color.black.opacity(0.06), in: Circle())
                .help("Dismiss")

                CopyTextButton(text: text, isVisible: isHoveringPreview && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(.trailing, 3)
                    .padding(.bottom, 3)
            }
            .onHover { hovering in
                isHoveringPreview = hovering
            }

            HStack(spacing: 6) {
                ChatInputTextView(
                    text: $draft,
                    placeholder: "Reply...",
                    font: .systemFont(ofSize: 12, weight: .semibold),
                    autoFocus: true,
                    onFocusChange: { focused in
                        isFocused = focused
                    },
                    onSubmit: send
                )
                    .frame(height: 28)
                    .padding(.leading, 10)
                    .padding(.trailing, 2)
                    .padding(.vertical, 3)

                Button {
                    send()
                } label: {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .foregroundStyle(CopetsPalette.softBlue)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.leading, 2)
            .padding(.trailing, 7)
            .padding(.vertical, 5)
            .frame(height: 38)
            .background(inputBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(CopetsPalette.softBlue.opacity(isFocused ? 0.46 : 0.20), lineWidth: 1)
            )
        }
        .padding(10)
        .frame(width: 304, height: 174, alignment: .topLeading)
        .background(cardBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.white.opacity(0.38), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.10), radius: 5, y: 2)
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                isFocused = true
            }
        }
    }

    private var cardBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.10, alpha: 0.94)
                : NSColor(calibratedWhite: 1.0, alpha: 0.92)
        })
    }

    private var inputBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.13, alpha: 0.92)
                : NSColor(calibratedWhite: 0.98, alpha: 0.86)
        })
    }
}

private struct DetachedQuickReplyInput: View {
    @Binding var text: String
    let send: () -> Void
    let dismiss: () -> Void
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 6) {
            ChatInputTextView(
                text: $text,
                placeholder: "Reply...",
                font: .systemFont(ofSize: 12, weight: .semibold),
                autoFocus: true,
                onFocusChange: { focused in
                    isFocused = focused
                },
                onSubmit: send
            )
                .frame(height: 30)
                .padding(.leading, 11)
                .padding(.trailing, 2)
                .padding(.vertical, 4)

            Button {
                send()
            } label: {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 10, weight: .bold))
                    .frame(width: 26, height: 26)
            }
            .buttonStyle(.plain)
            .foregroundStyle(CopetsPalette.softBlue)
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.leading, 2)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .frame(width: 300, height: 42)
        .background(inputBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(CopetsPalette.softBlue.opacity(isFocused ? 0.46 : 0.22), lineWidth: 1)
        )
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                isFocused = true
            }
        }
    }

    private var inputBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.10, alpha: 0.95)
                : NSColor(calibratedWhite: 1.0, alpha: 0.94)
        })
    }
}

private struct DetachedOptionButton: View {
    let option: CodexApprovalOption
    let background: Color
    let hoverChanged: (Bool) -> Void
    let send: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button {
            send()
        } label: {
            Text(option.label)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(CopetsPalette.primaryText)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 9)
                .frame(height: 28)
        }
        .buttonStyle(.plain)
        .background(background, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(CopetsPalette.amber.opacity(0.26), lineWidth: 1)
        )
        .onHover { hovering in
            isHovering = hovering
            hoverChanged(hovering)
        }
        .help(option.label)
    }
}

private struct DetachedOptionTooltip: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(CopetsPalette.primaryText)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(width: 240, alignment: .leading)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .strokeBorder(Color.black.opacity(0.08), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.16), radius: 14, y: 6)
            .allowsHitTesting(false)
    }
}

private struct DetachedOrbEventLayer: NSViewRepresentable {
    let open: () -> Void
    let openSession: () -> Void
    let moved: () -> Void
    let close: () -> Void

    func makeNSView(context: Context) -> EventView {
        let view = EventView()
        view.open = open
        view.openSessionAction = openSession
        view.moved = moved
        view.close = close
        return view
    }

    func updateNSView(_ nsView: EventView, context: Context) {
        nsView.open = open
        nsView.openSessionAction = openSession
        nsView.moved = moved
        nsView.close = close
    }

    final class EventView: NSView {
        var open: (() -> Void)?
        var openSessionAction: (() -> Void)?
        var moved: (() -> Void)?
        var close: (() -> Void)?
        private var initialMouseScreenPoint: NSPoint?
        private var initialWindowOrigin: NSPoint?
        private var didDrag = false

        override var acceptsFirstResponder: Bool {
            true
        }

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
            true
        }

        override func hitTest(_ point: NSPoint) -> NSView? {
            let center = NSPoint(x: bounds.midX, y: bounds.midY)
            let dx = point.x - center.x
            let dy = point.y - center.y
            let radius = min(bounds.width, bounds.height) / 2
            return dx * dx + dy * dy <= radius * radius ? self : nil
        }

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            initialMouseScreenPoint = window.convertPoint(toScreen: event.locationInWindow)
            initialWindowOrigin = window.frame.origin
            didDrag = false
        }

        override func mouseDragged(with event: NSEvent) {
            guard let window,
                  let initialMouseScreenPoint,
                  let initialWindowOrigin else {
                return
            }

            let currentMouseScreenPoint = window.convertPoint(toScreen: event.locationInWindow)
            let dx = currentMouseScreenPoint.x - initialMouseScreenPoint.x
            let dy = currentMouseScreenPoint.y - initialMouseScreenPoint.y
            if abs(dx) > 2 || abs(dy) > 2 {
                didDrag = true
            }

            var frame = window.frame
            frame.origin = NSPoint(x: initialWindowOrigin.x + dx, y: initialWindowOrigin.y + dy)
            window.setFrame(frame, display: true)
            moved?()
        }

        override func mouseUp(with event: NSEvent) {
            if !didDrag {
                open?()
            }
            initialMouseScreenPoint = nil
            initialWindowOrigin = nil
            didDrag = false
        }

        override func rightMouseDown(with event: NSEvent) {
            let menu = NSMenu()
            menu.addItem(NSMenuItem(title: "Open Session", action: #selector(openSession), keyEquivalent: ""))
            menu.addItem(NSMenuItem(title: "Close Floating Orb", action: #selector(closeOrb), keyEquivalent: ""))
            menu.items.forEach { $0.target = self }
            menu.popUp(positioning: nil, at: convert(event.locationInWindow, from: nil), in: self)
        }

        @objc private func openSession() {
            openSessionAction?()
        }

        @objc private func closeOrb() {
            close?()
        }
    }
}

private struct StatusHalo: View {
    let status: TaskStatus

    var body: some View {
        Group {
            if status == .running || shouldPulse {
                TimelineView(.periodic(from: .now, by: status == .running ? 1.0 / 60.0 : 0.125)) { timeline in
                    halo(phase: timeline.date.timeIntervalSinceReferenceDate)
                }
            } else {
                halo(phase: 0)
            }
        }
        .transaction { transaction in
            transaction.animation = nil
        }
    }

    @ViewBuilder
    private func halo(phase: TimeInterval) -> some View {
        ZStack {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            baseColor.opacity(innerOpacity),
                            baseColor.opacity(midOpacity),
                            baseColor.opacity(0.0)
                        ],
                        center: .center,
                        startRadius: 22,
                        endRadius: 38
                    )
                )
                .opacity(pulseOpacity(phase: phase))
                .scaleEffect(pulseScale(phase: phase))

            if status == .running {
                Circle()
                    .trim(from: 0.05, to: 0.28)
                    .stroke(
                        AngularGradient(
                            colors: [
                                CopetsPalette.connected.opacity(0.0),
                                CopetsPalette.connected.opacity(0.86),
                                CopetsPalette.connected.opacity(0.0)
                            ],
                            center: .center
                        ),
                        style: StrokeStyle(lineWidth: 3, lineCap: .round)
                    )
                    .blur(radius: 0.6)
                    .padding(8)
                    .rotationEffect(.degrees((phase.truncatingRemainder(dividingBy: 1.2) / 1.2) * 360))
            }
        }
    }

    private var baseColor: Color {
        switch status {
        case .running:
            CopetsPalette.connected
        case .blocked:
            Color(nsColor: NSColor(calibratedRed: 1.0, green: 0.58, blue: 0.02, alpha: 1.0))
        case .complete:
            Color(nsColor: NSColor(calibratedRed: 1.0, green: 0.58, blue: 0.02, alpha: 1.0))
        case .failed:
            .red
        case .cancelled:
            CopetsPalette.mutedText
        }
    }

    private var innerOpacity: Double {
        switch status {
        case .running:
            0.32
        case .blocked:
            0.82
        case .complete:
            0.82
        case .failed:
            0.54
        case .cancelled:
            0.28
        }
    }

    private var midOpacity: Double {
        switch status {
        case .running:
            0.16
        case .blocked:
            0.44
        case .complete:
            0.44
        case .failed:
            0.28
        case .cancelled:
            0.14
        }
    }

    private var shouldPulse: Bool {
        status == .blocked || status == .complete
    }

    private func pulseOpacity(phase: TimeInterval) -> Double {
        guard shouldPulse else {
            return 1.0
        }
        return pulseWave(phase: phase)
    }

    private func pulseScale(phase: TimeInterval) -> CGFloat {
        guard shouldPulse else {
            return 1.0
        }
        let wave = pulseWave(phase: phase)
        return 0.62 + CGFloat(wave) * 0.46
    }

    private func pulseWave(phase: TimeInterval) -> Double {
        (sin(phase * .pi / 1.2) + 1) / 2
    }
}
