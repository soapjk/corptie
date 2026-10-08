import AppKit
import SwiftUI

@MainActor
final class DetachedChatWindowManager: ObservableObject {
    static let shared = DetachedChatWindowManager()

    private var controllers: [String: DetachedChatWindowController] = [:]

    var hasKeyWindow: Bool {
        controllers.values.contains(where: \.isKeyWindow)
    }

    func isOpen(sessionID: String) -> Bool {
        controllers[sessionID] != nil
    }

    func toggle(session: TaskSession) {
        if isOpen(sessionID: session.id) {
            close(sessionID: session.id)
        } else {
            show(session: session)
        }
    }

    func show(session: TaskSession) {
        if let controller = controllers[session.id] {
            controller.show()
            return
        }

        let controller = DetachedChatWindowController(
            sessionID: session.id,
            cascadeIndex: controllers.count,
            close: { [weak self] sessionID in
                self?.removeController(sessionID: sessionID)
            }
        )
        objectWillChange.send()
        controllers[session.id] = controller
        controller.show()
    }

    func close(sessionID: String) {
        guard controllers[sessionID] != nil else { return }
        objectWillChange.send()
        guard let controller = controllers.removeValue(forKey: sessionID) else { return }
        controller.close()
    }

    private func removeController(sessionID: String) {
        guard controllers[sessionID] != nil else { return }
        objectWillChange.send()
        controllers[sessionID] = nil
    }

    func returnToMain(sessionID: String) {
        close(sessionID: sessionID)
        AppDelegate.shared?.openSessionInMainWindow(sessionID: sessionID)
    }

    func apply(_ preset: DetachedChatWindowPreset, to sessionID: String) {
        controllers[sessionID]?.apply(preset)
    }

    func closeAll() {
        guard !controllers.isEmpty else { return }
        objectWillChange.send()
        let openControllers = Array(controllers.values)
        controllers.removeAll()
        openControllers.forEach { $0.close() }
    }
}

struct DetachedChatWindowMenuButton: View {
    @ObservedObject private var manager = DetachedChatWindowManager.shared
    let session: TaskSession?

    var body: some View {
        let isOpen = session.map { manager.isOpen(sessionID: $0.id) } ?? false
        Button {
            guard let session else { return }
            manager.toggle(session: session)
        } label: {
            Label(isOpen ? L10n("Close Floating Window") : L10n("Open Floating Window"),
                  systemImage: isOpen ? "macwindow" : "macwindow.on.rectangle")
        }
        .disabled(session == nil)
        .accessibilityIdentifier("session.context.floating-window")
    }
}

@MainActor
private final class DetachedChatWindowController: NSObject, NSWindowDelegate {
    private static let initialSize = NSSize(width: 560, height: 640)

    private let sessionID: String
    private let panel: DetachedChatPanel
    private let closeHandler: (String) -> Void

    init(sessionID: String, cascadeIndex: Int, close: @escaping (String) -> Void) {
        self.sessionID = sessionID
        self.closeHandler = close
        let visibleFrame = NSScreen.main?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1_440, height: 900)
        let restoredSize = DetachedChatWindowSizeStore.size(for: sessionID)
            .map { DetachedChatWindowGeometry.constrainedSize($0, in: visibleFrame) }
            ?? Self.initialSize
        let offset = CGFloat(cascadeIndex % 8) * 24
        let origin = NSPoint(
            x: visibleFrame.midX - restoredSize.width / 2 + offset,
            y: visibleFrame.midY - restoredSize.height / 2 - offset
        )
        panel = DetachedChatPanel(
            contentRect: NSRect(origin: origin, size: restoredSize),
            styleMask: [.borderless, .fullSizeContentView, .resizable, .closable],
            backing: .buffered,
            defer: false
        )
        super.init()

        panel.delegate = self
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.minSize = NSSize(width: 220, height: 420)
        panel.maxSize = NSSize(width: 10_000, height: 10_000)
        let frameName = DetachedChatWindowFrameStore.name(for: sessionID)
        if panel.setFrameUsingName(frameName) {
            let visibleFrames = NSScreen.screens.map(\.visibleFrame)
            let restoredFrame = DetachedChatWindowGeometry.constrainedFrame(
                panel.frame,
                in: visibleFrames,
                fallback: visibleFrame,
                minimumSize: panel.minSize
            )
            panel.setFrame(restoredFrame, display: false)
        }
        panel.setFrameAutosaveName(frameName)
        panel.contentView = DetachedChatHostingView(
            rootView: DetachedChatWindowView(
                sessionID: sessionID,
                close: { DetachedChatWindowManager.shared.close(sessionID: sessionID) },
                returnToMain: {
                    DetachedChatWindowManager.shared.returnToMain(sessionID: sessionID)
                },
                applyWindowPreset: { preset in
                    DetachedChatWindowManager.shared.apply(preset, to: sessionID)
                }
            )
        )
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
    }

    func close() {
        panel.saveFrame(usingName: DetachedChatWindowFrameStore.name(for: sessionID))
        panel.delegate = nil
        panel.close()
    }

    func apply(_ preset: DetachedChatWindowPreset) {
        let visibleFrame = panel.screen?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1_440, height: 900)
        let frame = DetachedChatWindowGeometry.frame(
            for: preset,
            visibleFrame: visibleFrame,
            normalSize: Self.initialSize,
            minimumSize: panel.minSize
        )
        panel.setFrame(frame, display: true, animate: true)
        panel.saveFrame(usingName: DetachedChatWindowFrameStore.name(for: sessionID))
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        panel.saveFrame(usingName: DetachedChatWindowFrameStore.name(for: sessionID))
    }

    func windowWillClose(_ notification: Notification) {
        panel.saveFrame(usingName: DetachedChatWindowFrameStore.name(for: sessionID))
        closeHandler(sessionID)
    }

    var isKeyWindow: Bool {
        panel.isKeyWindow
    }
}

enum DetachedChatWindowPreset: String, CaseIterable, Sendable {
    case normal
    case narrowRight
    case narrowLeft
    case maximized

    @MainActor
    var title: String {
        switch self {
        case .normal: L10n("Normal")
        case .narrowRight: L10n("Narrow on Right")
        case .narrowLeft: L10n("Narrow on Left")
        case .maximized: L10n("Maximize")
        }
    }

    var systemImage: String {
        switch self {
        case .normal: "macwindow"
        case .narrowRight: "rectangle.righthalf.inset.filled"
        case .narrowLeft: "rectangle.lefthalf.inset.filled"
        case .maximized: "arrow.up.left.and.arrow.down.right"
        }
    }
}

enum DetachedChatWindowGeometry {
    static func constrainedSize(
        _ requested: NSSize,
        in visibleFrame: NSRect,
        minimumSize: NSSize = NSSize(width: 220, height: 420)
    ) -> NSSize {
        NSSize(
            width: min(visibleFrame.width, max(minimumSize.width, requested.width)),
            height: min(visibleFrame.height, max(minimumSize.height, requested.height))
        )
    }

    static func constrainedFrame(
        _ requested: NSRect,
        in visibleFrames: [NSRect],
        fallback: NSRect,
        minimumSize: NSSize = NSSize(width: 220, height: 420)
    ) -> NSRect {
        let overlap: (NSRect) -> CGFloat = { frame in
            let intersection = frame.intersection(requested)
            return intersection.width * intersection.height
        }
        let screen = visibleFrames.max { overlap($0) < overlap($1) }
            .flatMap { overlap($0) > 0 ? $0 : nil } ?? fallback
        let size = constrainedSize(requested.size, in: screen, minimumSize: minimumSize)
        return NSRect(
            x: min(max(requested.minX, screen.minX), screen.maxX - size.width),
            y: min(max(requested.minY, screen.minY), screen.maxY - size.height),
            width: size.width,
            height: size.height
        )
    }

    static func frame(
        for preset: DetachedChatWindowPreset,
        visibleFrame: NSRect,
        normalSize: NSSize,
        minimumSize: NSSize
    ) -> NSRect {
        switch preset {
        case .normal:
            let size = constrainedSize(normalSize, in: visibleFrame, minimumSize: minimumSize)
            return centeredFrame(size: size, in: visibleFrame)
        case .narrowRight, .narrowLeft:
            let previousWidth = min(
                visibleFrame.width,
                max(minimumSize.width, visibleFrame.width / 8)
            )
            let width = min(visibleFrame.width, previousWidth * 2)
            let x = preset == .narrowRight ? visibleFrame.maxX - width : visibleFrame.minX
            return NSRect(x: x, y: visibleFrame.minY, width: width, height: visibleFrame.height)
        case .maximized:
            return visibleFrame
        }
    }

    private static func centeredFrame(size: NSSize, in visibleFrame: NSRect) -> NSRect {
        NSRect(
            x: visibleFrame.midX - size.width / 2,
            y: visibleFrame.midY - size.height / 2,
            width: size.width,
            height: size.height
        )
    }
}

enum DetachedChatWindowFrameStore {
    static func name(for sessionID: String) -> String {
        "detachedChatWindow.frame.v1.\(sessionID)"
    }
}

enum DetachedChatWindowSizeStore {
    private static let keyPrefix = "detachedChatWindow.size.v1."

    static func size(for sessionID: String, defaults: UserDefaults = .standard) -> NSSize? {
        guard let value = defaults.dictionary(forKey: keyPrefix + sessionID),
              let width = value["width"] as? Double,
              let height = value["height"] as? Double,
              width.isFinite, height.isFinite,
              width > 0, height > 0 else { return nil }
        return NSSize(width: width, height: height)
    }

    static func save(_ size: NSSize, for sessionID: String, defaults: UserDefaults = .standard) {
        guard size.width.isFinite, size.height.isFinite,
              size.width > 0, size.height > 0 else { return }
        defaults.set(
            ["width": Double(size.width), "height": Double(size.height)],
            forKey: keyPrefix + sessionID
        )
    }
}

private final class DetachedChatPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown && !isKeyWindow {
            NSApp.activate(ignoringOtherApps: true)
            makeKey()
        }
        super.sendEvent(event)
    }
}

private final class DetachedChatHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }
}

private struct DetachedChatWindowView: View {
    @ObservedObject private var backendClient = BackendClient.shared
    @ObservedObject private var archivedSessionState = BackendClient.shared.archivedSessionController
    @StateObject private var layoutState = PanelLayoutState()
    @State private var draftRepository = ComposerDraftRepository()
    @State private var showsWindowPresets = false

    let sessionID: String
    let close: () -> Void
    let returnToMain: () -> Void
    let applyWindowPreset: (DetachedChatWindowPreset) -> Void

    private var session: TaskSession? {
        backendClient.sessions.first(where: { $0.id == sessionID })
            ?? backendClient.archivedSessions.first(where: { $0.id == sessionID })
    }

    var body: some View {
        ZStack(alignment: .top) {
            if let session {
                DetailView(
                    sessionId: session.id,
                    presentationCache: .shared,
                    composerDraftRepository: draftRepository,
                    initialTimelinePosition: SessionViewportController.shared.position(for: session.id),
                    showsHeader: false,
                    allowsModelSwitch: false,
                    topChromeClearance: 62
                )
                .padding(10)
            } else {
                ContentUnavailableView(
                    L10n("Session unavailable"),
                    systemImage: "bubble.left.and.exclamationmark.bubble.right"
                )
            }

            HStack(alignment: .top, spacing: 8) {
                HStack(spacing: 0) {
                    PersistentRedWindowCloseButton(action: close)

                    DetachedWindowTrafficLightButton(
                        color: Color(red: 1, green: 0.741, blue: 0.180),
                        systemImage: "arrow.uturn.backward",
                        help: L10n("Return to main window"),
                        action: returnToMain
                    )

                    DetachedWindowTrafficLightButton(
                        color: Color(red: 0.188, green: 0.784, blue: 0.251),
                        systemImage: "rectangle.3.group",
                        help: L10n("Window size and position"),
                        action: { showsWindowPresets.toggle() }
                    )
                    .popover(isPresented: $showsWindowPresets, arrowEdge: .bottom) {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(DetachedChatWindowPreset.allCases, id: \.self) { preset in
                                Button {
                                    showsWindowPresets = false
                                    applyWindowPreset(preset)
                                } label: {
                                    Label(preset.title, systemImage: preset.systemImage)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 6)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(6)
                        .frame(minWidth: 180)
                    }
                }
                .padding(.top, 9)

                Spacer(minLength: 0)
                DetachedChatWindowTitle(session: session)
                    .frame(maxWidth: 360)
                Spacer(minLength: 0)
                Color.clear.frame(width: 76, height: 1)
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .frame(height: 62, alignment: .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(nsColor: .separatorColor).opacity(0.7), lineWidth: 1)
        }
        .environmentObject(backendClient)
        .environmentObject(layoutState)
        .environment(\.isLiquidGlass, false)
        .onAppear {
            layoutState.canRenderDetailMessages = true
        }
        .task(id: sessionID) {
            guard let session else { return }
            await backendClient.loadSessionMessages(session)
        }
    }
}

private struct DetachedChatWindowTitle: View {
    @ObservedObject private var entityClient = EntityAPIClient.shared
    let session: TaskSession?

    private var work: Work? {
        guard let session else { return nil }
        let workID = session.workId ?? session.taskId.flatMap { taskID in
            entityClient.tasks.first(where: { $0.id == taskID })?.workId
        }
        return entityClient.works.first(where: { $0.id == workID })
    }

    var body: some View {
        ZStack {
            DetachedChatWindowDragArea()
            VStack(spacing: 2) {
                Text(session?.title ?? L10n("Chat"))
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                if let work {
                    HStack(spacing: 5) {
                        ObjectiveAvatarView(objectiveID: work.id, name: work.name,
                                            avatarPath: work.avatarPath, size: 14)
                        Text(work.name)
                            .lineLimit(1)
                    }
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 7)
            .allowsHitTesting(false)
        }
        .fixedSize(horizontal: false, vertical: true)
        .platformGlassSurface(in: Capsule(), variant: .clear)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("detached-chat-title")
    }
}

private struct DetachedChatWindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> DragView {
        DragView()
    }

    func updateNSView(_ nsView: DragView, context: Context) {}

    final class DragView: NSView {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
            true
        }

        override func mouseDragged(with event: NSEvent) {
            window?.performDrag(with: event)
        }
    }
}

private struct PersistentRedWindowCloseButton: View {
    let action: () -> Void

    var body: some View {
        DetachedWindowTrafficLightButton(
            color: Color(red: 1, green: 0.373, blue: 0.341),
            systemImage: "xmark",
            help: L10n("Close"),
            action: action
        )
    }
}

private struct DetachedWindowTrafficLightButton: View {
    let color: Color
    let systemImage: String
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            DetachedWindowTrafficLightLabel(color: color, systemImage: systemImage)
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
    }
}

private struct DetachedWindowTrafficLightLabel: View {
    let color: Color
    let systemImage: String

    var body: some View {
        ZStack {
            Circle()
                .fill(color)
                .frame(width: 14, height: 14)

            Image(systemName: systemImage)
                .font(.system(size: 6, weight: .semibold))
                .foregroundStyle(.black.opacity(0.62))
        }
        // Keep a 20-point hit target: 14-point circles with a 6-point visual gap.
        .frame(width: 20, height: 22)
        .contentShape(Rectangle())
    }
}
