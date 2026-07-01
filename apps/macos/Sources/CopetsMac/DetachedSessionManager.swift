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
private final class DetachedSessionWindowController: NSObject, NSWindowDelegate {
    private let sessionId: String
    private let client: BackendClient
    private let openSession: (TaskSession) -> Void
    private let closeHandler: (String) -> Void
    private let panel: NSPanel
    private var cancellables = Set<AnyCancellable>()

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

        let size = NSSize(width: 72, height: 72)
        self.panel = NSPanel(
            contentRect: NSRect(x: 1220, y: 620, width: size.width, height: size.height),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
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
                open: { [weak self] session in
                    self?.openSession(session)
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
                self.updatePanelSize(for: session)
            }
            .store(in: &cancellables)
    }

    func show() {
        panel.orderFrontRegardless()
    }

    func close() {
        panel.close()
    }

    func windowWillClose(_ notification: Notification) {
        closeHandler(sessionId)
    }

    private func updatePanelSize(for session: TaskSession?) {
        let optionCount = min(session?.suggestedOptions?.count ?? 0, 5)
        let nextSize = optionCount > 0
            ? NSSize(width: 500, height: 84 + CGFloat(optionCount) * 34)
            : NSSize(width: 72, height: 72)
        guard abs(panel.frame.width - nextSize.width) > 1 || abs(panel.frame.height - nextSize.height) > 1 else {
            return
        }
        var frame = panel.frame
        let midX = frame.midX
        let maxY = frame.maxY
        frame.size = nextSize
        frame.origin.x = midX - nextSize.width / 2
        frame.origin.y = maxY - nextSize.height
        panel.setFrame(frame, display: true, animate: true)
    }
}

private struct DetachedSessionOrbView: View {
    @ObservedObject var client: BackendClient
    let sessionId: String
    let open: (TaskSession) -> Void
    let close: () -> Void

    var body: some View {
        Group {
            if let session {
                VStack(spacing: 8) {
                    ZStack {
                        StatusHalo(status: session.status)
                            .frame(width: 72, height: 72)

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
                    .contentShape(Circle())
                    .overlay(
                        DetachedOrbEventLayer(
                            open: {
                                open(session)
                            },
                            close: close
                        )
                    )

                    if !visibleOptions.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(visibleOptions) { option in
                                DetachedOptionButton(
                                    option: option,
                                    background: optionBackground,
                                    send: {
                                        client.sendMessage(option.label, to: session)
                                    }
                                )
                            }
                        }
                        .padding(.horizontal, 8)
                        .padding(.bottom, 8)
                    }
                }
                .frame(width: visibleOptions.isEmpty ? 72 : 246, height: visibleOptions.isEmpty ? 72 : nil, alignment: .top)
                .help(session.status.label)
            } else {
                EmptyView()
                    .onAppear {
                        close()
                    }
            }
        }
        .frame(width: sessionHasOptions ? 500 : 72, alignment: .leading)
        .background(Color.clear)
    }

    private var session: TaskSession? {
        client.sessions.first { $0.id == sessionId }
    }

    private var visibleOptions: [CodexApprovalOption] {
        Array((session?.suggestedOptions ?? []).prefix(5))
    }

    private var sessionHasOptions: Bool {
        !visibleOptions.isEmpty
    }

    private var optionBackground: Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedWhite: 0.12, alpha: 0.92)
                : NSColor(calibratedWhite: 1.0, alpha: 0.88)
        })
    }
}

private struct DetachedOptionButton: View {
    let option: CodexApprovalOption
    let background: Color
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
        .overlay(alignment: .trailing) {
            if isHovering {
                DetachedOptionTooltip(text: option.label)
                    .offset(x: 248, y: 0)
                    .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .leading)))
                    .zIndex(3)
            }
        }
        .onHover { hovering in
            isHovering = hovering
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
    let close: () -> Void

    func makeNSView(context: Context) -> EventView {
        let view = EventView()
        view.open = open
        view.close = close
        return view
    }

    func updateNSView(_ nsView: EventView, context: Context) {
        nsView.open = open
        nsView.close = close
    }

    final class EventView: NSView {
        var open: (() -> Void)?
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
            open?()
        }

        @objc private func closeOrb() {
            close?()
        }
    }
}

private struct StatusHalo: View {
    let status: TaskStatus
    @State private var isBreathing = false
    @State private var rotation = Angle.zero

    var body: some View {
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
                .opacity(status == .blocked && isBreathing ? 0.42 : 1.0)

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
                    .rotationEffect(rotation)
            }
        }
        .animation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true), value: isBreathing)
        .onAppear {
            isBreathing = true
            if status == .running {
                withAnimation(.linear(duration: 1.05).repeatForever(autoreverses: false)) {
                    rotation = .degrees(360)
                }
            }
        }
        .onChange(of: status) { _, nextStatus in
            rotation = .zero
            isBreathing = false
            DispatchQueue.main.async {
                isBreathing = true
                if nextStatus == .running {
                    withAnimation(.linear(duration: 1.05).repeatForever(autoreverses: false)) {
                        rotation = .degrees(360)
                    }
                }
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
            .green
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
            0.42
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
            0.20
        case .failed:
            0.28
        case .cancelled:
            0.14
        }
    }
}
