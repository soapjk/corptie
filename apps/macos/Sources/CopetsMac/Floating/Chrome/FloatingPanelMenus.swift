import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class NewSessionPanelController: NSObject, ObservableObject, NSWindowDelegate {
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
            modelCatalog: backendClient.modelCatalog,
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

struct FloatingActionMenu: View {
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

struct FloatingLayoutMenu: View {
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

struct ExternalActionPanelContent: View {
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

struct ExternalLayoutPanelContent: View {
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
final class ExternalMenuPanelController: ObservableObject {
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
