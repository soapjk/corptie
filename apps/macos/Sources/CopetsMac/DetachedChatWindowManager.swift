import AppKit
import SwiftUI

@MainActor
final class DetachedChatWindowManager {
    static let shared = DetachedChatWindowManager()

    private var controllers: [String: DetachedChatWindowController] = [:]

    func show(session: TaskSession) {
        if let controller = controllers[session.id] {
            controller.show()
            return
        }

        let controller = DetachedChatWindowController(
            sessionID: session.id,
            cascadeIndex: controllers.count,
            close: { [weak self] sessionID in
                self?.controllers[sessionID] = nil
            }
        )
        controllers[session.id] = controller
        controller.show()
    }

    func close(sessionID: String) {
        guard let controller = controllers.removeValue(forKey: sessionID) else { return }
        controller.close()
    }

    func closeAll() {
        let openControllers = Array(controllers.values)
        controllers.removeAll()
        openControllers.forEach { $0.close() }
    }
}

@MainActor
private final class DetachedChatWindowController: NSObject, NSWindowDelegate {
    private static let initialSize = NSSize(width: 560, height: 640)

    private let sessionID: String
    private let panel: NSPanel
    private let closeHandler: (String) -> Void

    init(sessionID: String, cascadeIndex: Int, close: @escaping (String) -> Void) {
        self.sessionID = sessionID
        self.closeHandler = close
        let visibleFrame = NSScreen.main?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1_440, height: 900)
        let offset = CGFloat(cascadeIndex % 8) * 24
        let origin = NSPoint(
            x: visibleFrame.midX - Self.initialSize.width / 2 + offset,
            y: visibleFrame.midY - Self.initialSize.height / 2 - offset
        )
        panel = NSPanel(
            contentRect: NSRect(origin: origin, size: Self.initialSize),
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
        panel.minSize = NSSize(width: 420, height: 420)
        panel.maxSize = NSSize(width: 900, height: 1_000)
        panel.contentView = NSHostingView(
            rootView: DetachedChatWindowView(
                sessionID: sessionID,
                close: { DetachedChatWindowManager.shared.close(sessionID: sessionID) }
            )
        )
    }

    func show() {
        panel.orderFrontRegardless()
    }

    func close() {
        panel.delegate = nil
        panel.close()
    }

    func windowWillClose(_ notification: Notification) {
        closeHandler(sessionID)
    }
}

private struct DetachedChatWindowView: View {
    @ObservedObject private var backendClient = BackendClient.shared
    @StateObject private var layoutState = PanelLayoutState()
    @State private var draftRepository = ComposerDraftRepository()

    let sessionID: String
    let close: () -> Void

    private var session: TaskSession? {
        backendClient.sessions.first(where: { $0.id == sessionID })
            ?? backendClient.archivedSessions.first(where: { $0.id == sessionID })
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 24, height: 24)
                        .background(Color.primary.opacity(0.07), in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .help(L10n("Close"))
                .accessibilityLabel(L10n("Close"))

                Text(session?.title ?? L10n("Chat"))
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: 38)
            .background(.regularMaterial)

            Divider()

            if let session {
                DetailView(
                    sessionId: session.id,
                    presentationCache: .shared,
                    composerDraftRepository: draftRepository,
                    initialTimelinePosition: SessionViewportController.shared.position(for: session.id),
                    showsHeader: false,
                    allowsModelSwitch: false
                )
                .padding(10)
            } else {
                ContentUnavailableView(
                    L10n("Session unavailable"),
                    systemImage: "bubble.left.and.exclamationmark.bubble.right"
                )
            }
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
